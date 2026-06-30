// tests/hooks.test.ts — chart-level lifecycle hook dispatch (U3). Drives a real
// Engine over real charts. Hooks are shell commands, so their observable effect
// here is appending a tag to a per-test temp file; drain() awaits outstanding
// hooks, so the file is complete once drain resolves.
import { test, expect, beforeEach } from "bun:test"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Engine, newMarble } from "../src/engine"
import { MarbleStore } from "../src/store"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry, registerNodeType } from "../src/registry"
import type { Chart, ChartHook, Marble } from "../src/types"

beforeEach(() => {
  clearRegistry()
  registerBuiltins()
  registerNodeType({ type: "waiter", configSchema: z.object({}).passthrough(), run: async () => ({ block: true }) })
  registerNodeType({ type: "router", configSchema: z.object({}).passthrough(), run: async () => ({ next: "rejected" }) })
  registerNodeType({ type: "lost", configSchema: z.object({}).passthrough(), run: async () => ({ next: "nowhere" }) })
  registerNodeType({ type: "boom", configSchema: z.object({}).passthrough(), run: async () => { throw new Error("boom") } })
})

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wc-hooks-"))
}
function store(): MarbleStore {
  return new MarbleStore(join(tmpdir(), "wc-hk-" + crypto.randomUUID().slice(0, 8)))
}

interface RunResult {
  st: MarbleStore
  log: { node: string; stream: string; line: string }[]
  marble: () => Promise<Marble | null>
  doneAtMs?: number
}

// Build an engine for `chart`, submit a marble at `start`, drain, return capture.
async function run(chart: Chart, start: string): Promise<RunResult> {
  const st = store()
  await st.init()
  const log: { node: string; stream: string; line: string }[] = []
  let doneAtMs: number | undefined
  const eng = new Engine({
    chart,
    store: st,
    onLog: (x) => log.push({ node: x.node, stream: x.stream, line: x.line }),
    onChange: (m) => {
      if ((m.status === "done" || m.status === "failed") && doneAtMs === undefined) doneAtMs = Bun.nanoseconds() / 1e6
    },
  })
  const m = newMarble(chart.name, start)
  await eng.submit(m)
  await eng.drain()
  const res: RunResult = { st, log, marble: () => st.load(m.id) }
  res.doneAtMs = doneAtMs
  return res
}

