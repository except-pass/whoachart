import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import { Engine, newMarble } from "../src/engine"
import { MarbleStore } from "../src/store"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry, registerNodeType } from "../src/registry"
import type { Chart } from "../src/types"

beforeEach(() => {
  clearRegistry()
  registerBuiltins()
  // a node type that blocks (stand-in for an agent step)
  registerNodeType({
    type: "waiter",
    configSchema: z.object({}).passthrough(),
    run: async () => ({ block: true }),
  })
})

function store() { return new MarbleStore(join(tmpdir(), "wc-sig-" + crypto.randomUUID().slice(0, 8))) }

const chart: Chart = {
  name: "sig",
  nodes: [
    { id: "wait", type: "waiter", config: {} },
    { id: "ok", type: "end", config: { outcome: "success" } },
    { id: "bad", type: "end", config: { outcome: "fail" } },
  ],
  edges: [
    { from: "wait", to: "ok", name: "pass" },
    { from: "wait", to: "bad", name: "fail" },
  ],
}

test("marble blocks, then signal(next) resumes it along the named edge", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("sig", "wait")
  await eng.submit(m); await eng.drain()
  expect((await st.load(m.id))?.status).toBe("blocked")

  await eng.signal(m.id, { next: "pass", merge: { verdict: "looks good" } })
  await eng.drain()
  const f = await st.load(m.id)
  expect(f?.status).toBe("done")
  expect(f?.node).toBe("ok")
  expect(f?.context.verdict).toBe("looks good")
})

test("signal with a next that matches no outgoing edge throws and leaves the marble blocked", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("sig", "wait")
  await eng.submit(m); await eng.drain()

  await expect(eng.signal(m.id, { next: "typo" })).rejects.toThrow(/no outgoing edge|matches no/i)
  // the marble stays blocked so the caller can retry with a corrected edge —
  // a typo must not permanently fail the work item.
  expect((await st.load(m.id))?.status).toBe("blocked")
})

test("signal without next on a multi-edge node throws (cannot route)", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("sig", "wait")
  await eng.submit(m); await eng.drain()

  await expect(eng.signal(m.id, {})).rejects.toThrow(/no outgoing edge|matches no/i)
  expect((await st.load(m.id))?.status).toBe("blocked")
})

test("signal({}) succeeds on a single unnamed-edge node (guard must not block legit routing)", async () => {
  const single: Chart = {
    name: "single",
    nodes: [
      { id: "wait", type: "waiter", config: {} },
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [{ from: "wait", to: "done" }], // one unnamed edge — no `next` needed
  }
  const st = store(); await st.init()
  const eng = new Engine({ chart: single, store: st })
  const m = newMarble("single", "wait")
  await eng.submit(m); await eng.drain()
  expect((await st.load(m.id))?.status).toBe("blocked")

  await eng.signal(m.id, {}) // no next — must route along the sole edge
  await eng.drain()
  const f = await st.load(m.id)
  expect(f?.status).toBe("done")
  expect(f?.node).toBe("done")
})

test("signal on a non-blocked marble throws", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("sig", "wait")
  await eng.submit(m); await eng.drain()
  await eng.signal(m.id, { next: "pass" })
  await eng.drain()
  await expect(eng.signal(m.id, { next: "pass" })).rejects.toThrow(/not blocked/)
})

test("signal on an unknown marble throws", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  await expect(eng.signal("nope", {})).rejects.toThrow(/unknown marble/)
})
