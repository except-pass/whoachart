// tests/hookSchema.test.ts — chart-level `hooks:` parsing/validation (U1).
// parseChart validates node config via the registry, so register the two builtins
// the fixture charts use. Hook validation is structural here; matcher-vs-chart
// cross-checks are lintChart's advisory job (see tests/lint.test.ts).
import { test, expect, beforeEach } from "bun:test"
import { z } from "zod"
import { parseChart } from "../src/schema"
import { registerNodeType, clearRegistry } from "../src/registry"

beforeEach(() => {
  clearRegistry()
  registerNodeType({ type: "source", configSchema: z.object({}).passthrough(), run: async () => ({}) })
  registerNodeType({ type: "end", configSchema: z.object({ outcome: z.string() }), run: async () => ({}) })
})

function chartWith(hooksYaml: string): string {
  return `
name: hooked
nodes:
  - { id: s, type: source, config: {} }
  - { id: done, type: end, config: { outcome: success } }
edges:
  - { from: s, to: done, name: go }
hooks:
${hooksYaml}
`
}

test("a valid hooks list round-trips every field", () => {
  const chart = parseChart(
    chartWith(
      `  - { on: start, run: "echo start" }
  - { on: enter, node: done, run: "./notify.sh", timeout: 5000 }
  - { on: traverse, edge: go, run: "echo edge" }`,
    ),
  )
  expect(chart.hooks).toHaveLength(3)
  expect(chart.hooks![0]).toEqual({ on: "start", run: "echo start" })
  expect(chart.hooks![1]).toEqual({ on: "enter", node: "done", run: "./notify.sh", timeout: 5000 })
  expect(chart.hooks![2]).toEqual({ on: "traverse", edge: "go", run: "echo edge" })
})

test("a chart with no hooks key parses unchanged", () => {
  const chart = parseChart(`
name: plain
nodes:
  - { id: s, type: source, config: {} }
  - { id: done, type: end, config: { outcome: success } }
edges:
  - { from: s, to: done }
`)
  expect(chart.hooks).toBeUndefined()
})

test("an unknown `on` value is rejected", () => {
  expect(() => parseChart(chartWith(`  - { on: explode, run: "echo x" }`))).toThrow()
})

test("a missing or empty run command is rejected", () => {
  expect(() => parseChart(chartWith(`  - { on: enter }`))).toThrow()
  expect(() => parseChart(chartWith(`  - { on: enter, run: "" }`))).toThrow()
})

test("a non-positive timeout is rejected", () => {
  expect(() => parseChart(chartWith(`  - { on: enter, run: "echo x", timeout: 0 }`))).toThrow()
  expect(() => parseChart(chartWith(`  - { on: enter, run: "echo x", timeout: -5 }`))).toThrow()
})

test("edge matcher is only valid with on: traverse", () => {
  expect(() => parseChart(chartWith(`  - { on: enter, edge: go, run: "echo x" }`))).toThrow()
  // edge on traverse is fine
  expect(parseChart(chartWith(`  - { on: traverse, edge: go, run: "echo x" }`)).hooks).toHaveLength(1)
})

test("node matcher is accepted on node-scoped events and on start", () => {
  for (const ev of ["start", "enter", "leave", "blocked", "failed", "end"]) {
    const chart = parseChart(chartWith(`  - { on: ${ev}, node: done, run: "echo x" }`))
    expect(chart.hooks![0].node).toBe("done")
  }
})
