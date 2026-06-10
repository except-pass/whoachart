// tests/context.test.ts
import { test, expect } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { stat } from "node:fs/promises"
import { parseEmit, runShell } from "../src/context"
import type { Marble, ChartNode } from "../src/types"

const node: ChartNode = { id: "a", type: "shell", config: {} }
function marble(): Marble {
  return { id: "m", chart: "c", node: "a", context: { from: "ctx" }, history: ["a"], status: "running", createdAt: "t", updatedAt: "t" }
}

test("parseEmit reads next + merge from trailing JSON line", () => {
  const out = parseEmit('some log\nmore log\n{"next":"ok","merge":{"x":2}}')
  expect(out.next).toBe("ok")
  expect(out.merge).toEqual({ x: 2 })
})

test("parseEmit ignores non-JSON output", () => {
  expect(parseEmit("just logs\nno json here")).toEqual({})
})

test("runShell captures exit code and parses emit", async () => {
  const out = await runShell(`echo hello; echo '{"next":"go"}'`, marble(), node)
  expect(out.exitCode).toBe(0)
  expect(out.next).toBe("go")
})

test("runShell reports nonzero exit", async () => {
  const out = await runShell(`exit 3`, marble(), node)
  expect(out.exitCode).toBe(3)
})

test("runShell exposes context + ids via env", async () => {
  const out = await runShell(`cat "$WHOACHART_CONTEXT"; echo " node=$WHOACHART_NODE"`, marble(), node)
  expect(out.stdout).toContain("ctx")
  expect(out.stdout).toContain("node=a")
})

test("runShell streams stdout lines LIVE (mid-execution), not buffered to exit", async () => {
  const got: string[] = []
  let firstResolve: () => void
  const firstSeen = new Promise<void>((r) => { firstResolve = r })
  const onLine = (_stream: "stdout" | "stderr", line: string) => {
    got.push(line)
    if (line === "first") firstResolve()
  }
  // "second" is gated behind a 0.3s sleep. If runShell buffered to completion,
  // onLine would fire for both at once AFTER the sleep — so firstSeen would only
  // resolve with "second" already present. Streaming makes "first" arrive
  // immediately, before "second" exists.
  const p = runShell(`echo first; sleep 0.3; echo second`, marble(), node, undefined, onLine)
  await firstSeen
  expect(got).toContain("first")
  expect(got).not.toContain("second")
  const out = await p
  expect(got).toContain("second") // and the rest still streams through
  expect(out.stdout).toContain("first") // full text still returned for parseEmit
  expect(out.stdout).toContain("second")
})

test("runShell tags stderr lines distinctly and flushes a final newline-less line", async () => {
  const got: { s: string; l: string }[] = []
  const out = await runShell(
    `echo out1; echo err1 1>&2; printf 'no-newline-tail'`,
    marble(), node, undefined, (s, l) => got.push({ s, l }),
  )
  expect(got).toContainEqual({ s: "stdout", l: "out1" })
  expect(got).toContainEqual({ s: "stderr", l: "err1" })
  expect(got).toContainEqual({ s: "stdout", l: "no-newline-tail" }) // partial last line flushed
  expect(out.stdout).toContain("no-newline-tail")
})

test("runShell strips the trailing CR from CRLF output", async () => {
  const got: string[] = []
  await runShell(`printf 'win\\r\\nlines\\r\\n'`, marble(), node, undefined, (_s, l) => got.push(l))
  expect(got).toEqual(["win", "lines"]) // no stray \r left on either line
})

test("runShell kills the process when the signal aborts (no orphan side effects)", async () => {
  const marker = join(tmpdir(), `whoachart-kill-${crypto.randomUUID().slice(0, 8)}`)
  const ctrl = new AbortController()
  // Abort shortly after spawn; the script would write the marker at 1s if it
  // were allowed to keep running past the deadline.
  setTimeout(() => ctrl.abort(), 50)
  const out = await runShell(`sleep 1 && touch "${marker}"`, marble(), node, ctrl.signal)
  // runShell must RESOLVE after the kill (proc.exited fires on SIGTERM), not hang.
  expect(out).toBeDefined()

  // Give the (killed) process well past its 1s sleep to prove it never ran on.
  await new Promise((r) => setTimeout(r, 1200))
  await expect(stat(marker)).rejects.toThrow() // marker absent → process was killed
})
