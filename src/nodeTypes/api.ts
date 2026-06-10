import { z } from "zod"
import type { NodeType } from "../registry"

export const apiNode: NodeType = {
  type: "api",
  configSchema: z.object({
    request: z.object({
      method: z.string().default("GET"),
      url: z.string(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
    }),
    next_on_ok: z.string().optional(),
    next_on_error: z.string().optional(),
  }),
  async run(ctx) {
    const cfg = ctx.node.config as {
      request: { method: string; url: string; headers?: Record<string, string>; body?: string }
      next_on_ok?: string
      next_on_error?: string
    }
    const res = await fetch(cfg.request.url, {
      method: cfg.request.method,
      headers: cfg.request.headers,
      body: cfg.request.body,
      signal: ctx.signal,
    })
    const text = await res.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text }
    return {
      merge: { [`${ctx.node.id}_response`]: data, [`${ctx.node.id}_status`]: res.status },
      failed: !res.ok,
      next: res.ok ? cfg.next_on_ok : cfg.next_on_error,
    }
  },
}
