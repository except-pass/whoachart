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

test("NON-BLOCKING: a slow hook does not delay the marble reaching done", async () => {
  const dir = tmp()
  const r = await run(linear([{ on: "start", run: `sleep 1; echo done >> ${join(dir, "slow")}` }]), "s")
  // Marble completed near-instantly even though the start hook sleeps 1s.
  expect(r.doneAtMs).toBeDefined()
  // drain() (which DID wait for the hook) only returns after the sleep, so the
  // file exists now — but the marble's own completion was recorded far earlier.
  expect(existsSync(join(dir, "slow"))).toBe(true)
})

test("drain() awaits outstanding hooks (slow hook's output is present after drain)", async () => {
  const dir = tmp()
  const f = join(dir, "drained")
  await run(linear([{ on: "end", run: `sleep 0.2; echo settled >> ${f}` }]), "s")
  expect(readFileSync(f, "utf8").trim()).toBe("settled")
})

test("hook stdout streams into the per-node log feed (R7)", async () => {
  const r = await run(linear([{ on: "enter", node: "s", run: "echo streamed-line" }]), "s")
  const hit = r.log.find((l) => l.stream === "stdout" && l.line === "streamed-line")
  expect(hit?.node).toBe("s")
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
