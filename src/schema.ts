// src/schema.ts
import { z } from "zod"
import { parse as parseYaml } from "yaml"
import type { Chart } from "./types"
import { getNodeType } from "./registry"
import { formFieldSchema } from "./forms"
import { parseCron, everyToMs } from "./cron"

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
  decider: z.enum(["human", "agent"]).optional(),
  on_leave: z.string().optional(),
  retry: z.object({ max: z.number().int().nonnegative() }).optional(),
  timeout: z.number().int().positive().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  stuck_after: z.number().int().positive().optional(),
  present: z
    .array(
      z.object({
        key: z.string(),
        as: z.enum(["markdown", "markdown_file", "json", "text", "link"]).default("text"),
        // PRIMARY entries render prominently at the top of the gate (the
        // decision itself); the rest demote to a collapsible evidence footer.
        primary: z.boolean().optional(),
      }),
    )
    .optional(),
  config: z.record(z.unknown()).default({}),
})

const triggerSchema = z
  .object({
    cron: z.string().optional(),
    every: z.string().optional(),
    webhook: z.string().regex(/^[A-Za-z0-9_-]+$/, "webhook id must be [A-Za-z0-9_-]").optional(),
    start: z.string(),
    context: z.record(z.unknown()).optional(),
  })
  .superRefine((t, ctx) => {
    const set = [t.cron, t.every, t.webhook].filter((x) => x !== undefined).length
    if (set !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "trigger must set exactly one of cron, every, webhook" })
    }
  })

const supervisorSchema = z.object({
  brief: z.string(),
  cli_template: z.string().optional(),
  project: z.string().optional(),
})

const hookSchema = z
  .object({
    on: z.enum(["start", "enter", "leave", "traverse", "blocked", "failed", "end"]),
    node: z.string().optional(),
    edge: z.string().optional(),
    run: z.string().min(1, "hook run command must be non-empty"),
    timeout: z.number().int().positive().optional(),
  })
  .superRefine((h, ctx) => {
    // `edge` scopes only edge traversals; using it elsewhere is almost certainly a
    // mistake, so reject it structurally. Whether `node`/`edge` name a real
    // node/edge is left to lintChart (advisory) so a typo never rejects the chart.
    if (h.edge !== undefined && h.on !== "traverse") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `hook edge matcher is only valid with on: traverse (got on: ${h.on})` })
    }
  })

const chartSchema = z.object({
  name: z.string(),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
  triggers: z.array(triggerSchema).optional(),
  supervisor: supervisorSchema.optional(),
  hooks: z.array(hookSchema).optional(),
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
  // Trigger cross-checks: start must name a source node; webhook ids unique.
  const sourceIds = new Set(chart.nodes.filter((n) => n.type === "source").map((n) => n.id))
  const hookIds = new Set<string>()
  for (const t of chart.triggers ?? []) {
    if (!sourceIds.has(t.start)) throw new Error(`trigger start must name a source node: ${t.start}`)
    // Validate the schedule expression NOW, so a bad cron/every is rejected at
    // parse time (before any disk write or runtime swap) rather than throwing
    // late inside Scheduler.arm() — which would half-install a runtime or leave
    // two engines on one marble store on the update path.
    if (t.cron !== undefined) parseCron(t.cron)
    if (t.every !== undefined) everyToMs(t.every)
    if (t.webhook) {
      if (hookIds.has(t.webhook)) throw new Error(`duplicate webhook id: ${t.webhook}`)
      hookIds.add(t.webhook)
    }
  }
  // validate + normalize each node's typed config block
  for (const n of chart.nodes) {
    const nt = getNodeType(n.type) // throws "unknown node type" if missing
    n.config = nt.configSchema.parse(n.config ?? {})
  }
  return chart as Chart
}
