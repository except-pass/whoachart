// tests/forms.test.ts
import { test, expect, beforeEach } from "bun:test"
import { validateForm, FormError, formFieldSchema } from "../src/forms"
import { parseChart } from "../src/schema"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry, getNodeType, hasNodeType } from "../src/registry"
import type { FormField } from "../src/types"

beforeEach(() => { clearRegistry(); registerBuiltins() })

const FORM: FormField[] = [
  { key: "title", type: "text", required: true },
  { key: "priority", type: "enum", options: ["low", "med", "high"], default: "med" },
  { key: "copies", type: "number", min: 1, default: 1 },
  { key: "rush", type: "boolean" },
]

test("valid values pass, defaults apply, numbers coerce", () => {
  const out = validateForm(FORM, { title: "x", copies: "3", rush: "true" })
  expect(out).toEqual({ title: "x", copies: 3, rush: true, priority: "med" })
})

test("missing required + bad enum + out-of-range report per-field errors", () => {
  try {
    validateForm(FORM, { priority: "urgent", copies: 0 })
    throw new Error("should have thrown")
  } catch (err) {
    expect(err).toBeInstanceOf(FormError)
    const fields = (err as FormError).fields
    expect(fields.title).toBe("required")
    expect(fields.priority).toContain("one of")
    expect(fields.copies).toContain(">= 1")
  }
})

test("enum field without options is rejected at schema level", () => {
  expect(() => formFieldSchema.parse({ key: "x", type: "enum" })).toThrow(/options/)
})

test("chart YAML accepts form/present/stuck_after and the human node blocks", async () => {
  const chart = parseChart(`
name: g
nodes:
  - id: ingest
    type: source
    config:
      trigger: api
      form:
        - { key: title, type: text, required: true }
  - id: gate
    type: human
    stuck_after: 120
    present:
      - { key: title, as: text }
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: gate }
  - { from: gate, to: done, name: ok,
      form: [ { key: note, type: textarea, required: true } ] }
`)
  expect(hasNodeType("human")).toBe(true)
  const gate = chart.nodes.find((n) => n.id === "gate")!
  expect(gate.stuck_after).toBe(120)
  expect(gate.present![0]).toEqual({ key: "title", as: "text" })
  expect(chart.edges[1].form![0].key).toBe("note")
  const r = await getNodeType("human").run({
    chart, node: gate, outgoing: [],
    marble: { id: "m", chart: "g", node: "gate", context: {}, history: ["gate"], status: "running", createdAt: "t", updatedAt: "t" },
  })
  expect(r.block).toBe(true)
})
