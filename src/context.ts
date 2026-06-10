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

// Stream type for live output chunks. "stdout"/"stderr" come from the activity
// process; the engine adds "event" lines for lifecycle.
export type LogStream = "stdout" | "stderr"

// Read a piped stream to completion, invoking onLine for each COMPLETE line as
// it arrives (line-buffered live streaming, not buffer-to-exit), and returning
// the full accumulated text for parseEmit / the ActivityOutput.
async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  which: LogStream,
  onLine?: (stream: LogStream, line: string) => void,
): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let pending = ""
  let full = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const text = dec.decode(value, { stream: true })
    full += text
    pending += text
    let nl: number
    while ((nl = pending.indexOf("\n")) >= 0) {
      onLine?.(which, pending.slice(0, nl))
      pending = pending.slice(nl + 1)
    }
  }
  const tail = dec.decode()
  if (tail) { full += tail; pending += tail }
  if (pending.length) onLine?.(which, pending) // final line without a trailing newline
  return full
}

// Run a shell activity. onLine (if given) receives each stdout/stderr line live
// as the process emits it — used to stream node execution into the inspector.
//
// SECURITY: raw stdout/stderr is forwarded VERBATIM to onLine (and from there to
// the tailnet-reachable /nodes/:id/logs feed). It is NOT content-redacted —
// free-text output can't be reliably scrubbed the way structured /def config
// keys are. This is safe ONLY on the current loopback + Tailscale trust surface
// (see netGuard). Before the control plane goes multi-user this must be revisited
// (tracked with the /def redaction residuals — same trust-surface trigger).
export async function runShell(
  script: string,
  marble: Marble,
  node: ChartNode,
  signal?: AbortSignal,
  onLine?: (stream: LogStream, line: string) => void,
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
      // Drain both pipes concurrently so neither blocks the other on a full buffer.
      const [stdout, stderr] = await Promise.all([
        pumpStream(proc.stdout, "stdout", onLine),
        pumpStream(proc.stderr, "stderr", onLine),
      ])
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
