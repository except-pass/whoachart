import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseChart } from "./schema"
import { registerBuiltins } from "./nodeTypes"
import { hasNodeType } from "./registry"
import { MarbleStore } from "./store"
import { Engine, newMarble } from "./engine"
import { ViewBridge } from "./view/bridge"
import type { ArtifactSink } from "./tinstar"
import type { Chart, Marble } from "./types"

export interface DaemonOpts {
  charts: string[]
  storeDir: string
  client: ArtifactSink
  concurrency?: number
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
    for (const path of this.opts.charts) {
      const chart = parseChart(await readFile(path, "utf8"))
      const store = new MarbleStore(join(this.opts.storeDir, chart.name))
      await store.init()
      const bridge = new ViewBridge(this.opts.client, chart)
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
}
