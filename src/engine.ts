import type { ActivityStream, Chart, ChartEdge, ChartNode, HookEvent, Marble, NodeResult, RunCtx } from "./types"
import { getNodeType, type NodeType } from "./registry"
import { runShell, runHookCommand, DEFAULT_HOOK_TIMEOUT_MS } from "./context"
import { MarbleStore } from "./store"
import { genId, now } from "./util"

// Structured lifecycle events — the observability seam. The daemon logs these;
// a future SSE feed can forward them verbatim.
export type EngineEvent =
  | { type: "enter"; marble: string; node: string }
  | { type: "blocked"; marble: string; node: string }
  | { type: "signaled"; marble: string; node: string; next?: string }
  | { type: "traverse"; marble: string; from: string; to: string; edge?: string }
  | { type: "end"; marble: string; node: string; outcome: string }
  | { type: "failed"; marble: string; node: string; error: string }
  | { type: "retried"; marble: string; node: string }

export interface EngineOpts {
  chart: Chart
  store: MarbleStore
  concurrency?: number
  maxSteps?: number
  onChange?: (m: Marble) => void
  onEvent?: (e: EngineEvent) => void
  // Live per-(marble,node) output sink: shell stdout/stderr lines, streamed as
  // the activity runs. Lifecycle events stay on onEvent; the daemon merges both
  // into the inspector's log feed.
  onLog?: (e: { marble: string; node: string; stream: ActivityStream; line: string }) => void
  // Instance-scoped node-type overrides, resolved before the global registry.
  // The daemon passes its wired `agent` node here so per-daemon launcher/baseUrl
  // wiring never leaks through the module-global registry to another daemon.
  nodeTypes?: Map<string, NodeType>
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
    history: [startNode], trail: [{ node: startNode, enteredAt: t }],
    status: "queued", createdAt: t, updatedAt: t,
  }
}

// Run an activity with a deadline. On timeout we both reject AND abort the
// signal, so the activity can kill its underlying process / fetch rather than
// leaving it running while the engine routes the marble down the fail path.
async function withTimeout<T>(run: (signal?: AbortSignal) => Promise<T>, ms?: number): Promise<T> {
  if (!ms) return run()
  const ctrl = new AbortController()
  let t: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<T>((_, rej) => {
    t = setTimeout(() => {
      ctrl.abort()
      rej(new Error("activity timeout"))
    }, ms)
  })
  try {
    return await Promise.race([run(ctrl.signal), timer])
  } finally {
    if (t) clearTimeout(t)
  }
}

export class Engine {
  private running = 0
  private queue: Marble[] = []
  private inFlight = new Set<string>()
  private pendingSignals = new Map<string, NodeResult>()
  // In-flight chart-level hook runs. Hooks are fire-and-forget (never block a
  // marble step), but tracked so drain() can settle them for tests/shutdown.
  private outstandingHooks = new Set<Promise<void>>()
  // Set by stop() to quiesce the engine for a hot-reload: pump() stops launching
  // new steps so currently-running steps can settle before the chart is swapped.
  // resume() clears it again (a stopped engine that is re-resumed comes back).
  private stopped = false
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

  // Like node(), but never throws — used on failure paths (cycle guard, the step
  // catch) where the marble may sit at an unknown id and we still want to fire the
  // `failed` hook rather than swallow it.
  private nodeOrStub(id: string): ChartNode {
    return this.opts.chart.nodes.find((n) => n.id === id) ?? ({ id, type: "unknown", config: {} } as ChartNode)
  }

  private nodeType(type: string): NodeType {
    return this.opts.nodeTypes?.get(type) ?? getNodeType(type)
  }

  private outgoing(id: string): ChartEdge[] {
    return this.opts.chart.edges.filter((e) => e.from === id)
  }

  async submit(m: Marble): Promise<void> {
    await this.persist(m)
    this.enqueue(m)
  }

  async resume(): Promise<void> {
    this.stopped = false
    const all = await this.opts.store.all()
    for (const m of all) {
      if (m.status === "running" || m.status === "queued") this.enqueue(m)
    }
  }

  // Quiesce for a hot-reload: stop launching new steps and resolve once every
  // in-flight step has settled (running === 0). Marbles are persisted at each
  // step, so whatever was queued/running is re-hydrated by the replacement
  // engine's resume() — disk is authoritative, nothing is lost. Idempotent.
  //
  // REJECTS if a step won't settle within timeoutMs (e.g. a node activity with
  // no `timeout` configured that hangs). Bounding this is load-bearing: stop()
  // runs inside the daemon's serialized mutation lock, so an unbounded wait would
  // wedge ALL future chart mutations behind one hung chart. The caller revives
  // the engine (resume) and surfaces the failure rather than blocking forever.
  stop(timeoutMs = 30_000): Promise<void> {
    this.stopped = true
    return new Promise((resolve, reject) => {
      let settled = false
      const deadline = setTimeout(() => {
        settled = true
        reject(new Error(`engine quiesce timed out after ${timeoutMs}ms (a node step is still running)`))
      }, timeoutMs)
      ;(deadline as unknown as { unref?: () => void }).unref?.()
      const check = () => {
        if (settled) return
        if (this.running === 0) {
          settled = true
          clearTimeout(deadline)
          resolve()
        } else {
          const t = setTimeout(check, 5)
          ;(t as unknown as { unref?: () => void }).unref?.() // don't hold the event loop open
        }
      }
      check()
    })
  }

