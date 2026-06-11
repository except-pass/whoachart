import { readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { parseChart } from "./schema"
import { ChartStore, ChartError, assertSafeChartName, atomicWrite } from "./chartStore"
import { lintChart, type LintWarning } from "./lint"
import { registerBuiltins } from "./nodeTypes"
import { agentSchemaNode, makeAgentNode } from "./nodeTypes/agent"
import { hasNodeType, registerNodeType, type NodeType } from "./registry"
import { MarbleStore } from "./store"
import { Engine, newMarble, type EngineEvent } from "./engine"
import { ViewState, type ViewSnapshot } from "./view/viewState"
import { LogBuffer, type LogDelta } from "./view/logBuffer"
import { layoutChart, type Layout, type NodeBox } from "./view/layout"
import { now } from "./util"
import { validateForm } from "./forms"
import type { CanvasControl, SessionLauncher, SpawnSessionOpts } from "./tinstar"
import type { Chart, ChartNode, FormField, Marble, PresentSpec } from "./types"

// One timestamped line per lifecycle event — the operator audit trail.
function logLine(chart: string, msg: string): void {
  console.log(`[whoachart] ${new Date().toISOString()} ${chart} ${msg}`)
}

function fmtEvent(e: EngineEvent): string {
  switch (e.type) {
    case "enter": return `enter marble=${e.marble} node=${e.node}`
    case "blocked": return `blocked marble=${e.marble} node=${e.node} (awaiting signal)`
    case "signaled": return `resumed marble=${e.marble} node=${e.node} next=${e.next ?? "-"}`
    case "traverse": return `traverse marble=${e.marble} ${e.from}->${e.to}${e.edge ? ` edge=${e.edge}` : ""}`
    case "end": return `end marble=${e.marble} node=${e.node} outcome=${e.outcome}`
    case "failed": return `FAILED marble=${e.marble} node=${e.node} error=${e.error.split("\n")[0]}`
    case "retried": return `retried marble=${e.marble} node=${e.node}`
  }
}

// Which node a lifecycle event belongs to in the per-node log feed. `traverse`
// carries from/to instead of a single node — attribute it to the node being left.
function eventNode(e: EngineEvent): string {
  return e.type === "traverse" ? e.from : e.node
}

function loggingLauncher(inner: SessionLauncher): SessionLauncher {
  return {
    async spawnSession(opts: SpawnSessionOpts) {
      const ref = await inner.spawnSession(opts)
      logLine("-", `session spawned name=${ref.name}`)
      return ref
    },
    async stopSession(name: string) {
      logLine("-", `session stopping name=${name}`)
      await inner.stopSession(name)
    },
  }
}

export interface DaemonOpts {
  // Explicit chart files/dirs to boot-load (existing behavior). May be empty when
  // the writable store dir is the sole source.
  charts?: string[]
  // Server-owned writable directory of chart *.yaml — the CRUD store. When set,
  // its charts are boot-loaded too and register/update/delete operate on it.
  chartsDir?: string
  storeDir: string
  // Tinstar canvas controls (widget ensure + pan). FakeCanvas in tests.
  client: CanvasControl
  concurrency?: number
  // This daemon's own local base (agent signal URLs).
  baseUrl?: string
  // The URL browsers use to reach this daemon (tailnet hostname in prod).
  publicUrl?: string
  launcher?: SessionLauncher
}

interface ChartRuntime {
  chart: Chart
  engine: Engine
  store: MarbleStore
  view: ViewState
  logs: LogBuffer
  layout: Layout
  start: string
  // The chart definition file this runtime was loaded from. Update writes back
  // here (so boot-loaded charts stay authoritative); delete unlinks it.
  file: string
}

// Marble statuses that block a destructive reload/delete: still in the system,
// pointing at a node id that the new chart must keep (reload) or that we'd strand
// (delete). Terminal marbles (done/failed) are inert and never block.
function isLive(m: Marble): boolean {
  return m.status === "queued" || m.status === "running" || m.status === "blocked"
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface SubmitOpts {
  context?: Record<string, unknown>
  workpiece?: string
  start?: string
}

export interface ChartDef {
  name: string
  start: string
  nodes: {
    id: string
    type: string
    name?: string
    color?: string
    present?: PresentSpec[]
    stuck_after?: number
    timeout?: number
    retry?: { max: number }
    // The node's run code + lifecycle hooks, surfaced for the node inspector.
    // on_leave is the universal post-node shell hook; the type-specific code
    // (shell/decision on_enter, agent brief, api request) lives in `config`.
    on_leave?: string
    config: Record<string, unknown>
    form?: FormField[]
  }[]
  edges: { from: string; to: string; name?: string; default?: boolean; form?: FormField[] }[]
  layout: { boxes: Record<string, NodeBox>; width: number; height: number }
  // Advisory static-analysis findings for the live chart, computed at request
  // time so a hot-reload (3a) re-lints. Separate top-level key — NOT folded into
  // nodes/edges — so the canvas (2b) and other /def consumers are undisturbed.
  lint: LintWarning[]
}

// Key names whose VALUES are masked before a node's config is shipped to the
// (tailnet-reachable) inspector. Keys stay visible — the inspector's job is to
// show what a node does — but credentials don't leave the daemon. Anything under
// a `headers` block is masked wholesale, since auth usually rides there.
const SECRET_KEY = /^(authorization|bearer|token|api[-_]?key|secret|password)$/i

function redactSecrets(value: unknown, underHeaders = false): unknown {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, underHeaders))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = underHeaders || SECRET_KEY.test(k) ? "***redacted***" : redactSecrets(v, k.toLowerCase() === "headers")
    }
    return out
  }
  return value
}

