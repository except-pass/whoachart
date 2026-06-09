import { z } from "zod"
import type { NodeType } from "../registry"

// A source defines how marbles enter (the control API reads `trigger`).
// Inside the engine loop it is a pass-through: auto-advance to its successor.
export const sourceNode: NodeType = {
  type: "source",
  configSchema: z.object({
    trigger: z.enum(["api", "manual"]).default("api"),
    template: z.record(z.unknown()).optional(),
  }),
  async run() {
    return {}
  },
}