  // Resume a blocked marble with an externally supplied result (e.g. an agent
  // signaling done). The pending result substitutes for the node activity on
  // the next step, so routing/hooks/persistence all run the normal path.
  async signal(id: string, sig: { next?: string; merge?: Record<string, unknown> } = {}): Promise<void> {
    const m = await this.opts.store.load(id)
    if (!m) throw new Error(`unknown marble: ${id}`)
    if (m.status !== "blocked") throw new Error(`marble ${id} is not blocked (status: ${m.status})`)
    // Reject a signal that wouldn't route BEFORE unblocking. Otherwise the marble
    // advances, fails resolveEdge in step(), and is permanently failed (its agent
    // session torn down) by a single typo'd `next`. Leaving it blocked lets the
    // caller retry with a corrected edge.
    const node = this.node(m.node)
    if (!this.resolveEdge(node, { next: sig.next, merge: sig.merge })) {
      const opts = this.outgoing(node.id).map((e) => e.name ?? e.to).join(", ") || "(none)"
      throw new Error(`signal next=${sig.next ?? "-"} matches no outgoing edge of ${node.id} (options: ${opts})`)
    }
    this.pendingSignals.set(id, { next: sig.next, merge: sig.merge })
    this.emit({ type: "signaled", marble: m.id, node: m.node, next: sig.next })
    m.status = "queued"
    await this.persist(m)
    this.enqueue(m)
  }

  // Re-run a failed marble from the node it failed at.
  async retry(id: string): Promise<void> {
    const m = await this.opts.store.load(id)
    if (!m) throw new Error(`unknown marble: ${id}`)
    if (m.status !== "failed") throw new Error(`marble ${id} is not failed (status: ${m.status})`)
    m.status = "queued"
    m.error = undefined
    this.emit({ type: "retried", marble: m.id, node: m.node })
    await this.persist(m)
    this.enqueue(m)
  }

  private emit(e: EngineEvent): void {
    this.opts.onEvent?.(e)
  }

