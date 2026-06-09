import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseChart } from "./schema"
import { registerBuiltins } from "./nodeTypes"
import { hasNodeType } from "./registry"
import { MarbleStore } from "./store"
import { Engine, newMarble } from "./engine"
import type { Marble } from "./types"

export interface RunOpts {
  start: string
  context?: Record<string, unknown>
  workpiece?: string
  storeDir?: string
}

// Convenience headless runner: load a chart file, run ONE marble to completion,
// and return its final state. (Plan 2 adds the long-lived daemon + control API.)
export async function runChartFile(path: string, opts: RunOpts): Promise<Marble> {
  if (!hasNodeType("end")) registerBuiltins()
  const chart = parseChart(await readFile(path, "utf8"))
  const store = new MarbleStore(opts.storeDir ?? join(tmpdir(), "whoachart-" + crypto.randomUUID().slice(0, 8)))
  await store.init()

  const engine = new Engine({ chart, store })
  const m = newMarble(chart.name, opts.start, opts.context ?? {}, opts.workpiece)
  await engine.submit(m)
  await engine.drain()

  const final = await store.load(m.id)
  if (!final) throw new Error(`marble ${m.id} vanished from store`)
  return final
}
