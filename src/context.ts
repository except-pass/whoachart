// src/context.ts
import { writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Marble, ChartNode, ActivityStream, HookEvent } from "./types"

// Default ceiling for a hook command (ms). Bounds the fire-and-forget run so a
// hung hook can't leak a process or stall engine drain; a per-hook `timeout`
// overrides it.
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000

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
    // Tinstar space id the daemon confined this run to (WHOACHART_SPACE),
    // empty when unset. Chart scripts that create canvas entities can pass
    // this as spaceId so their footprint stays in the sandbox space too.
    WHOACHART_TINSTAR_SPACE: process.env.WHOACHART_TINSTAR_SPACE ?? "",
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

// Read a piped stream to completion, invoking onLine for each COMPLETE line as
// it arrives (line-buffered live streaming, not buffer-to-exit), and returning
// the full accumulated text for parseEmit / the ActivityOutput. A trailing \r is
// stripped so CRLF output doesn't leave a stray carriage return on each line.
async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  which: ActivityStream,
  onLine?: (stream: ActivityStream, line: string) => void,
): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  const emit = (line: string) => onLine?.(which, line.endsWith("\r") ? line.slice(0, -1) : line)
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
      emit(pending.slice(0, nl))
      pending = pending.slice(nl + 1)
    }
  }
  const tail = dec.decode()
  if (tail) { full += tail; pending += tail }
  if (pending.length) emit(pending) // final line without a trailing newline
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
  onLine?: (stream: ActivityStream, line: string) => void,
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

export interface HookFire {
  script: string
  event: HookEvent
  chart: string
  marble: Marble
  node: ChartNode
  // Present for `traverse` only — the edge being taken.
  edge?: { name?: string; from: string; to: string }
  // Present for `end` only — the marble's terminal outcome.
  outcome?: string
  timeoutMs: number
  onLine?: (stream: ActivityStream, line: string) => void
}

export interface HookOutput {
  exitCode: number
  timedOut: boolean
}

// Run one chart-level lifecycle hook as a pure side-effect. The command receives
// the marble context two ways: env vars (the WHOACHART_* set, plus event-specific
// WHOACHART_EVENT/CHART/EDGE/FROM/TO/OUTCOME) and a JSON event object on STDIN
// (the Claude Code parallel). Killed if it runs past `timeoutMs`.
//
// SEPARATE from runShell on purpose: it adds stdin + event env without changing
// runShell's signature (which several node types call), and it writes a UNIQUE
// temp context file per invocation — two hooks firing for the same (marble,node),
// e.g. `enter` + `start` on the start node, would otherwise race on runShell's
// shared whoachart-ctx-<marble>-<node>.json path (read vs. unlink).
//
// SECURITY: like runShell, hook stdout/stderr is forwarded VERBATIM to onLine and
// is NOT content-redacted — safe only on the current loopback + Tailscale trust
// surface (see runShell's note and netGuard).
export async function runHookCommand(fire: HookFire): Promise<HookOutput> {
  const { script, event, chart, marble, node, edge, outcome, timeoutMs, onLine } = fire
  const ctxPath = join(tmpdir(), `whoachart-hook-${marble.id}-${node.id}-${crypto.randomUUID().slice(0, 8)}.json`)
  await writeFile(ctxPath, JSON.stringify(marble.context))

  const env: Record<string, string> = {
    ...buildEnv(marble, node, ctxPath),
    WHOACHART_EVENT: event,
    WHOACHART_CHART: chart,
  }
  if (edge) {
    if (edge.name) env.WHOACHART_EDGE = edge.name
    env.WHOACHART_FROM = edge.from
    env.WHOACHART_TO = edge.to
  }
  if (outcome !== undefined) env.WHOACHART_OUTCOME = outcome

  const payload = {
    event,
    chart,
    marble: { id: marble.id, status: marble.status, context: marble.context, workpiece: marble.workpiece },
    node: { id: node.id, type: node.type, name: node.name },
    ...(edge ? { edge } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
  }

  try {
    const proc = Bun.spawn(["bash", "-c", script], {
      env,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    try {
      await Promise.all([
        pumpStream(proc.stdout, "stdout", onLine),
        pumpStream(proc.stderr, "stderr", onLine),
      ])
      const exitCode = await proc.exited
      return { exitCode, timedOut }
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await unlink(ctxPath).catch(() => {})
  }
}
