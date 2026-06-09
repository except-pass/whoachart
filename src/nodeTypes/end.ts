import { z } from "zod"
import type { NodeType } from "../registry"

export const endNode: NodeType = {
  type: "end",
  configSchema: z.object({
    outcome: z.enum(["success", "fail", "warning"]).default("success"),
  }),
  async run(ctx) {
    const cfg = ctx.node.config as { outcome: "success" | "fail" | "warning" }
    return { end: true, endOutcome: cfg.outcome }
  },
}
