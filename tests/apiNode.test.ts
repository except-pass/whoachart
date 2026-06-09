import { test, expect, beforeEach, afterEach } from "bun:test"
import { registerBuiltins } from "../src/nodeTypes"
import { getNodeType, clearRegistry } from "../src/registry"
import type { RunCtx, Marble, ChartNode } from "../src/types"

let server: ReturnType<typeof Bun.serve>
let base: string

beforeEach(() => {
  clearRegistry(); registerBuiltins()
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/ok") return Response.json({ pong: true })
      return new Response("boom", { status: 500 })
    },
  })
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

function ctx(node: ChartNode): RunCtx {
  const marble: Marble = { id: "m", chart: "c", node: node.id, context: {}, history: [node.id], status: "running", createdAt: "t", updatedAt: "t" }
  return { chart: { name: "c", nodes: [node], edges: [] }, marble, node, outgoing: [] }
}

test("api node merges JSON response and marks success", async () => {
  const node: ChartNode = { id: "h", type: "api", config: { request: { method: "GET", url: `${base}/ok` } } }
  const r = await getNodeType("api").run(ctx(node))
  expect(r.failed).toBe(false)
  expect((r.merge as any).h_response.pong).toBe(true)
})

test("api node flags failed on non-2xx", async () => {
  const node: ChartNode = { id: "h", type: "api", config: { request: { method: "GET", url: `${base}/err` } } }
  const r = await getNodeType("api").run(ctx(node))
  expect(r.failed).toBe(true)
})
