// tests/contextHook.test.ts — runHookCommand (U2): payload (env + JSON stdin),
// timeout, exit-code pass-through, and the per-invocation temp-path race.
import { test, expect } from "bun:test"
import { runHookCommand, type HookFire } from "../src/context"
import type { Marble, ChartNode, ActivityStream } from "../src/types"

function marble(over: Partial<Marble> = {}): Marble {
  const t = "2026-06-29T00:00:00.000Z"
  return {
    id: "m1", chart: "c", node: "n1", context: { foo: "bar" },
    history: ["n1"], status: "running", createdAt: t, updatedAt: t, ...over,
  }
}
function node(over: Partial<ChartNode> = {}): ChartNode {
  return { id: "n1", type: "shell", config: {}, ...over }
}

// Collect onLine output into a single joined string per stream.
function sink() {
  const lines: { stream: ActivityStream; line: string }[] = []
  const onLine = (stream: ActivityStream, line: string) => lines.push({ stream, line })
  return {
    onLine,
    out: () => lines.filter((l) => l.stream === "stdout").map((l) => l.line).join("\n"),
    err: () => lines.filter((l) => l.stream === "stderr").map((l) => l.line).join("\n"),
  }
}

const base = (over: Partial<HookFire>): HookFire => ({
  script: "true", event: "enter", chart: "c", marble: marble(), node: node(), timeoutMs: 5000, ...over,
})

test("hook receives event/node/chart as env vars", async () => {
  const s = sink()
  const r = await runHookCommand(base({ script: 'echo "$WHOACHART_EVENT|$WHOACHART_NODE|$WHOACHART_CHART"', event: "blocked", onLine: s.onLine }))
  expect(r.exitCode).toBe(0)
  expect(s.out()).toBe("blocked|n1|c")
})

test("hook receives the JSON event payload on stdin", async () => {
  const s = sink()
  await runHookCommand(base({ script: "cat", event: "enter", marble: marble({ id: "mX", context: { k: 1 } }), onLine: s.onLine }))
  const payload = JSON.parse(s.out())
  expect(payload.event).toBe("enter")
  expect(payload.marble.id).toBe("mX")
  expect(payload.marble.context).toEqual({ k: 1 })
  expect(payload.node.id).toBe("n1")
})

test("WHOACHART_CONTEXT points at a readable JSON file of the marble context", async () => {
  const s = sink()
  await runHookCommand(base({ script: "cat \"$WHOACHART_CONTEXT\"", marble: marble({ context: { hello: "world" } }), onLine: s.onLine }))
  expect(JSON.parse(s.out())).toEqual({ hello: "world" })
})

test("traverse fire exposes edge env + payload; end fire exposes outcome", async () => {
  const t = sink()
  const tr = await runHookCommand(base({
    script: 'echo "$WHOACHART_EDGE|$WHOACHART_FROM|$WHOACHART_TO"',
    event: "traverse", edge: { name: "rejected", from: "a", to: "b" }, onLine: t.onLine,
  }))
  expect(tr.exitCode).toBe(0)
  expect(t.out()).toBe("rejected|a|b")

  const e = sink()
  await runHookCommand(base({ script: 'echo "$WHOACHART_OUTCOME"; cat', event: "end", outcome: "fail", onLine: e.onLine }))
  const lines = e.out().split("\n")
  expect(lines[0]).toBe("fail")
  expect(JSON.parse(lines.slice(1).join("\n")).outcome).toBe("fail")
})

test("a hook that overruns its timeout is killed and reported", async () => {
  const start = Bun.nanoseconds()
  const r = await runHookCommand(base({ script: "sleep 5", timeoutMs: 150 }))
  const elapsedMs = (Bun.nanoseconds() - start) / 1e6
  expect(r.timedOut).toBe(true)
  expect(elapsedMs).toBeLessThan(2000) // killed well before the 5s sleep
})

test("a non-zero exit is passed through, not thrown", async () => {
  const r = await runHookCommand(base({ script: "exit 3" }))
  expect(r.exitCode).toBe(3)
  expect(r.timedOut).toBe(false)
})

test("stderr lines reach onLine", async () => {
  const s = sink()
  await runHookCommand(base({ script: "echo oops 1>&2", onLine: s.onLine }))
  expect(s.err()).toBe("oops")
})

test("four hooks for the same (marble,node) run concurrently without a temp-file race", async () => {
  // Each reads its own WHOACHART_CONTEXT file mid-run; a shared path would ENOENT.
  const mk = () => runHookCommand(base({ script: "cat \"$WHOACHART_CONTEXT\" > /dev/null; echo ok", marble: marble({ id: "same", node: "same" }), node: node({ id: "same" }) }))
  const results = await Promise.all([mk(), mk(), mk(), mk()])
  for (const r of results) expect(r.exitCode).toBe(0) // a race on invocation 3/4 would surface here
})

test("an unnamed traversal sets WHOACHART_FROM/TO but not WHOACHART_EDGE", async () => {
  const s = sink()
  await runHookCommand(base({ script: 'echo "[${WHOACHART_EDGE-unset}|$WHOACHART_FROM|$WHOACHART_TO]"', event: "traverse", edge: { from: "a", to: "b" }, onLine: s.onLine }))
  expect(s.out()).toBe("[unset|a|b]")
})

// --- timeout is a HARD ceiling regardless of how the hook holds its pipes ---
// (Regression for the pipeline/backgrounded/trap-TERM wedge: a grandchild holding
// the stdout fd, or a TERM-ignoring shell, must not let the hook outlive timeout.)
test("a pipeline hook is bounded by its timeout even though a grandchild holds the pipe", async () => {
  const t0 = Bun.nanoseconds()
  const r = await runHookCommand(base({ script: "sleep 9 | cat", timeoutMs: 200 }))
  const elapsedMs = (Bun.nanoseconds() - t0) / 1e6
  expect(r.timedOut).toBe(true)
  expect(elapsedMs).toBeLessThan(2000) // not ~9000ms (the natural pipeline runtime)
})

test("a backgrounded child does not keep the hook alive past the shell's exit", async () => {
  const t0 = Bun.nanoseconds()
  const r = await runHookCommand(base({ script: "sleep 9 & exit 0", timeoutMs: 5000 }))
  const elapsedMs = (Bun.nanoseconds() - t0) / 1e6
  expect(r.exitCode).toBe(0)
  expect(elapsedMs).toBeLessThan(2000) // resolves on the shell's exit, not the 9s child
})

test("a hook that ignores SIGTERM is force-killed (SIGKILL escalation)", async () => {
  const t0 = Bun.nanoseconds()
  const r = await runHookCommand(base({ script: "trap '' TERM; sleep 9", timeoutMs: 200 }))
  const elapsedMs = (Bun.nanoseconds() - t0) / 1e6
  expect(r.timedOut).toBe(true)
  expect(elapsedMs).toBeLessThan(4000) // killed via SIGKILL after the grace, not 9s
})
