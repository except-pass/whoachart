import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseChart } from "./schema"
import { registerBuiltins } from "./nodeTypes"
import { agentSchemaNode, makeAgentNode } from "./nodeTypes/agent"
import { hasNodeType, registerNodeType, type NodeType } from "./registry"
import { MarbleStore } from "./store"
import { Engine, newMarble, type EngineEvent } from "./engine"
import { ViewState, type ViewSnapshot } from "./view/viewState"
import { layoutChart, type Layout, type NodeBox } from "./view/layout"
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
  charts: string[]
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
  layout: Layout
  start: string
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
    form?: FormField[]
  }[]
  edges: { from: string; to: string; name?: string; default?: boolean; form?: FormField[] }[]
  layout: { boxes: Record<string, NodeBox>; width: number; height: number }
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

  constructor(private opts: DaemonOpts) {}

  private get publicUrl(): string {
    return this.opts.publicUrl ?? this.opts.baseUrl ?? "http://localhost:5330"
  }

  async start(): Promise<void> {
    if (!hasNodeType("end")) registerBuiltins()
    const baseUrl = this.opts.baseUrl ?? "http://localhost:5330"
    this.launcher = this.opts.launcher ? loggingLauncher(this.opts.launcher) : undefined
    // Global registration is schema-only (for chart parsing/config validation);
    // the wired agent node is instance-scoped so this daemon's launcher/baseUrl
    // never leak to another Daemon in the same process via the module-global map.
    if (!hasNodeType("agent")) registerNodeType(agentSchemaNode)
    const launcher: SessionLauncher = this.launcher ?? {
      spawnSession: async () => { throw new Error("no session launcher configured (agent nodes need one)") },
      stopSession: async () => {},
    }
    const nodeTypes = new Map<string, NodeType>([
      ["agent", makeAgentNode(launcher, (m) => `${baseUrl}/api/charts/${m.chart}/marbles/${m.id}/signal`)],
    ])
    for (const path of this.opts.charts) {
      const chart = parseChart(await readFile(path, "utf8"))
      const store = new MarbleStore(join(this.opts.storeDir, chart.name))
      await store.init()
      const view = new ViewState(chart)
      const engine = new Engine({
        chart,
        store,
        concurrency: this.opts.concurrency,
        nodeTypes,
        onChange: (m) => view.apply(m),
        onEvent: (e) => logLine(chart.name, fmtEvent(e)),
      })
      view.seed(await store.all())
      await engine.resume()
      this.runtimes.set(chart.name, {
        chart, engine, store, view, layout: layoutChart(chart), start: findStart(chart),
      })
      this.ensureWidgetLoop(chart)
    }
  }

  // Keep one Tinstar browser-widget per chart pointing at our UI. Tolerates
  // Tinstar being down: logs and retries on a timer, never crashes the daemon.
  private ensureWidgetLoop(chart: Chart, retryMs = 15_000): void {
    const url = `${this.publicUrl}/ui/charts/${chart.name}`
    const attempt = (): void => {
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
        form: n.type === "source" ? ((n.config as Record<string, unknown>).form as FormField[] | undefined) : undefined,
      })),
      edges: rt.chart.edges.map((e) => ({ from: e.from, to: e.to, name: e.name, default: e.default, form: e.form })),
      layout: { boxes, width: rt.layout.width, height: rt.layout.height },
    }
  }

  // NOTE: `opts.start` targeting a non-source node bypasses intake-form
  // validation by design (operator-trusted API, used for testing/repair).
  // UI clients must not surface arbitrary `start` to end users.
  async submit(name: string, opts: SubmitOpts = {}): Promise<Marble> {
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
  }

  async marbles(name: string): Promise<Marble[]> {
    return this.rt(name).store.all()
  }

  async marble(name: string, id: string): Promise<Marble | null> {
    return this.rt(name).store.load(id)
  }

  async retry(name: string, id: string): Promise<void> {
    logLine(name, `retry requested marble=${id}`)
    await this.rt(name).engine.retry(id)
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
        void this.launcher.stopSession(session)
      }
    }
  }

  // Bounded live view aggregate for the UI to poll. O(1) — no store scans.
  snapshot(name: string): ViewSnapshot {
    return this.rt(name).view.snapshot()
  }
}
