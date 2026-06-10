// tests/engineTrail.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import { Engine, newMarble, type EngineEvent } from "../src/engine"
import { MarbleStore } from "../src/store"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry, registerNodeType } from "../src/registry"
import type { Chart } from "../src/types"

let failOnce = 0
beforeEach(() => {
  clearRegistry()
  registerBuiltins()
  failOnce = 0
  registerNodeType({
    type: "flaky",
    configSchema: z.object({}).passthrough(),
    run: async () => {
      if (failOnce++ === 0) throw new Error("first run breaks")
      return {}
    },
  })
})

function store() { return new MarbleStore(join(tmpdir(), "wc-tr-" + crypto.randomUUID().slice(0, 8))) }

const linear: Chart = {
  name: "lin",
  nodes: [
    { id: "s", type: "source", config: {} },
    { id: "w", type: "shell", config: { on_enter: "sleep 0.05" } },
    { id: "done", type: "end", config: { outcome: "success" } },
  ],
  edges: [ { from: "s", to: "w" }, { from: "w", to: "done" } ],
}

test("trail records a timestamped hop per node, closing on leave", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart: linear, store: st })
  const m = newMarble("lin", "s")
  expect(m.trail).toEqual([{ node: "s", enteredAt: m.createdAt }])
  await eng.submit(m); await eng.drain()
  const f = (await st.load(m.id))!
  expect(f.trail!.map((h) => h.node)).toEqual(["s", "w", "done"])
  expect(f.trail![0].leftAt).toBeTruthy()
  expect(f.trail![1].leftAt).toBeTruthy()
  expect(f.trail![2].leftAt).toBeUndefined() // still at the end node
  const dwell = new Date(f.trail![1].leftAt!).getTime() - new Date(f.trail![1].enteredAt).getTime()
  expect(dwell).toBeGreaterThanOrEqual(40)
})

test("marbles without a trail rehydrate fine (legacy records)", async () => {
  const st = store(); await st.init()
  const legacy = { ...newMarble("lin", "w"), trail: undefined }
  await st.save(legacy)
  const eng = new Engine({ chart: linear, store: st })
  await eng.resume(); await eng.drain()
  const f = (await st.load(legacy.id))!
  expect(f.status).toBe("done")
  expect(f.trail!.at(-1)!.node).toBe("done")
})

test("retry re-runs a failed marble and emits a retried event", async () => {
  const chart: Chart = {
    name: "r",
    nodes: [
      { id: "a", type: "flaky", config: {} },
      { id: "z", type: "end", config: { outcome: "success" } },
    ],
    edges: [{ from: "a", to: "z" }],
  }
  const events: EngineEvent[] = []
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st, onEvent: (e) => events.push(e) })
  const m = newMarble("r", "a")
  await eng.submit(m); await eng.drain()
  expect((await st.load(m.id))!.status).toBe("failed")

  await eng.retry(m.id); await eng.drain()
  const f = (await st.load(m.id))!
  expect(f.status).toBe("done")
  expect(f.error).toBeUndefined()
  expect(events.some((e) => e.type === "retried")).toBe(true)
})

test("retry on a non-failed marble throws", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart: linear, store: st })
  const m = newMarble("lin", "s")
  await eng.submit(m); await eng.drain()
  await expect(eng.retry(m.id)).rejects.toThrow(/not failed/)
  await expect(eng.retry("nope")).rejects.toThrow(/unknown marble/)
})

test("closed hops carry a context snapshot of the state as the marble left", async () => {
  const chart: Chart = {
    name: "snap",
    nodes: [
      { id: "s", type: "source", config: {} },
      { id: "w", type: "shell", config: { on_enter: `echo '{"merge":{"made":true}}'` } },
      { id: "z", type: "end", config: { outcome: "success" } },
    ],
    edges: [ { from: "s", to: "w" }, { from: "w", to: "z" } ],
  }
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("snap", "s", { seed: 1 })
  await eng.submit(m); await eng.drain()
  const f = (await st.load(m.id))!
  const [hopS, hopW, hopZ] = f.trail!
  expect(hopS.context).toEqual({ seed: 1 })            // state leaving the source
  expect(hopW.context).toEqual({ seed: 1, made: true }) // includes w's merge
  expect(hopZ.context).toBeUndefined()                  // still AT the end node (open hop)
  expect(f.context.made).toBe(true)
})
