import { readFile, unlink } from "node:fs/promises"
import { watch } from "node:fs"
import { join, basename } from "node:path"
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
import { now, deepMerge } from "./util"
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
  // Tinstar space NAME to confine this daemon's footprint to (WHOACHART_SPACE).
  // Unset → widgets land in Tinstar's active space (today's behavior). Set →
  // the space is resolved/created at start, every widget is placed there, the
  // id is exposed to shell nodes as WHOACHART_TINSTAR_SPACE, and the daemon
  // removes its widgets on SIGTERM/SIGINT.
  space?: string
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
    // Human-readable docs (markdown) + external runbook link. Surfaced to
    // operators (drawer/hover) and to agents reading /def for procedure routing.
    description?: string
    doc?: string
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
  // Resolved id of opts.space (undefined when unset or unresolvable → fallback
  // to active-space placement). Widgets created with it; teardown keyed off the
  // tracked ids below.
  private spaceId?: string
  private createdWidgets: Array<{ chart: string; widgetId: string }> = []
  private chartStore?: ChartStore
  // Charts that failed to parse/install at boot. Boot SKIPS a bad chart and
  // records it here rather than crashing the whole daemon (a single malformed
  // file must not take down every other chart). Inspect after start().
  readonly bootErrors: { name: string; error: string }[] = []
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

    // Confine this daemon's canvas footprint to a named Tinstar space when
    // WHOACHART_SPACE is set. Resolve (creating if needed) ONCE so the 15s
    // widget loop stays a cheap POST. On failure, log and fall back to
    // active-space placement rather than crashing — isolation is best-effort.
    if (this.opts.space) {
      this.spaceId = (await this.opts.client.ensureSpace(this.opts.space)) ?? undefined
      if (this.spaceId) {
        // Expose to shell nodes (see buildEnv) so chart scripts can target the
        // same space; process-global because runShell reads from process.env.
        process.env.WHOACHART_TINSTAR_SPACE = this.spaceId
        logLine("daemon", `confining widgets to space "${this.opts.space}" (${this.spaceId})`)
        const teardownAndExit = (sig: string): void => {
          logLine("daemon", `${sig} — removing ${this.createdWidgets.length} widget(s) from space`)
          void this.teardownWidgets().finally(() => process.exit(0))
        }
        process.once("SIGTERM", () => teardownAndExit("SIGTERM"))
        process.once("SIGINT", () => teardownAndExit("SIGINT"))
      } else {
        // Clear any stale value (e.g. a prior daemon in this process) so the
        // fallback path can't leak another run's space id to shell nodes.
        delete process.env.WHOACHART_TINSTAR_SPACE
        logLine("daemon", `could not resolve space "${this.opts.space}" — widgets fall back to the active space`)
      }
    }

    // Explicit boot-load list (existing behavior). A malformed chart is skipped
    // and recorded (bootErrors) — one bad file must not crash the daemon.
    for (const path of this.opts.charts ?? []) {
      const name = basename(path).replace(/\.ya?ml$/, "")
      await this.bootLoad(name, path)
    }
    // Store-dir charts (CRUD-managed). Skip names already loaded above so a dir
    // that overlaps the explicit list (the common default) isn't double-loaded.
    if (this.chartStore) {
      for (const name of await this.chartStore.listNames()) {
        if (this.runtimes.has(name)) continue
        const file = await this.chartStore.resolvePath(name) // honor a legacy .yml
        await this.bootLoad(name, file)
      }
    }
  }

  // Parse + install one chart at boot, isolating failure: a bad file is logged
  // and recorded in bootErrors instead of bubbling up and crashing start().
  private async bootLoad(name: string, file: string): Promise<void> {
    try {
      const chart = parseChart(await readFile(file, "utf8"))
      await this.installRuntime(chart, file)
    } catch (err) {
      const error = errMsg(err)
      this.bootErrors.push({ name, error })
      logLine(name, `boot-load skipped (invalid chart): ${error}`)
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
      this.opts.client.ensureBrowserWidget({ url, title: `whoachart-${chart.name}`, spaceId: this.spaceId }).then(
        (res) => {
          // Track for SIGTERM teardown (no-op when no space is configured —
          // we only tear down in sandbox mode). Dedupe by widgetId so the 15s
          // retry can't accumulate duplicate teardown entries.
          if (this.spaceId && !this.createdWidgets.some((w) => w.widgetId === res.widgetId)) {
            this.createdWidgets.push({ chart: chart.name, widgetId: res.widgetId })
          }
          logLine(chart.name, `widget ensured url=${url}`)
        },
        (err) => {
          logLine(chart.name, `widget ensure failed (${String(err).split("\n")[0]}); retrying in ${retryMs / 1000}s`)
          const t = setTimeout(attempt, retryMs)
          ;(t as unknown as { unref?: () => void }).unref?.()
        },
      )
    }
    attempt()
  }

  // How many widgets this run is tracking for teardown (test/inspection seam).
  get trackedWidgetCount(): number {
    return this.createdWidgets.length
  }

  // Remove the browser widgets this run created (sandbox-space teardown).
  // Best-effort and time-bounded so shutdown can't hang on a slow Tinstar.
  // Returns the number of widgets it attempted to remove.
  async teardownWidgets(): Promise<number> {
    const widgets = this.createdWidgets.splice(0)
    if (!widgets.length) return 0
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(widgets.map((w) => this.opts.client.deleteBrowserWidget(w.widgetId).catch(() => false))),
      // Cleared on the fast path so a direct call (tests) doesn't dangle a 3s timer.
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000) }),
    ])
    if (timer) clearTimeout(timer)
    return widgets.length
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

  // Rescan the chart-store dir and bring live any *.yaml not already loaded —
  // the "I dropped a file in the dir" path, hot with no restart. Mirrors the
  // boot store-dir loop: additive-only (edits/deletes stay with update/delete),
  // skips names already live, and isolates a bad file so one malformed chart
  // can't sink the rescan. Serialized via mutate() like every other swap.
  async loadNewCharts(): Promise<{ loaded: string[]; errors: { name: string; error: string }[] }> {
    if (!this.chartStore) throw new ChartError("chart store not configured (set WHOACHART_CHARTS_DIR)", 501)
    return this.mutate(async () => {
      const loaded: string[] = []
      const errors: { name: string; error: string }[] = []
      for (const name of await this.chartStore!.listNames()) {
        if (this.runtimes.has(name)) continue
        try {
          const file = await this.chartStore!.resolvePath(name) // honor a legacy .yml
          const chart = parseChart(await readFile(file, "utf8"))
          await this.installRuntime(chart, file)
          logLine(chart.name, "loaded (rescan)")
          loaded.push(chart.name)
        } catch (err) {
          errors.push({ name, error: errMsg(err) })
        }
      }
      return { loaded, errors }
    })
  }

  // Opt-in (WHOACHART_WATCH=1): auto-rescan the store dir whenever a file lands,
  // so dropping a chart in goes live with no manual reload. Coalesces a burst of
  // fs events (editor temp files, tmp+rename publishes) into one loadNewCharts()
  // via a trailing debounce, and skips overlapping rescans. Returns a stop fn.
  watchCharts(debounceMs = 500): () => void {
    if (!this.chartStore) throw new ChartError("chart store not configured (set WHOACHART_CHARTS_DIR)", 501)
    const dir = this.chartStore.dir
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let pending = false
    let disposed = false // stop() means stop: short-circuit any queued/in-flight rescan
    const rescan = async (): Promise<void> => {
      if (disposed) return
      if (running) { pending = true; return } // don't overlap; coalesce into a follow-up
      running = true
      try {
        const { loaded, errors } = await this.loadNewCharts()
        for (const n of loaded) logLine(n, "auto-loaded (watch)")
        for (const e of errors) logLine(e.name, `watch load failed: ${e.error}`)
      } catch (err) {
        logLine("(watch)", `rescan failed: ${errMsg(err)}`)
      } finally {
        running = false
        if (pending && !disposed) { pending = false; void rescan() }
      }
    }
    const watcher = watch(dir, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void rescan() }, debounceMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    // fs.watch can emit 'error' (inotify watch exhaustion, dir removed) — without
    // a handler that surfaces as an unhandled event and crashes the daemon. Log
    // and degrade to manual reload instead.
    watcher.on("error", (err) => logLine("(watch)", `watcher error (auto-pickup disabled): ${errMsg(err)}`))
    logLine("(watch)", `watching ${dir} for new charts`)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      watcher.close()
    }
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
        // Docs are intentionally NOT run through redactSecrets — they're
        // human-authored prose, not config values that might carry credentials.
        description: n.description,
        doc: n.doc,
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

  async focusSession(name: string, id: string): Promise<"ok" | "no-session" | "session-gone" | "unreachable"> {
    const m = await this.rt(name).store.load(id)
    const session = m?.context._session
    if (typeof session !== "string" || !session) return "no-session"
    const result = await this.opts.client.panToSession(session)
    if (result === "ok") return "ok"
    if (result === "no-run") return "session-gone"
    return "unreachable"
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

  // Merge context into a marble WITHOUT advancing it — the agent's "inject a
  // decision brief while it sits at the gate" verb. Deep-merges `merge` into
  // marble.context and persists; it deliberately does NOT touch edges/engine, so
  // a blocked marble stays blocked and the operator still makes the call.
  // Serialized with chart mutations so it can't land on a runtime mid-swap.
  async annotate(name: string, id: string, merge: Record<string, unknown>): Promise<Marble> {
    return this.mutate(async () => {
      const rt = this.rt(name)
      const m = await rt.store.load(id)
      if (!m) throw new ChartError(`marble not found: ${id}`, 404)
      m.context = deepMerge(m.context, merge)
      m.updatedAt = now()
      await rt.store.save(m)
      rt.view.apply(m) // keep the live aggregate's view of this marble fresh
      logLine(name, `annotated marble=${id} keys=${Object.keys(merge).join(",") || "-"}`)
      return m
    })
  }

  // Resolve an `as: markdown_file` present entry to the file's text. The path is
  // taken from the marble's CONTEXT (the present spec names the key) — never from
  // a caller-supplied path — so this reads no more than annotate/emit already
  // wrote. Returns null when the chart/marble/spec/file isn't found or readable.
  async presentFile(name: string, id: string, key: string): Promise<{ path: string; markdown: string } | null> {
    const rt = this.runtimes.get(name)
    if (!rt) return null
    const m = await rt.store.load(id)
    if (!m) return null
    const node = this.nodeById(rt, m.node)
    const spec = node?.present?.find((p) => p.key === key && p.as === "markdown_file")
    if (!spec) return null
    const path = m.context[key]
    if (typeof path !== "string" || !path) return null
    try {
      return { path, markdown: await readFile(path, "utf8") }
    } catch {
      return null
    }
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
