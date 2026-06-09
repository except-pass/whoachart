// tests/context.test.ts
import { test, expect } from "bun:test"
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
