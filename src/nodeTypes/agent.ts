import { z } from "zod"
import type { NodeType } from "../registry"
import type { SessionLauncher } from "../tinstar"
import type { Marble, ChartNode } from "../types"

export function buildBrief(
  marble: Marble,
  node: ChartNode,
  job: string,
  edges: string[],
  signalUrl: string,
): string {
  return [
    `You are an automated specialist working ONE step of a whoachart flow.`,
    `Work item (marble): ${marble.id} on chart "${marble.chart}", at step "${node.name ?? node.id}".`,
    marble.workpiece ? `Workpiece: ${marble.workpiece}` : "",
    `Context so far: ${JSON.stringify(marble.context)}`,
    ``,
    `Your job (do ONLY this): ${job}`,
    ``,
    `When finished, choose the next edge — one of: ${edges.join(", ")} — and signal completion:`,
    `  curl -X POST ${signalUrl} -H 'Content-Type: application/json' -d '{"next":"<edge>","merge":{"<key>":"<your findings>"}}'`,
    `Use "merge" to hand findings to later steps. Your session may be stopped after you signal.`,
  ].filter(Boolean).join("\n")
}

export const agentConfigSchema = z.object({
  brief: z.string(),
  cli_template: z.string().optional(),
  project: z.string().optional(),
  keep_session: z.boolean().default(false),
})

// Schema-only registration for chart parsing/config validation. The wiring
// (launcher + signal URL) is per-daemon, so the global registry must NOT
// capture it — each Daemon supplies a wired run via the engine's instance-scoped
// node-type overrides (see makeAgentNode). This run throws if a chart is run
// without that wiring (e.g. the headless runner, which has no launcher).
export const agentSchemaNode: NodeType = {
  type: "agent",
  configSchema: agentConfigSchema,
  async run() {
    throw new Error("agent node has no launcher wired (run it through a Daemon)")
  },
}

// Factory: the launcher and signal-URL builder are injected so tests use a
// fake and production uses TinstarClient.
export function makeAgentNode(
  launcher: SessionLauncher,
  signalUrlFor: (m: Marble) => string,
): NodeType {
  return {
    type: "agent",
    configSchema: agentConfigSchema,
    async run(ctx) {
      // keep_session is read by Daemon.signal (session teardown), not here; the
      // cast mirrors the full schema so the omission is intentional, not a miss.
      const cfg = ctx.node.config as { brief: string; cli_template?: string; project?: string; keep_session?: boolean }
      const edges = ctx.outgoing.map((e) => e.name ?? e.to)
      const name = `wc-${ctx.marble.chart}-${ctx.marble.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")
      const { name: sessionName } = await launcher.spawnSession({
        name,
        prompt: buildBrief(ctx.marble, ctx.node, cfg.brief, edges, signalUrlFor(ctx.marble)),
        color: ctx.node.color,
        project: cfg.project,
        cliTemplate: cfg.cli_template,
      })
      // _session is reserved in context: the live session working this marble.
      return { block: true, merge: { _session: sessionName } }
    },
  }
}
