// tests/schema.test.ts
import { test, expect, beforeEach } from "bun:test"
import { z } from "zod"
import { parseChart } from "../src/schema"
import { registerNodeType, clearRegistry } from "../src/registry"

beforeEach(() => {
  clearRegistry()
  registerNodeType({ type: "shell", configSchema: z.object({ on_enter: z.string() }), run: async () => ({}) })
  registerNodeType({ type: "end", configSchema: z.object({ outcome: z.string() }), run: async () => ({}) })
})

const good = `
name: tiny
nodes:
  - id: a
    type: shell
    config: { on_enter: "echo hi" }
  - id: b
    type: end
    config: { outcome: success }
edges:
  - { from: a, to: b, name: done }
`

test("parses a valid chart", () => {
  const chart = parseChart(good)
  expect(chart.name).toBe("tiny")
  expect(chart.nodes).toHaveLength(2)
  expect(chart.edges[0].name).toBe("done")
})

test("rejects edge referencing unknown node", () => {
  const bad = good.replace("to: b", "to: ghost")
  expect(() => parseChart(bad)).toThrow(/unknown node/)
})

test("rejects duplicate node ids", () => {
  const bad = good.replace("id: b", "id: a")
  expect(() => parseChart(bad)).toThrow(/duplicate node id/)
})

test("rejects unknown node type", () => {
  const bad = good.replace("type: shell", "type: wat")
  expect(() => parseChart(bad)).toThrow(/unknown node type/)
})

test("rejects invalid per-type config", () => {
  const bad = good.replace('config: { on_enter: "echo hi" }', "config: {}")
  expect(() => parseChart(bad)).toThrow()
})

test("parses optional node description and doc", () => {
  const withDocs = good.replace(
    "    type: shell\n",
    '    type: shell\n    description: "Compiles the project and uploads artifacts."\n    doc: "https://runbooks/build"\n',
  )
  const chart = parseChart(withDocs)
  expect(chart.nodes[0].description).toBe("Compiles the project and uploads artifacts.")
  expect(chart.nodes[0].doc).toBe("https://runbooks/build")
  // omitting them leaves the fields undefined, not an error
  expect(chart.nodes[1].description).toBeUndefined()
})
