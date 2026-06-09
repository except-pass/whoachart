import { test, expect, beforeEach } from "bun:test"
import { registerBuiltins } from "../src/nodeTypes"
import { getNodeType, clearRegistry, hasNodeType } from "../src/registry"
import type { RunCtx, Marble, ChartNode } from "../src/types"

beforeEach(() => { clearRegistry(); registerBuiltins() })

function ctx(node: ChartNode): RunCtx {
  const marble: Marble = { id: "m", chart: "c", node: node.id, context: {}, history: [node.id], status: "running", createdAt: "t", updatedAt: "t" }
  return { chart: { name: "c", nodes: [node], edges: [] }, marble, node, outgoing: [] }
}

test("builtins are registered", () => {
  for (const t of ["end", "source", "shell", "decision", "api"]) expect(hasNodeType(t)).toBe(true)
})

test("end node returns terminal result with outcome", async () => {
  const node: ChartNode = { id: "e", type: "end", config: { outcome: "success" } }
  const r = await getNodeType("end").run(ctx(node))
  expect(r.end).toBe(true)
  expect(r.endOutcome).toBe("success")
})

test("source node is a pass-through", async () => {
  const node: ChartNode = { id: "s", type: "source", config: { trigger: "api" } }
  const r = await getNodeType("source").run(ctx(node))
  expect(r.end).toBeUndefined()
  expect(r.next).toBeUndefined()
})

test("shell node runs script and surfaces next + failed", async () => {
  const ok: ChartNode = { id: "a", type: "shell", config: { on_enter: `echo '{"next":"go"}'` } }
  expect((await getNodeType("shell").run(ctx(ok))).next).toBe("go")
  const bad: ChartNode = { id: "b", type: "shell", config: { on_enter: `exit 1` } }
  expect((await getNodeType("shell").run(ctx(bad))).failed).toBe(true)
})

test("decision node runs routing script and emits next", async () => {
  const node: ChartNode = { id: "d", type: "decision", config: { on_enter: `echo '{"next":"left"}'` } }
  expect((await getNodeType("decision").run(ctx(node))).next).toBe("left")
})