function findStart(chart: Chart): string {
  const source = chart.nodes.find((n) => n.type === "source")
  if (source) return source.id
  const hasIncoming = new Set(chart.edges.map((e) => e.to))
  const root = chart.nodes.find((n) => !hasIncoming.has(n.id))
  return (root ?? chart.nodes[0]).id
}

export class Daemon {
  private runtimes = new Map<string, ChartRuntime>()
  private launcher?: SessionLauncher
  // Wired once in start() and reused by every (re)built runtime so this daemon's
  // launcher/baseUrl never leak through the module-global registry.
  private nodeTypes!: Map<string, NodeType>
  private baseUrl!: string
  private chartStore?: ChartStore
  // Serializes all chart-store mutations so two concurrent PUT/POST/DELETEs can't
  // interleave engine swaps. A rejected mutation must not wedge the chain.
  // TODO(perf): this is a single GLOBAL lock — a hung reload on one chart head-of-
  // line-blocks mutations on ALL charts for up to the stop() timeout. Bounded, so
  // not urgent; the fix is a per-chart lock (keyed map of promise chains).
  private mutex: Promise<unknown> = Promise.resolve()

  constructor(private opts: DaemonOpts) {}

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn)
    this.mutex = run.then(() => undefined, () => undefined)
    return run
  }

  private get publicUrl(): string {
    return this.opts.publicUrl ?? this.opts.baseUrl ?? "http://localhost:5330"
  }

  async start(): Promise<void> {
    if (!hasNodeType("end")) registerBuiltins()
    this.baseUrl = this.opts.baseUrl ?? "http://localhost:5330"
    this.launcher = this.opts.launcher ? loggingLauncher(this.opts.launcher) : undefined
    // Global registration is schema-only (for chart parsing/config validation);
    // the wired agent node is instance-scoped so this daemon's launcher/baseUrl
    // never leak to another Daemon in the same process via the module-global map.
    if (!hasNodeType("agent")) registerNodeType(agentSchemaNode)
    const launcher: SessionLauncher = this.launcher ?? {
      spawnSession: async () => { throw new Error("no session launcher configured (agent nodes need one)") },
      stopSession: async () => {},
    }
    this.nodeTypes = new Map<string, NodeType>([
      ["agent", makeAgentNode(launcher, (m) => `${this.baseUrl}/api/charts/${m.chart}/marbles/${m.id}/signal`)],
    ])
    if (this.opts.chartsDir) this.chartStore = new ChartStore(this.opts.chartsDir)

    // Explicit boot-load list (existing behavior).
    for (const path of this.opts.charts ?? []) {
      const chart = parseChart(await readFile(path, "utf8"))
      await this.installRuntime(chart, path)
    }
    // Store-dir charts (CRUD-managed). Skip names already loaded above so a dir
    // that overlaps the explicit list (the common default) isn't double-loaded.
    if (this.chartStore) {
      for (const name of await this.chartStore.listNames()) {
        if (this.runtimes.has(name)) continue
        const file = await this.chartStore.resolvePath(name) // honor a legacy .yml
        const chart = parseChart(await readFile(file, "utf8"))
        await this.installRuntime(chart, file)
      }
    }
  }

  // Build a chart's full runtime (marble store + engine + live view + log buffer
  // + layout) and resume its persisted marbles. Reused by boot, register, and
  // hot-reload — disk is authoritative, so resume() rehydrates in-flight marbles.
  private async buildRuntime(chart: Chart, file: string): Promise<ChartRuntime> {
    const store = new MarbleStore(join(this.opts.storeDir, chart.name))
    await store.init()
    const view = new ViewState(chart)
    const logs = new LogBuffer()
    const engine = new Engine({
      chart,
      store,
      concurrency: this.opts.concurrency,
      nodeTypes: this.nodeTypes,
      onChange: (m) => view.apply(m),
      onEvent: (e) => {
        logLine(chart.name, fmtEvent(e))
        // Lifecycle events join the per-node feed so even no-stdout nodes
        // (human/agent/end) show a meaningful timeline in the inspector.
        logs.append({ marble: e.marble, node: eventNode(e), stream: "event", line: fmtEvent(e), ts: now() })
      },
      onLog: (x) => logs.append({ ...x, ts: now() }),
    })
    view.seed(await store.all())
    await engine.resume()
    return { chart, engine, store, view, logs, layout: layoutChart(chart), start: findStart(chart), file }
  }

  private async installRuntime(chart: Chart, file: string): Promise<ChartRuntime> {
    const rt = await this.buildRuntime(chart, file)
    this.runtimes.set(chart.name, rt)
    this.ensureWidgetLoop(chart)
    return rt
  }

  // Keep one Tinstar browser-widget per chart pointing at our UI. Tolerates
  // Tinstar being down: logs and retries on a timer, never crashes the daemon.
  private ensureWidgetLoop(chart: Chart, retryMs = 15_000): void {
    const url = `${this.publicUrl}/ui/charts/${chart.name}`
    const attempt = (): void => {
      // Bail if the chart was deleted (or replaced) while a retry was pending —
      // otherwise a deleted chart whose widget never landed retries forever,
      // logging under the dead name. The runtime map is the liveness source.
      if (!this.runtimes.has(chart.name)) return
      this.opts.client.ensureBrowserWidget({ url, title: `whoachart-${chart.name}` }).then(
        () => logLine(chart.name, `widget ensured url=${url}`),
        (err) => {
          logLine(chart.name, `widget ensure failed (${String(err).split("\n")[0]}); retrying in ${retryMs / 1000}s`)
          const t = setTimeout(attempt, retryMs)
          ;(t as unknown as { unref?: () => void }).unref?.()
        },
      )
    }
    attempt()
  }

  charts(): string[] {
    return [...this.runtimes.keys()]
  }

  // Register a brand-new chart from YAML and bring it live (hot, no restart).
  // Rejects 409 if the name already exists. Serialized via mutate().
  async registerChart(yamlText: string): Promise<{ name: string; warnings: LintWarning[] }> {
    if (!this.chartStore) throw new ChartError("chart store not configured (set WHOACHART_CHARTS_DIR)", 501)
    return this.mutate(async () => {
      const chart = parseChart(yamlText) // schema/config errors → 400 (controlApi)
      assertSafeChartName(chart.name) // path-traversal guard before any fs op
      if (this.runtimes.has(chart.name) || (await this.chartStore!.exists(chart.name))) {
        throw new ChartError(`chart already exists: ${chart.name}`, 409)
      }
      const lint = lintChart(chart) // advisory static analysis (3b); never blocks register
      await this.chartStore!.write(chart.name, yamlText)
      await this.installRuntime(chart, this.chartStore!.path(chart.name))
      logLine(chart.name, "registered")
      return { name: chart.name, warnings: lint.warnings }
    })
  }

  // Replace a chart's definition and hot-reload it WITHOUT losing in-flight
  // marbles. The new chart must keep every node id a live marble currently sits
  // on, else we refuse (409) listing the blockers — unless forceFail, which
  // fails those orphaned marbles in place and reloads anyway. Never migrates a
  // marble to a different node (that would silently corrupt its state).
  async updateChart(
    name: string,
    yamlText: string,
    opts: { forceFail?: boolean } = {},
  ): Promise<{ name: string; warnings: LintWarning[] }> {
    return this.mutate(async () => {
      const existing = this.runtimes.get(name)
      if (!existing) throw new ChartError(`unknown chart: ${name}`, 404)
      const chart = parseChart(yamlText)
      if (chart.name !== name) {
        throw new ChartError(`chart name ${JSON.stringify(chart.name)} does not match URL ${JSON.stringify(name)}`, 400)
      }
      const lint = lintChart(chart)

      // Quiesce first: no step runs against the old chart while we swap, and the
      // live-marble set below is a stable snapshot rather than a moving target.
      // If a step won't settle, revive the chart and abort the reload (503)
      // rather than wedging the chart — and the mutation lock — on a hung node.
      try {
        await existing.engine.stop()
      } catch (err) {
        await existing.engine.resume()
        throw new ChartError(`chart "${name}" did not quiesce for reload: ${errMsg(err)}`, 503)
      }
      const live = (await existing.store.all()).filter(isLive)
      const newIds = new Set(chart.nodes.map((n) => n.id))
      const conflicts = live.filter((m) => !newIds.has(m.node))
      if (conflicts.length) {
        if (!opts.forceFail) {
          await existing.engine.resume() // refuse: revive the unchanged chart, lose nothing
          throw new ChartError("reload would orphan live marbles on dropped nodes", 409, {
            conflict: "live_marbles",
            marbles: conflicts.map((m) => ({ id: m.id, node: m.node, status: m.status })),
          })
        }
        for (const m of conflicts) {
          m.status = "failed"
          m.error = `chart reloaded; node "${m.node}" no longer exists`
          m.updatedAt = now()
          await existing.store.save(m)
          logLine(name, `force-failed marble=${m.id} (node ${m.node} dropped by reload)`)
        }
      }

      // Write back to the chart's own file (authoritative across restarts even
      // for boot-loaded charts outside the store dir), then swap the runtime.
      // The old engine is stopped at this point — if the write or rebuild throws,
      // revive it and abort (503) so the chart keeps serving rather than silently
      // wedging on a stopped engine until the next daemon restart.
      try {
        await atomicWrite(existing.file, yamlText)
        const rt = await this.buildRuntime(chart, existing.file)
        this.runtimes.set(name, rt)
      } catch (err) {
        await existing.engine.resume()
        throw new ChartError(`chart "${name}" reload failed during rebuild: ${errMsg(err)}`, 503)
      }
      logLine(
        name,
        `reloaded (preserved=${live.length - conflicts.length}${conflicts.length ? ` force-failed=${conflicts.length}` : ""})`,
      )
      return { name, warnings: lint.warnings }
    })
  }

  // Remove a chart and stop its engine. Refuses (409) when live marbles exist
  // unless force=true. By default the marble run-state files are KEPT for audit;
  // purge=true also wipes them.
  async deleteChart(name: string, opts: { force?: boolean; purge?: boolean } = {}): Promise<{ name: string; purged: boolean }> {
    return this.mutate(async () => {
      const rt = this.runtimes.get(name)
      if (!rt) throw new ChartError(`unknown chart: ${name}`, 404)
      if (!opts.force) {
        const live = (await rt.store.all()).filter(isLive)
        if (live.length) {
          throw new ChartError("chart has live marbles; pass force=true to delete", 409, {
            conflict: "live_marbles",
            marbles: live.map((m) => ({ id: m.id, node: m.node, status: m.status })),
          })
        }
      }
      try {
        await rt.engine.stop()
      } catch (err) {
        await rt.engine.resume()
        throw new ChartError(`chart "${name}" did not quiesce for delete: ${errMsg(err)}`, 503)
      }
      this.runtimes.delete(name)
      await unlink(rt.file).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      })
      if (opts.purge) await rt.store.purge() // else leave run-state on disk for audit
      logLine(name, `deleted (force=${!!opts.force} purge=${!!opts.purge})`)
      return { name, purged: !!opts.purge }
    })
  }

  private rt(name: string): ChartRuntime {
    const rt = this.runtimes.get(name)
    if (!rt) throw new Error(`unknown chart: ${name}`)
    return rt
  }

  private nodeById(rt: ChartRuntime, id: string): ChartNode | undefined {
    return rt.chart.nodes.find((n) => n.id === id)
  }

  def(name: string): ChartDef {
    const rt = this.rt(name)
    const boxes: Record<string, NodeBox> = {}
    for (const [id, b] of rt.layout.boxes) boxes[id] = b
    return {
      name: rt.chart.name,
      start: rt.start,
      nodes: rt.chart.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        color: n.color,
        present: n.present,
        stuck_after: n.stuck_after,
        timeout: n.timeout,
        retry: n.retry,
        on_leave: n.on_leave,
        config: redactSecrets(n.config) as Record<string, unknown>,
        form: n.type === "source" ? ((n.config as Record<string, unknown>).form as FormField[] | undefined) : undefined,
      })),
      edges: rt.chart.edges.map((e) => ({ from: e.from, to: e.to, name: e.name, default: e.default, form: e.form })),
      layout: { boxes, width: rt.layout.width, height: rt.layout.height },
      // Re-linted per request: the live chart may have been hot-reloaded since boot.
      lint: lintChart(rt.chart).warnings,
    }
  }

  // NOTE: `opts.start` targeting a non-source node bypasses intake-form
  // validation by design (operator-trusted API, used for testing/repair).
  // UI clients must not surface arbitrary `start` to end users.
  async submit(name: string, opts: SubmitOpts = {}): Promise<Marble> {
    // Serialized with chart mutations: a submit must not enqueue onto an engine
    // that a concurrent hot-reload is about to quiesce-and-discard, or the marble
    // would persist as queued on the dead engine and never be pumped.
    return this.mutate(async () => {
      const rt = this.rt(name)
      const startId = opts.start ?? rt.start
      const startNode = this.nodeById(rt, startId)
      let context = opts.context ?? {}
      const form = startNode?.type === "source"
        ? ((startNode.config as Record<string, unknown>).form as FormField[] | undefined)
        : undefined
      if (form) context = validateForm(form, context) // throws FormError → API 400
      const m = newMarble(name, startId, context, opts.workpiece)
      logLine(name, `marble submitted id=${m.id} start=${m.node}`)
      await rt.engine.submit(m)
      return m
    })
  }

  async marbles(name: string): Promise<Marble[]> {
    return this.rt(name).store.all()
  }

  async marble(name: string, id: string): Promise<Marble | null> {
    return this.rt(name).store.load(id)
  }

  async retry(name: string, id: string): Promise<void> {
    return this.mutate(async () => {
      logLine(name, `retry requested marble=${id}`)
      await this.rt(name).engine.retry(id)
    })
  }

  async focusSession(name: string, id: string): Promise<"ok" | "no-session" | "unreachable"> {
    const m = await this.rt(name).store.load(id)
    const session = m?.context._session
    if (typeof session !== "string" || !session) return "no-session"
    const ok = await this.opts.client.panToSession(session)
    return ok ? "ok" : "unreachable"
  }

  // Resume a blocked marble (agent done / human decision). Validates the
  // chosen edge's form against the merge payload, then stops the marble's
  // agent session unless the node opts into keep_session.
  async signal(name: string, id: string, sig: { next?: string; merge?: Record<string, unknown> } = {}): Promise<void> {
    // Serialized with chart mutations for the same reason as submit() — the
    // re-queue must land on the live engine, not one being swapped out.
    return this.mutate(async () => {
      const rt = this.rt(name)
      logLine(name, `signal received marble=${id} next=${sig.next ?? "-"}`)
      const before = await rt.store.load(id)
      if (before && before.status === "blocked") {
        const edges = rt.chart.edges.filter((e) => e.from === before.node)
        const edge = sig.next
          ? edges.find((e) => e.name === sig.next) ?? edges.find((e) => e.to === sig.next)
          : edges.length === 1 ? edges[0] : edges.find((e) => e.default)
        if (edge?.form) sig = { ...sig, merge: validateForm(edge.form, sig.merge ?? {}) } // throws FormError → API 400
      }
      await rt.engine.signal(id, sig)
      const session = before?.context._session
      if (typeof session === "string" && session && this.launcher) {
        const node = this.nodeById(rt, before!.node)
        if (node?.type === "agent" && (node.config as Record<string, unknown>).keep_session !== true) {
          // Fire-and-forget teardown, but never let a rejecting launcher surface as
          // an unhandled promise rejection in the daemon.
          void this.launcher.stopSession(session).catch((err) =>
            logLine(name, `session stop failed for ${session}: ${String(err).split("\n")[0]}`),
          )
        }
      }
    })
  }

  // Bounded live view aggregate for the UI to poll. O(1) — no store scans.
  snapshot(name: string): ViewSnapshot {
    return this.rt(name).view.snapshot()
  }

  // Delta of a node's live-output feed since the caller's cursor (ring-bounded,
  // so since=0 returns at most one ring's worth, never a full replay).
  logsSince(name: string, nodeId: string, since: number, marble?: string): LogDelta {
    return this.rt(name).logs.since(nodeId, since, marble)
  }
}