function linear(hooks?: ChartHook[]): Chart {
  return {
    name: "lin",
    nodes: [
      { id: "s", type: "source", config: {} },
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [{ from: "s", to: "done", name: "go" }],
    hooks,
  }
}

test("enter fires once per node entered", async () => {
  const dir = tmp()
  const f = join(dir, "enters")
  await run(linear([{ on: "enter", run: `echo "$WHOACHART_NODE" >> ${f}` }]), "s")
  expect(readFileSync(f, "utf8").trim().split("\n")).toEqual(["s", "done"])
})

test("start fires exactly once, at the entry node", async () => {
  const dir = tmp()
  const f = join(dir, "starts")
  await run(linear([{ on: "start", run: `echo "$WHOACHART_NODE" >> ${f}` }]), "s")
  expect(readFileSync(f, "utf8").trim().split("\n")).toEqual(["s"])
})

test("a node-scoped enter hook fires only for that node", async () => {
  const dir = tmp()
  const f = join(dir, "scoped")
  await run(linear([{ on: "enter", node: "done", run: `echo hit >> ${f}` }]), "s")
  expect(readFileSync(f, "utf8").trim().split("\n")).toEqual(["hit"]) // once, not for "s"
})

test("a traverse hook fires only for the matching edge name", async () => {
  const dir = tmp()
  const f = join(dir, "trav")
  const chart: Chart = {
    name: "dec",
    nodes: [
      { id: "s", type: "source", config: {} },
      { id: "r", type: "router", config: {} }, // always routes "rejected"
      { id: "a", type: "end", config: { outcome: "success" } },
      { id: "b", type: "end", config: { outcome: "success" } },
    ],
    edges: [
      { from: "s", to: "r", name: "go" },
      { from: "r", to: "a", name: "approved" },
      { from: "r", to: "b", name: "rejected" },
    ],
    hooks: [
      { on: "traverse", edge: "approved", run: `echo approved >> ${f}` },
      { on: "traverse", edge: "rejected", run: `echo rejected >> ${f}` },
    ],
  }
  await run(chart, "s")
  // Only the rejected edge is taken; approved never fires.
  expect(readFileSync(f, "utf8").trim().split("\n")).toEqual(["rejected"])
})

test("blocked fires when a marble blocks at a gate", async () => {
  const dir = tmp()
  const f = join(dir, "blk")
  const chart: Chart = {
    name: "blk",
    nodes: [
      { id: "w", type: "waiter", config: {} },
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [{ from: "w", to: "done", name: "go" }],
    hooks: [{ on: "blocked", run: `echo "$WHOACHART_NODE" >> ${f}` }],
  }
  await run(chart, "w")
  expect(readFileSync(f, "utf8").trim()).toBe("w")
})

test("end fires with the outcome on env + stdin", async () => {
  const dir = tmp()
  const f = join(dir, "end")
  await run(linear([{ on: "end", run: `echo "$WHOACHART_OUTCOME" >> ${f}` }]), "s")
  expect(readFileSync(f, "utf8").trim()).toBe("success")
})

test("failed fires when routing finds no matching edge", async () => {
  const dir = tmp()
  const f = join(dir, "fail")
  const chart: Chart = {
    name: "f",
    nodes: [
      { id: "s", type: "source", config: {} },
      { id: "l", type: "lost", config: {} }, // routes "nowhere" — no such edge
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [
      { from: "s", to: "l", name: "go" },
      { from: "l", to: "done", name: "real" },
    ],
    hooks: [{ on: "failed", run: `echo "$WHOACHART_NODE" >> ${f}` }],
  }
  const r = await run(chart, "s")
  expect((await r.marble())?.status).toBe("failed")
  expect(readFileSync(f, "utf8").trim()).toBe("l")
})

test("OBSERVATIONAL: a failing/garbage hook leaves the marble path identical", async () => {
  const noHooks = await run(linear(), "s")
  const withHooks = await run(
    linear([
      { on: "enter", run: "echo garbage-to-stdout; exit 1" },
      { on: "leave", run: "exit 7" },
      { on: "end", run: "echo more-noise" },
    ]),
    "s",
  )
  const a = await noHooks.marble()
  const b = await withHooks.marble()
  expect(b?.status).toBe(a?.status)
  expect(b?.history).toEqual(a?.history!)
  expect(b?.node).toBe(a?.node!)
  // _outcome is the only context key set by the linear run; hooks never touch context.
  expect(b?.context).toEqual(a?.context!)
})

test("NON-BLOCKING: the marble reaches done well before a slow hook settles", async () => {
  const dir = tmp()
  const r = await run(linear([{ on: "start", run: `sleep 1; echo done >> ${join(dir, "slow")}` }]), "s")
  const drainReturnedAtMs = Bun.nanoseconds() / 1e6
  expect(r.doneAtMs).toBeDefined()
  // drain() DID wait ~1s for the start hook; the marble itself completed ~1s
  // earlier. A blocking dispatch would make these two timestamps near-equal, so a
  // wide gap is the actual proof the marble was never delayed by the hook.
  expect(drainReturnedAtMs - r.doneAtMs!).toBeGreaterThan(700)
  expect(readFileSync(join(dir, "slow"), "utf8").trim()).toBe("done") // hook really ran
})

test("drain() awaits outstanding hooks (slow hook's output is present after drain)", async () => {
  const dir = tmp()
  const f = join(dir, "drained")
  await run(linear([{ on: "end", run: `sleep 0.2; echo settled >> ${f}` }]), "s")
  expect(readFileSync(f, "utf8").trim()).toBe("settled")
})

test("a hook that overruns its timeout does not wedge drain() (pipeline grandchild)", async () => {
  const t0 = Bun.nanoseconds()
  // `sleep 9 | cat` leaves cat holding the stdout fd; without a bounded runner
  // drain() would block ~9s. The 100ms timeout must cap it.
  await run(linear([{ on: "start", run: "sleep 9 | cat", timeout: 100 }]), "s")
  expect((Bun.nanoseconds() - t0) / 1e6).toBeLessThan(3000)
})

test("hook stdout streams into the per-node log feed (R7)", async () => {
  const r = await run(linear([{ on: "enter", node: "s", run: "echo streamed-line" }]), "s")
  const hit = r.log.find((l) => l.stream === "stdout" && l.line === "streamed-line")
  expect(hit?.node).toBe("s")
})

test("failed fires from the step catch when a node activity throws", async () => {
  const dir = tmp()
  const f = join(dir, "boom")
  const chart: Chart = {
    name: "boom",
    nodes: [
      { id: "s", type: "source", config: {} },
      { id: "x", type: "boom", config: {} }, // run() throws
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [
      { from: "s", to: "x", name: "go" },
      { from: "x", to: "done", name: "next" },
    ],
    hooks: [{ on: "failed", run: `echo "$WHOACHART_NODE" >> ${f}` }],
  }
  const r = await run(chart, "s")
  expect((await r.marble())?.status).toBe("failed")
  expect(readFileSync(f, "utf8").trim()).toBe("x") // fired with the throwing node
})

test("start fires exactly once even when the marble blocks at its FIRST node then is signaled", async () => {
  const dir = tmp()
  const f = join(dir, "startonce")
  const chart: Chart = {
    name: "blkstart",
    nodes: [
      { id: "g", type: "waiter", config: {} }, // blocks immediately, at the entry node
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [{ from: "g", to: "done", name: "go" }],
    hooks: [{ on: "start", run: `echo x >> ${f}` }],
  }
  const st = store()
  await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("blkstart", "g") // submit directly at the blocking node
  await eng.submit(m)
  await eng.drain()
  expect((await st.load(m.id))?.status).toBe("blocked")
  await eng.signal(m.id, { next: "go" }) // re-enters g — history is still length 1 here
  await eng.drain()
  expect((await st.load(m.id))?.status).toBe("done")
  // The defect this guards: history.length===1 still held on re-entry, so a
  // history-based gate would fire `start` twice.
  expect(readFileSync(f, "utf8").trim().split("\n")).toEqual(["x"])
})

test("failed fires from the cycle guard (maxSteps exceeded)", async () => {
  const dir = tmp()
  const f = join(dir, "cycle")
  const chart: Chart = {
    name: "loop",
    nodes: [
      { id: "s", type: "source", config: {} },
      { id: "a", type: "source", config: {} },
    ],
    edges: [
      { from: "s", to: "a", name: "go" },
      { from: "a", to: "s", name: "back" }, // s <-> a forever
    ],
    hooks: [{ on: "failed", run: `echo cycle >> ${f}` }],
  }
  const st = store()
  await st.init()
  const eng = new Engine({ chart, store: st, maxSteps: 3 })
  const m = newMarble("loop", "s")
  await eng.submit(m)
  await eng.drain()
  expect((await st.load(m.id))?.status).toBe("failed")
  expect(readFileSync(f, "utf8").trim()).toBe("cycle")
})

test("a node-scoped leave hook fires only on departure from its node (no on_leave present)", async () => {
  const dir = tmp()
  const f = join(dir, "leaveonly")
  const chart: Chart = {
    name: "lv",
    nodes: [
      { id: "s", type: "source", config: {} },
      { id: "m", type: "source", config: {} },
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [
      { from: "s", to: "m", name: "a" },
      { from: "m", to: "done", name: "b" },
    ],
    hooks: [{ on: "leave", node: "m", run: `echo "$WHOACHART_NODE" >> ${f}` }],
  }
  await run(chart, "s")
  expect(readFileSync(f, "utf8").trim().split("\n")).toEqual(["m"]) // only m leaves, not s
})

test("R8: inline on_leave and a leave hook both run", async () => {
  const dir = tmp()
  const fLeaveHook = join(dir, "leave-hook")
  const fOnLeave = join(dir, "on-leave")
  const chart: Chart = {
    name: "both",
    nodes: [
      { id: "s", type: "source", config: {}, on_leave: `echo inline >> ${fOnLeave}` },
      { id: "done", type: "end", config: { outcome: "success" } },
    ],
    edges: [{ from: "s", to: "done", name: "go" }],
    hooks: [{ on: "leave", node: "s", run: `echo hook >> ${fLeaveHook}` }],
  }
  await run(chart, "s")
  expect(readFileSync(fOnLeave, "utf8").trim()).toBe("inline")
  expect(readFileSync(fLeaveHook, "utf8").trim()).toBe("hook")
})
