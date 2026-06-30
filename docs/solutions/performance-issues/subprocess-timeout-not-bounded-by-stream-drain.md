---
module: chart-engine
date: 2026-06-29
problem_type: performance_issue
component: service_object
severity: high
symptoms:
  - "`sleep 9 | cat` hook at timeout 200ms resolved in 5006ms — 25x over the timeout budget"
  - "A `tail -f` hook hangs the engine's drain() forever, wedging the whole chart engine"
  - "A `trap '' TERM` shell ignores proc.kill() (SIGTERM) and is never terminated"
  - "A backgrounded hook (`sleep 9 &`) leaves a grandchild holding the stdout write-fd, so pumpStream never sees EOF and the await hangs"
root_cause: async_timing
resolution_type: code_fix
related_components:
  - background_job
  - tooling
tags:
  - subprocess-timeout
  - bun-spawn
  - proc-exited
  - stream-drain
  - sigterm-sigkill
  - async-timing
  - hook-execution
  - pipeline-grandchild
---

# Subprocess timeout must bound on process exit, not stream drain

*Found by multi-agent code review (adversarial + reliability), confirmed empirically. whoachart PR #6, commit `456d4aa`, `src/context.ts` `runHookCommand`.*

## Problem

A subprocess "timeout" implemented as `proc.kill()` on a timer, where completion is keyed on awaiting `pumpStream(stdout)`/`pumpStream(stderr)` **before** `await proc.exited`, does not actually bound the subprocess. Any command that spawns a grandchild (a pipeline or a backgrounded job) or that traps SIGTERM runs far past its declared timeout and can hang the caller — and anything awaiting it — indefinitely.

## Symptoms

- Pipelined and backgrounded commands ran *vastly* past their timeout: `sleep 9 | cat` with `timeout: 200`ms took **5006ms** to return (~25x the ceiling).
- An infinite command (`tail -f`) hung the engine's `drain()` **forever** — and `drain()` is what shutdown and the test suite await, so one runaway side-effect wedged the whole pipeline.
- **The masking trap:** the single-command timeout test (`sleep 5`, killed at its ceiling) *passed*. `bash -c "sleep 5"` exec-optimizes — the shell replaces itself with `sleep` in the same PID — so the SIGTERM from `proc.kill()` lands directly on the target and it dies on time. That green test created false confidence while every multi-process shape silently leaked.

## What Didn't Work

The original runner:

```ts
// BEFORE — does not bound the subprocess
setTimeout(() => proc.kill(), timeoutMs)              // SIGTERM only
const [stdout, stderr] = await Promise.all([          // <-- blocks here
  pumpStream(proc.stdout, "stdout", onLine),
  pumpStream(proc.stderr, "stderr", onLine),
])
const code = await proc.exited                        // only reached after pumps drain
```

Two independent reasons it fails to bound anything:

1. **The pump waits on an fd the target's grandchild still holds.** `pumpStream` reads until EOF, and EOF on a pipe arrives only when *every* write end is closed. In `curl | jq` or `sleep 9 &`, the shell forks a grandchild that inherits the stdout write-fd. Kill the shell and the grandchild keeps that fd open — so `pumpStream` never sees EOF, `await Promise.all([pumps...])` never resolves, and the `await proc.exited` on the next line is never even reached.
2. **SIGTERM alone doesn't kill a shell that traps it.** `proc.kill()` sends SIGTERM. A hook running `trap '' TERM` ignores the signal and keeps running, with no escalation to enforce the ceiling.

## Solution

Key completion on the **process exiting**, with SIGKILL escalation, and demote the pipe drain to a *bounded, best-effort* post-exit flush that can never gate the result (`src/context.ts`):

```ts
// AFTER — runHookCommand
let killTimer: ReturnType<typeof setTimeout> | undefined
const termTimer = setTimeout(() => {
  timedOut = true
  proc.kill()                                  // SIGTERM first (lets a well-behaved hook clean up)
  killTimer = setTimeout(() => {
    try { proc.kill("SIGKILL") } catch { /* already exited */ }
  }, HOOK_KILL_GRACE_MS)                        // ...then SIGKILL after the grace
  unref(killTimer)
}, timeoutMs)
unref(termTimer)

const pumps = Promise.all([
  pumpStream(proc.stdout, "stdout", onLine),
  pumpStream(proc.stderr, "stderr", onLine),
])
pumps.catch(() => {})                           // un-awaited; may outlive us on an orphan fd

const exitCode = await proc.exited              // completion keyed HERE, bounded by SIGKILL
await Promise.race([pumps, delay(HOOK_PUMP_GRACE_MS)])  // best-effort flush, capped
return { exitCode, timedOut }
```

