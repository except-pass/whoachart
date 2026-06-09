import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseChart } from "./schema"
import { registerBuiltins } from "./nodeTypes"
import { makeAgentNode } from "./nodeTypes/agent"
import { hasNodeType, registerNodeType } from "./registry"
import { MarbleStore } from "./store"
import { Engine, newMarble } from "./engine"
import { ViewBridge } from "./view/bridge"
import type { ViewSnapshot } from "./view/viewState"
import type { ArtifactSink, SessionLauncher } from "./tinstar"
import type { Chart, Marble } from "./types"

export interface DaemonOpts {
  charts: string[]
  storeDir: string
  client: ArtifactSink
  concurrency?: number
  // Base URL the canvas page uses to poll this daemon (its own origin).
  baseUrl?: string
  // Spawns/stops agent sessions; defaults to a launcher that errors, so charts
  // without agent nodes work with no launcher configured.
  launcher?: SessionLauncher
}

interface ChartRuntime {
  chart: Chart
  engine: Engine
  store: MarbleStore
  bridge: ViewBridge
  start: string
}

export interface SubmitOpts {
  context?: Record<string, unknown>
  workpiece?: string
  start?: string
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

  constructor(private opts: DaemonOpts) {}

  async start(): Promise<void> {
    if (!hasNodeType("end")) registerBuiltins()
    const baseUrl = this.opts.baseUrl ?? "http://localhost:5330"
    if (!hasNodeType("agent")) {
      const launcher: SessionLauncher = this.opts.launcher ?? {
        spawnSession: async () => { throw new Error("no session launcher configured (agent nodes need one)") },
        stopSession: async () => {},
      }
      registerNodeType(makeAgentNode(launcher, (m) => `${baseUrl}/api/charts/${m.chart}/marbles/${m.id}/signal`))
    }
    for (const path of this.opts.charts) {
      const chart = parseChart(await readFile(path, "utf8"))
      const store = new MarbleStore(join(this.opts.storeDir, chart.name))
      await store.init()
      const stateUrl = `${baseUrl}/api/charts/${chart.name}/state`
      const bridge = new ViewBridge(this.opts.client, chart, stateUrl)
      const engine = new Engine({
        chart,
        store,
        concurrency: this.opts.concurrency,
        onChange: (m) => bridge.update(m),
      })
      bridge.seed(await store.all())
      await bridge.start()
      await engine.resume()
      this.runtimes.set(chart.name, { chart, engine, store, bridge, start: findStart(chart) })
    }
  }

  charts(): string[] {
    return [...this.runtimes.keys()]
  }

  private rt(name: string): ChartRuntime {
    const rt = this.runtimes.get(name)
    if (!rt) throw new Error(`unknown chart: ${name}`)
    return rt
  }

  async submit(name: string, opts: SubmitOpts = {}): Promise<Marble> {
    const rt = this.rt(name)
    const m = newMarble(name, opts.start ?? rt.start, opts.context ?? {}, opts.workpiece)
    await rt.engine.submit(m)
    return m
  }

  async marbles(name: string): Promise<Marble[]> {
    return this.rt(name).store.all()
  }

  async marble(name: string, id: string): Promise<Marble | null> {
    return this.rt(name).store.load(id)
  }

  // Resume a blocked marble (agent done / external decision). Stops the
  // marble's agent session unless the node opts into keep_session.
  async signal(name: string, id: string, sig: { next?: string; merge?: Record<string, unknown> } = {}): Promise<void> {
    const rt = this.rt(name)
    const before = await rt.store.load(id)
    await rt.engine.signal(id, sig)
    const session = before?.context._session
    if (typeof session === "string" && session && this.opts.launcher) {
      // Only tear down when the node we just resumed is the agent that owns
      // the session — a later non-agent block would otherwise re-stop a stale
      // _session left in context.
      const node = rt.chart.nodes.find((n) => n.id === before!.node)
      if (node?.type === "agent" && (node.config as any).keep_session !== true) {
        void this.opts.launcher.stopSession(session)
      }
    }
  }

  // Bounded live view aggregate (in-flight marbles + per-end tallies) for the
  // canvas page to poll. O(1) — does not scan the store.
  snapshot(name: string): ViewSnapshot {
    return this.rt(name).bridge.snapshot()
  }
}
