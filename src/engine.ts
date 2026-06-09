// src/engine.ts
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
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("activity timeout")), ms)),
  ])
}

export class Engine {
  private running = 0
  private queue: Marble[] = []

  constructor(private opts: EngineOpts) {}

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

  drain(): Promise<void> {
    return new Promise((resolve) => {
      const check = () =>
        this.running === 0 && this.queue.length === 0 ? resolve() : setTimeout(check, 5)
      check()
    })
  }

  private enqueue(m: Marble): void {
    this.queue.push(m)
    this.pump()
  }

  private pump(): void {
    const cap = this.opts.concurrency ?? 4
    while (this.running < cap && this.queue.length > 0) {
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
    this.opts.onChange?.(m)
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

  // Runs exactly one node-step, then re-enqueues if the marble advanced.
  private async step(m: Marble): Promise<void> {
    const node = this.node(m.node)
    m.status = "running"
    await this.persist(m)

    let result: NodeResult
    try {
      result = await this.execNode(node, m)
    } catch (err) {
      m.status = "failed"
      m.error = String(err)
      await this.persist(m)
      return
    }

    if (result.merge) m.context = { ...m.context, ...result.merge }

    if (result.end || node.type === "end") {
      m.context._outcome = result.endOutcome ?? "success"
      m.status = result.endOutcome === "fail" ? "failed" : "done"
      await this.persist(m)
      return
    }

    if (result.block) {
      m.status = "blocked"
      await this.persist(m)
      return
    }

    const edge = this.resolveEdge(node, result)
    if (!edge) {
      m.status = "failed"
      m.error = `no matching edge from ${node.id} (next=${result.next ?? "-"})`
      await this.persist(m)
      return
    }

    if (node.on_leave) await runShell(node.on_leave, m, node)
    if (edge.on_traversal) await runShell(edge.on_traversal, m, node)

    m.node = edge.to
    m.history.push(edge.to)

    if (m.history.length > (this.opts.maxSteps ?? 1000)) {
      m.status = "failed"
      m.error = "max steps exceeded (cycle guard)"
      await this.persist(m)
      return
    }

    await this.persist(m)
    this.enqueue(m)
  }
}
