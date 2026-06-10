// src/nodeTypes/human.ts
import { z } from "zod"
import type { NodeType } from "../registry"

// A human gate: the marble blocks here until a person (or a forcing caller)
// signals an edge. Presentation/decision UX comes from the node's universal
// `present` field and the outgoing edges' `form`s.
export const humanNode: NodeType = {
  type: "human",
  configSchema: z.object({}).passthrough(),
  async run() {
    return { block: true }
  },
}