  drain(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.running === 0 && this.queue.length === 0) {
          // All marble work has settled; no further steps can fire a new hook, so
          // the outstanding set only shrinks from here. Await the snapshot.
          void Promise.allSettled([...this.outstandingHooks]).then(() => resolve())
        } else {
          setTimeout(check, 5)
        }
      }
      check()
    })
  }

  // Dispatch chart-level lifecycle hooks matching `event` (scoped by node/edge).
  // OBSERVATIONAL ONLY: the returned promises are tracked but never awaited in the
  // marble's critical path, and a hook's exit code/output never changes routing.
  // The marble is SNAPSHOT at fire time — dispatch is async, so the live marble
  // may advance (status/context/node) before the hook serializes it.
  private fireHooks(
    event: HookEvent,
    m: Marble,
    node: ChartNode,
    extra?: { edge?: { name?: string; from: string; to: string }; outcome?: string },
  ): void {
    const hooks = this.opts.chart.hooks
    if (!hooks?.length) return
    const matching = hooks.filter(
      (h) =>
        h.on === event &&
        (h.node === undefined || h.node === node.id) &&
        (h.edge === undefined || h.edge === extra?.edge?.name),
    )
    if (!matching.length) return

    // Dispatch must never throw back into step(): one call site is step()'s own
    // catch block, and structuredClone() rejects a non-cloneable marble.context
    // (a node could merge a function/symbol via result.merge). A throw here would
    // strand the marble (unpersisted, stuck in inFlight) for a purely observational
    // side-effect. Swallow + log instead — hooks never affect the marble.
    let snap: Marble
    try {
      snap = structuredClone(m)
    } catch (err) {
      console.error(`[whoachart] hook on:${event} (chart ${this.opts.chart.name}, marble ${m.id}) skipped — context not cloneable: ${err}`)
      return
    }
    const onLine = this.logFor(m, node)
    const chart = this.opts.chart.name
    for (const h of matching) {
      const run = runHookCommand({
        script: h.run,
        event,
        chart,
        marble: snap,
        node,
        edge: extra?.edge,
        outcome: extra?.outcome,
        timeoutMs: h.timeout ?? DEFAULT_HOOK_TIMEOUT_MS,
        onLine,
      })
        .then((out) => {
          if (out.exitCode !== 0) {
            console.error(
              `[whoachart] hook on:${event} (chart ${chart}, node ${node.id}, marble ${m.id}) ` +
                `${out.timedOut ? "timed out" : `exited ${out.exitCode}`}`,
            )
          }
        })
        .catch((err) => {
          console.error(`[whoachart] hook on:${event} (chart ${chart}, node ${node.id}, marble ${m.id}) threw: ${err}`)
        })
      this.outstandingHooks.add(run)
      void run.finally(() => this.outstandingHooks.delete(run))
    }
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
    if (this.stopped) return // quiesced for hot-reload; leave queued work on disk
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

  // Tag a live-output line with this marble+node before forwarding to onLog.
  private logFor(m: Marble, node: ChartNode): RunCtx["log"] {
    const onLog = this.opts.onLog
    if (!onLog) return undefined
    return (stream, line) => onLog({ marble: m.id, node: node.id, stream, line })
  }

  private async execNode(node: ChartNode, m: Marble): Promise<NodeResult> {
    const nt = this.nodeType(node.type)
    const max = node.retry?.max ?? 0
    const log = this.logFor(m, node)
    let lastErr: unknown
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const res = await withTimeout(
          (signal) => nt.run({ chart: this.opts.chart, marble: m, node, outgoing: this.outgoing(node.id), signal, log }),
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
  // Hook stdout/stderr streams into the same per-node feed as the main activity.
  private async runHook(script: string, m: Marble, node: ChartNode): Promise<void> {
    const out = await runShell(script, m, node, undefined, this.logFor(m, node))
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
      this.emit({ type: "enter", marble: m.id, node: node.id })
      await this.persist(m)
      this.fireHooks("enter", m, node)
      // `start` is the marble's very first entry, fired exactly once. Gated on a
      // persisted flag (set + persisted below) rather than history.length===1,
      // which is NOT once-only: history is pushed only on a successful traverse, so
      // a marble that blocks/fails at its first node and re-enters (signal/retry)
      // still has length 1 and would otherwise re-fire `start`.
      if (!m.started) {
        m.started = true
        this.fireHooks("start", m, node)
      }

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
        const outcome = result.endOutcome ?? "success"
        this.emit({ type: "end", marble: m.id, node: node.id, outcome })
        await this.persist(m)
        this.fireHooks("end", m, node, { outcome })
        this.inFlight.delete(m.id)
        return
      }

      if (result.block) {
        m.status = "blocked"
        this.emit({ type: "blocked", marble: m.id, node: node.id })
        await this.persist(m)
        this.fireHooks("blocked", m, node)
        this.inFlight.delete(m.id)
        return
      }

      const edge = this.resolveEdge(node, result)
      if (!edge) {
        m.status = "failed"
        m.error = `no matching edge from ${node.id} (next=${result.next ?? "-"})`
        this.emit({ type: "failed", marble: m.id, node: node.id, error: m.error })
        await this.persist(m)
        this.fireHooks("failed", m, node)
        this.inFlight.delete(m.id)
        return
      }

      if (node.on_leave) await this.runHook(node.on_leave, m, node)
      this.fireHooks("leave", m, node)
      if (edge.on_traversal) await this.runHook(edge.on_traversal, m, node)
      // Fires BEFORE m.node advances (below), so the hook's marble snapshot sits at
      // the source node — same timing as on_traversal — while `edge.to` carries the
      // destination. Don't "fix" this to match the emit-after ordering of other
      // events: that would put the snapshot at the wrong node. (emit traverse fires
      // after the move, for the event stream; the hook intentionally precedes it.)
      this.fireHooks("traverse", m, node, { edge: { name: edge.name, from: node.id, to: edge.to } })

      const leftAt = now()
      const trail = (m.trail ??= [])
      const lastHop = trail[trail.length - 1]
      if (lastHop && lastHop.node === node.id && !lastHop.leftAt) {
        lastHop.leftAt = leftAt
        // snapshot the state as it leaves this node — inspector time-travel
        lastHop.context = structuredClone(m.context)
      }
      m.node = edge.to
      m.history.push(edge.to)
      trail.push({ node: edge.to, enteredAt: leftAt })
      this.emit({ type: "traverse", marble: m.id, from: node.id, to: edge.to, edge: edge.name })

      if (m.history.length > this.maxSteps) {
        m.status = "failed"
        m.error = "max steps exceeded (cycle guard)"
        this.emit({ type: "failed", marble: m.id, node: m.node, error: m.error })
        await this.persist(m)
        this.fireHooks("failed", m, this.nodeOrStub(m.node))
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
      this.emit({ type: "failed", marble: m.id, node: m.node, error: m.error })
      this.fireHooks("failed", m, this.nodeOrStub(m.node))
      try {
        await this.persist(m)
      } catch (persistErr) {
        console.error(`[whoachart] failed to persist failed marble ${m.id}: ${persistErr}`)
      }
      this.inFlight.delete(m.id)
    }
  }
}
