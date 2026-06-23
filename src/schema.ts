// src/schema.ts
import { z } from "zod"
import { parse as parseYaml } from "yaml"
import type { Chart } from "./types"
import { getNodeType } from "./registry"
import { formFieldSchema } from "./forms"

const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  name: z.string().optional(),
  on_traversal: z.string().optional(),
  default: z.boolean().optional(),
  form: z.array(formFieldSchema).optional(),
})

const nodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  doc: z.string().optional(),
  color: z.string().optional(),
  on_leave: z.string().optional(),
  retry: z.object({ max: z.number().int().nonnegative() }).optional(),
  timeout: z.number().int().positive().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  stuck_after: z.number().int().positive().optional(),
  present: z
    .array(z.object({ key: z.string(), as: z.enum(["markdown", "json", "text", "link"]).default("text") }))
    .optional(),
  config: z.record(z.unknown()).default({}),
})

const chartSchema = z.object({
  name: z.string(),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
})

export function parseChart(yamlText: string): Chart {
  const raw = parseYaml(yamlText)
  const chart = chartSchema.parse(raw)

  const ids = new Set<string>()
  for (const n of chart.nodes) {
    if (ids.has(n.id)) throw new Error(`duplicate node id: ${n.id}`)
    ids.add(n.id)
  }
  for (const e of chart.edges) {
    if (!ids.has(e.from)) throw new Error(`edge references unknown node (from): ${e.from}`)
    if (!ids.has(e.to)) throw new Error(`edge references unknown node (to): ${e.to}`)
  }
  // validate + normalize each node's typed config block
  for (const n of chart.nodes) {
    const nt = getNodeType(n.type) // throws "unknown node type" if missing
    n.config = nt.configSchema.parse(n.config ?? {})
  }
  return chart as Chart
}
