import { z } from "zod"
import type { NodeType } from "../registry"
import { runShell } from "../context"

// A decision is pure routing: a script whose only job is to emit `next`.
// (Rendered as a diamond by the view layer in Plan 2.)
export const decisionNode: NodeType = {
  type: "decision",
  configSchema: z.object({ on_enter: z.string() }),
  async run(ctx) {
    const cfg = ctx.node.config as { on_enter: string }
    const out = await runShell(cfg.on_enter, ctx.marble, ctx.node, ctx.signal, ctx.log)
    return { next: out.next, merge: out.merge, failed: out.exitCode !== 0 }
  },
}
