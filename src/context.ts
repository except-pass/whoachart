// src/context.ts
import { writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Marble, ChartNode } from "./types"

export interface ActivityOutput {
  exitCode: number
  stdout: string
  stderr: string
  next?: string
  merge?: Record<string, unknown>
}

export function buildEnv(marble: Marble, node: ChartNode, contextPath: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    WHOACHART_MARBLE: marble.id,
    WHOACHART_NODE: node.id,
    WHOACHART_CONTEXT: contextPath,
    WHOACHART_WORKSPACE: marble.workpiece ?? "",
  }
}

export function parseEmit(stdout: string): { next?: string; merge?: Record<string, unknown> } {
  const lines = stdout.trimEnd().split("\n")
  const last = lines[lines.length - 1]?.trim()
  if (!last) return {}
  try {
    const obj = JSON.parse(last)
    if (obj && typeof obj === "object") {
      const next = typeof obj.next === "string" ? obj.next : undefined
      const merge = obj.merge && typeof obj.merge === "object" ? (obj.merge as Record<string, unknown>) : undefined
      return { next, merge }
    }
  } catch {
    // last line is not JSON — no emit, that's fine
  }
  return {}
}

export async function runShell(
  script: string,
  marble: Marble,
  node: ChartNode,
  signal?: AbortSignal,
): Promise<ActivityOutput> {
  const ctxPath = join(tmpdir(), `whoachart-ctx-${marble.id}-${node.id}.json`)
  await writeFile(ctxPath, JSON.stringify(marble.context))

  try {
    const proc = Bun.spawn(["bash", "-c", script], {
      env: buildEnv(marble, node, ctxPath),
      stdout: "pipe",
      stderr: "pipe",
    })
    // Kill the bash process when the node's timeout aborts the signal, so a
    // timed-out activity can't keep running (and producing side effects).
    const onAbort = () => proc.kill()
    if (signal?.aborted) proc.kill()
    else signal?.addEventListener("abort", onAbort, { once: true })

    try {
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      const { next, merge } = parseEmit(stdout)
      return { exitCode, stdout, stderr, next, merge }
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  } finally {
    await unlink(ctxPath).catch(() => {})
  }
}
