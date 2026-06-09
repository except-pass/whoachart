import type { Chart, ChartEdge, ChartNode, Marble, NodeResult } from "./types"
import { getNodeType } from "./registry"
import { runShell } from "./context"
import { MarbleStore } from "./store"
import { genId, now } from "./util"

export interface EngineOpts {
  chart: Chart
  store: MarbleStore
  concurrency?: number
  maxSteps?: number
  onChange?: (m: Marble) => void
}

export function newMarble(
  chart: string,
  startNode: string,
  context: Record<string, unknown> = {},
  workpiece?: string,
): Marble {
  const t = now()
  return {
    id: genId(), chart, node: startNode, context, workpiece,
    history: [startNode], status: "queued", createdAt: t, updatedAt: t,
  }
}

async function withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
  if (!ms) return p
  let t: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<T>((_, rej) => {
    t = setTimeout(() => rej(new Error("activity timeout")), ms)
  })
  try {
    return await Promise.race([p, timer])
  } finally {
    if (t) clearTimeout(t)
  }
}

export class Engine {
  private running = 0
  private queue: Marble[] = []
  private inFlight = new Set<string>()
  private pendingSignals = new Map<string, NodeResult>()
  private readonly cap: number
  private readonly maxSteps: number

  constructor(private opts: EngineOpts) {
    this.cap = opts.concurrency ?? 4
    this.maxSteps = opts.maxSteps ?? 1000
  }

  private node(id: string): ChartNode {
    const n = this.opts.chart.nodes.find((n) => n.id === id)
    if (!n) throw new Error(`unknown node: ${id}`)
    return n
  }

  private outgoing(id: string): ChartEdge[] {
    return this.opts.chart.edges.filter((e) => e.from === id)
  }

  async submit(m: Marble): Promise<void> {
    await this.persist(m)
    this.enqueue(m)
  }

  async resume(): Promise<void> {
    const all = await this.opts.store.all()
    for (const m of all) {
      if (m.status === "running" || m.status === "queued") this.enqueue(m)
    }
  }

  // Resume a blocked marble with an externally supplied result (e.g. an agent
  // signaling done). The pending result substitutes for the node activity on
  // the next step, so routing/hooks/persistence all run the normal path.
  async signal(id: string, sig: { next?: string; merge?: Record<string, unknown> } = {}): Promise<void> {
    const m = await this.opts.store.load(id)
    if (!m) throw new Error(`unknown marble: ${id}`)
    if (m.status !== "blocked") throw new Error(`marble ${id} is not blocked (status: ${m.status})`)
    this.pendingSignals.set(id, { next: sig.next, merge: sig.merge })
    m.status = "queued"
    await this.persist(m)
    this.enqueue(m)
  }

  drain(): Promise<void> {
    return new Promise((resolve) => {
      const check = () =>
        this.running === 0 && this.queue.length === 0 ? resolve() : setTimeout(check, 5)
      check()
    })
  }

  // Enqueue a FRESH marble (submit/resume). Skips if one with the same id is
  // already queued or running, so submit+resume (or double resume) can't
  // double-process the same marble.
  private enqueue(m: Marble): void {
    if (this.inFlight.has(m.id)) return
    this.inFlight.add(m.id)
    this.queue.push(m)
    this.pump()
  }

  private pump(): void {
    while (this.running < this.cap && this.queue.length > 0) {
      const m = this.queue.shift()!
      this.running++
      this.step(m).finally(() => {
        this.running--
        this.pump()
      })
    }
  }

  private async persist(m: Marble): Promise<void> {
    m.updatedAt = now()
    await this.opts.store.save(m)
    // Hand consumers a snapshot, not the live object the engine keeps mutating.
    this.opts.onChange?.(structuredClone(m))
  }

  private async execNode(node: ChartNode, m: Marble): Promise<NodeResult> {
    const nt = getNodeType(node.type)
    const max = node.retry?.max ?? 0
    let lastErr: unknown
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const res = await withTimeout(
          nt.run({ chart: this.opts.chart, marble: m, node, outgoing: this.outgoing(node.id) }),
          node.timeout,
        )
        if (res.failed && attempt < max) continue
        return res
      } catch (err) {
        lastErr = err
        if (attempt === max) throw err
      }
    }
    throw lastErr
  }

  private resolveEdge(node: ChartNode, result: NodeResult): ChartEdge | undefined {
    const out = this.outgoing(node.id)
    if (result.next) {
      return out.find((e) => e.name === result.next) ?? out.find((e) => e.to === result.next)
    }
    if (result.failed) {
      return out.find((e) => e.name === "fail") ?? out.find((e) => e.default)
    }
    if (out.length === 1) return out[0]
    return out.find((e) => e.default)
  }

  // Run a side-effect hook; log (but do not fail the marble on) a non-zero exit.
  private async runHook(script: string, m: Marble, node: ChartNode): Promise<void> {
    const out = await runShell(script, m, node)
    if (out.exitCode !== 0) {
      console.error(
        `[whoachart] hook on node ${node.id} (marble ${m.id}) exited ${out.exitCode}: ${out.stderr.trim()}`,
      )
    }
  }

  // Runs exactly one node-step, then re-enqueues if the marble advanced.
  // The ENTIRE body is guarded: any throw marks the marble failed and persists,
  // instead of stranding it in "running" and emitting an unhandled rejection.
  private async step(m: Marble): Promise<void> {
    try {
      const node = this.node(m.node)
      m.status = "running"
      await this.persist(m)

      const pending = this.pendingSignals.get(m.id)
      let result: NodeResult
      if (pending) {
        this.pendingSignals.delete(m.id)
        result = pending
      } else {
        result = await this.execNode(node, m)
      }

      if (result.merge) m.context = { ...m.context, ...result.merge }

      if (result.end || node.type === "end") {
        m.context._outcome = result.endOutcome ?? "success" // _outcome is reserved
        m.status = result.endOutcome === "fail" ? "failed" : "done"
        await this.persist(m)
        this.inFlight.delete(m.id)
        return
      }

      if (result.block) {
        m.status = "blocked"
        await this.persist(m)
        this.inFlight.delete(m.id)
        return
      }

      const edge = this.resolveEdge(node, result)
      if (!edge) {
        m.status = "failed"
        m.error = `no matching edge from ${node.id} (next=${result.next ?? "-"})`
        await this.persist(m)
        this.inFlight.delete(m.id)
        return
      }

      if (node.on_leave) await this.runHook(node.on_leave, m, node)
      if (edge.on_traversal) await this.runHook(edge.on_traversal, m, node)

      m.node = edge.to
      m.history.push(edge.to)

      if (m.history.length > this.maxSteps) {
        m.status = "failed"
        m.error = "max steps exceeded (cycle guard)"
        await this.persist(m)
        this.inFlight.delete(m.id)
        return
      }

      await this.persist(m)
      // Continuation: marble stays in-flight; queue its next step directly.
      this.queue.push(m)
      this.pump()
    } catch (err) {
      m.status = "failed"
      m.error = err instanceof Error ? (err.stack ?? err.message) : String(err)
      try {
        await this.persist(m)
      } catch (persistErr) {
        console.error(`[whoachart] failed to persist failed marble ${m.id}: ${persistErr}`)
      }
      this.inFlight.delete(m.id)
    }
  }
}
