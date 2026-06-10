import { z } from "zod"
import type { NodeType } from "../registry"
import { runShell } from "../context"

export const shellNode: NodeType = {
  type: "shell",
  configSchema: z.object({ on_enter: z.string() }),
  async run(ctx) {
    const cfg = ctx.node.config as { on_enter: string }
    const out = await runShell(cfg.on_enter, ctx.marble, ctx.node, ctx.signal)
    return { next: out.next, merge: out.merge, failed: out.exitCode !== 0 }
  },
}
