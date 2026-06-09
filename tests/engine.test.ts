// tests/engine.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Engine, newMarble } from "../src/engine"
import { MarbleStore } from "../src/store"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry } from "../src/registry"
import type { Chart, Marble } from "../src/types"

beforeEach(() => { clearRegistry(); registerBuiltins() })

function store() { return new MarbleStore(join(tmpdir(), "wc-eng-" + crypto.randomUUID().slice(0, 8))) }

const linear: Chart = {
  name: "linear",
  nodes: [
    { id: "s", type: "source", config: { trigger: "api" } },
    { id: "work", type: "shell", config: { on_enter: `echo '{"merge":{"did":true}}'` } },
    { id: "done", type: "end", config: { outcome: "success" } },
  ],
  edges: [ { from: "s", to: "work" }, { from: "work", to: "done" } ],
}

test("a marble runs to a success end and persists context", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart: linear, store: st })
  const m = newMarble("linear", "s")
  await eng.submit(m)
  await eng.drain()
  const final = await st.load(m.id)
  expect(final?.status).toBe("done")
  expect(final?.context.did).toBe(true)
  expect(final?.context._outcome).toBe("success")
})

test("named-edge routing picks the right branch", async () => {
  const branch: Chart = {
    name: "branch",
    nodes: [
      { id: "d", type: "decision", config: { on_enter: `echo '{"next":"left"}'` } },
      { id: "L", type: "end", config: { outcome: "success" } },
      { id: "R", type: "end", config: { outcome: "fail" } },
    ],
    edges: [ { from: "d", to: "L", name: "left" }, { from: "d", to: "R", name: "right" } ],
  }
  const st = store(); await st.init()
  const eng = new Engine({ chart: branch, store: st })
  const m = newMarble("branch", "d")
  await eng.submit(m); await eng.drain()
  expect((await st.load(m.id))?.node).toBe("L")
})

test("failed activity routes to the default edge", async () => {
  const chart: Chart = {
    name: "fail",
    nodes: [
      { id: "w", type: "shell", config: { on_enter: `exit 1` } },
      { id: "ok", type: "end", config: { outcome: "success" } },
      { id: "bad", type: "end", config: { outcome: "fail" } },
    ],
    edges: [ { from: "w", to: "ok", name: "ok" }, { from: "w", to: "bad", default: true } ],
  }
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("fail", "w")
  await eng.submit(m); await eng.drain()
  expect((await st.load(m.id))?.node).toBe("bad")
})

test("cycle guard fails a runaway loop", async () => {
  const loop: Chart = {
    name: "loop",
    nodes: [ { id: "a", type: "shell", config: { on_enter: `echo hi` } } ],
    edges: [ { from: "a", to: "a" } ],
  }
  const st = store(); await st.init()
  const eng = new Engine({ chart: loop, store: st, maxSteps: 10 })
  const m = newMarble("loop", "a")
  await eng.submit(m); await eng.drain()
  const f = await st.load(m.id)
  expect(f?.status).toBe("failed")
  expect(f?.error).toMatch(/max steps/)
})

test("resume re-enqueues in-flight marbles from disk", async () => {
  const st = store(); await st.init()
  // a marble persisted mid-flight at "work"
  const m: Marble = { id: "r1", chart: "linear", node: "work", context: {}, history: ["s", "work"], status: "running", createdAt: "t", updatedAt: "t" }
  await st.save(m)
  const eng = new Engine({ chart: linear, store: st })
  await eng.resume()
  await eng.drain()
  expect((await st.load("r1"))?.status).toBe("done")
})
