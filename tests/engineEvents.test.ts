import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import { Engine, newMarble, type EngineEvent } from "../src/engine"
import { MarbleStore } from "../src/store"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry, registerNodeType } from "../src/registry"
import type { Chart } from "../src/types"

beforeEach(() => {
  clearRegistry()
  registerBuiltins()
  registerNodeType({
    type: "waiter",
    configSchema: z.object({}).passthrough(),
    run: async () => ({ block: true }),
  })
})

function store() { return new MarbleStore(join(tmpdir(), "wc-ev-" + crypto.randomUUID().slice(0, 8))) }

test("a linear run emits enter/traverse/end in order", async () => {
  const chart: Chart = {
    name: "lin",
    nodes: [
      { id: "s", type: "source", config: {} },
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [{ from: "s", to: "done" }],
  }
  const events: EngineEvent[] = []
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st, onEvent: (e) => events.push(e) })
  const m = newMarble("lin", "s")
  await eng.submit(m); await eng.drain()
  expect(events.map((e) => e.type)).toEqual(["enter", "traverse", "enter", "end"])
  const end = events.at(-1) as Extract<EngineEvent, { type: "end" }>
  expect(end.outcome).toBe("success")
})

test("block + signal emit blocked and signaled events", async () => {
  const chart: Chart = {
    name: "blk",
    nodes: [
      { id: "wait", type: "waiter", config: {} },
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [{ from: "wait", to: "done", name: "go" }],
  }
  const events: EngineEvent[] = []
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st, onEvent: (e) => events.push(e) })
  const m = newMarble("blk", "wait")
  await eng.submit(m); await eng.drain()
  expect(events.at(-1)?.type).toBe("blocked")

  await eng.signal(m.id, { next: "go" })
  await eng.drain()
  const types = events.map((e) => e.type)
  expect(types).toContain("signaled")
  expect(types.at(-1)).toBe("end")
  const trav = events.find((e) => e.type === "traverse") as Extract<EngineEvent, { type: "traverse" }>
  expect(trav.edge).toBe("go")
})

test("a failure emits a failed event with the error", async () => {
  registerNodeType({
    type: "boom",
    configSchema: z.object({}).passthrough(),
    run: async () => { throw new Error("kapow") },
  })
  const chart: Chart = { name: "f", nodes: [{ id: "a", type: "boom", config: {} }], edges: [] }
  const events: EngineEvent[] = []
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st, onEvent: (e) => events.push(e) })
  await eng.submit(newMarble("f", "a")); await eng.drain()
  const failed = events.find((e) => e.type === "failed") as Extract<EngineEvent, { type: "failed" }>
  expect(failed.error).toContain("kapow")
})