Supporting constants/helpers in the same file:

```ts
const HOOK_KILL_GRACE_MS = 2_000   // SIGTERM -> SIGKILL escalation window
const HOOK_PUMP_GRACE_MS = 500     // post-exit flush cap; an orphan fd never hangs the caller
const unref = (t) => (t as { unref?: () => void }).unref?.()       // timers don't keep proc alive
const delay = (ms) => new Promise<void>((res) => unref(setTimeout(res, ms)))
```

## Why This Works

- **`proc.exited` resolves on process death and does *not* wait for stdio.** An inherited-but-still-open pipe fd held by a grandchild does not delay it, so keying completion here decouples "is the hook done" from "is every fd closed."
- **SIGKILL cannot be trapped or ignored.** The SIGTERM->SIGKILL escalation gives `proc.exited` a hard upper bound (`timeoutMs + HOOK_KILL_GRACE_MS`) regardless of what the script does with signals.
- **Racing the pumps against a grace makes a detached grandchild's open fd un-gating.** Even if `cat` or a backgrounded `sleep` holds the write-fd forever, `Promise.race([pumps, delay(GRACE)])` resolves on the grace branch after at most `HOOK_PUMP_GRACE_MS`. The orphan keeps reading harmlessly (`.catch()`-guarded) but can never block the caller, `drain()`, or shutdown.

## Prevention

**The generalizable rule** (any `Bun.spawn` / Node `child_process` timeout): **bound completion on process exit, never on awaiting stdout/stderr drain.** Pipe EOF depends on every inherited write-fd closing — which a child can't guarantee — so "I finished reading the output" is not a safe proxy for "the process is gone." Always:

1. Key the result on the exit promise (`proc.exited` / the `exit` event),
2. Escalate SIGTERM -> **SIGKILL** after a grace so the exit promise is itself bounded, and
3. Treat output draining as a *best-effort, time-capped* side-task raced against a grace.

**Test the timeout with the shapes that actually break it**, not just a lone `sleep` (which exec-optimizes and masks the bug). Cover all three multi-process shapes:

- **pipeline** — `a | b` (grandchild holds the stdout fd),
- **backgrounded** — `x &` (shell exits instantly, orphan keeps the fd),
- **trap-TERM** — `trap '' TERM; sleep N` (forces the SIGKILL escalation path).

**Verified post-fix bounds** (now guarded by regression tests in `tests/contextHook.test.ts` / `tests/hooks.test.ts`):

| command shape | before | after |
|---|---|---|
| normal (fast hook) | ~instant | **6ms** |
| pipeline (`sleep 9 \| cat`) | **5006ms** | **701ms** |
| backgrounded (`sleep 9 &`) | unbounded | **503ms** |
| trap-TERM (`trap '' TERM`) | unbounded | **2703ms** |

Pipeline/backgrounded settle at ~`timeout + HOOK_PUMP_GRACE_MS`; trap-TERM at ~`timeout + HOOK_KILL_GRACE_MS + flush`.

**Residual / known limitation:** SIGKILL here kills only the *shell*, not detached grandchildren — a backgrounded `sleep` or a pipeline's `cat` keeps running until it finishes on its own. The caller is fully unblocked (that was the bug), but the orphan is not reaped. Full cleanup requires a **process-group kill**: spawn with `setsid` (new process group) and signal the whole group (`killpg` / `kill -- -<pgid>`). Scoped out of this fix for portability; the same SIGTERM-only pattern pre-exists in `runShell`.

## Related Issues

- See also [Safe triggers in a hot-reloadable daemon](../architecture-patterns/safe-triggers-in-a-hot-reloadable-daemon.md) — sibling in this daemon's process-lifecycle-robustness family (fire-and-forget async-spawn teardown ⟷ bounding a runaway subprocess).
- Source: `src/context.ts` (`runHookCommand`), `src/engine.ts` (`drain`, `fireHooks`), `src/run.ts` (the `drain()` caller). Shipped in PR #6 (`feat/chart-hooks`).
