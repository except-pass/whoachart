---
module: daemon
date: 2026-06-29
problem_type: architecture_pattern
component: background_job
severity: medium
applies_when:
  - "Wiring a user-config-driven in-process scheduler (cron/interval/webhook) into a long-running, hot-reloadable runtime"
  - "Spawning external sessions/processes asynchronously and tracking them for teardown"
  - "Adding a feature whose config arrives as YAML/JSON and drives background timers"
related_components:
  - service_object
tags:
  - scheduler
  - cron
  - hot-reload
  - lifecycle
  - fail-fast-validation
  - timers
  - daemon
---

# Safe triggers in a hot-reloadable daemon

## Context

whoachart gained an automation layer: charts declare top-level `triggers:` (cron / `every` / webhook) and an optional per-chart `supervisor:` Tinstar session. A `Scheduler` arms in-process timers at the runtime-install seam, fires through the existing `submit()` path, and disarms on reload/delete. A multi-lens code review surfaced three recurring failure modes that are easy to introduce whenever user config drives background timers inside a runtime that can be swapped under live state. They are not whoachart-specific — they recur in any daemon with the same shape.

## Guidance

**1. Validate config that feeds a scheduler at PARSE time, never lazily at arm time.**
The schedule expression (`cron`, `every`) must be validated where the chart is parsed (`parseChart`), so a bad value is rejected with a 400 *before* any disk write or runtime swap. If you only discover it's invalid when `Scheduler.arm()` calls the cron parser, the throw lands in the middle of the install/reload lifecycle:

```ts
// schema.ts — validate eagerly, in the same pass that parses the chart
for (const t of chart.triggers ?? []) {
  if (t.cron  !== undefined) parseCron(t.cron)   // throws -> 400 at parse, before any swap
  if (t.every !== undefined) everyToMs(t.every)
}
```

Without this, `updateChart` has already done `runtimes.set(name, newRuntime)` before `armTriggers` throws; its catch then revives the *old* engine — leaving **two engines pumping the same persistent store**. Fail-fast at the boundary collapses that whole class of partial-install / dual-owner bugs.

**2. Make timer-callback bodies exception-safe — both the re-arm computation and the fired work.**
A self-rescheduling timer runs inside a `setTimeout` callback. Two things in it can throw: the *delay computation* (e.g. `nextRun` exhausting its search horizon on an impossible cron like Feb 30) and the *fired work*. An uncaught throw there crashes the process. Route both to an error sink and keep ticking:

```ts
const tick = () => {
  let ms: number
  try { ms = delayMs() } catch (err) { this.onError?.(chart, err); return } // stop THIS schedule, don't crash
  cancelTimer = clock.setTimer(ms, () => {
    if (cancelled) return
    try { Promise.resolve(fire(t)).catch(e => this.onError?.(chart, e)) } // async reject
    catch (e) { this.onError?.(chart, e) }                                 // AND sync throw
    tick()
  })
}
```

Note the sync/async split: `Promise.resolve(fire(t)).catch(...)` only catches a *rejected promise* — a callback that throws *synchronously* throws before `.catch` attaches, so it needs its own `try`.

**3. Centralize lifecycle on one liveness seam, and re-check liveness after any async spawn.**
Arm timers and ensure sessions at the single install seam (`installRuntime`); re-arm on hot-reload; disarm + stop on delete. For anything spawned *asynchronously* (an external session/process), the entity can finish spawning *after* the owner was deleted — its teardown already ran and found nothing. Re-check liveness in the spawn's success callback and tear down the late arrival:

```ts
launcher.spawnSession(opts).then(() => {
  if (!this.runtimes.has(chart.name)) {        // deleted while spawn was in flight
    void launcher.stopSession(name).catch(() => {})  // tear down the orphan, don't record it
    return
  }
  this.supervisors.set(chart.name, name)
})
```

The same guard pattern (`if (!runtimes.has(name)) return`) belongs in every retry/respawn timer so a deleted entity's pending callback no-ops.

## Why This Matters

The expensive bug here is silent: two engines on one store, or a leaked agent session, produces no error at the time — it surfaces later as duplicated/clobbered work or orphaned processes needing manual cleanup. Each trap is invisible in the happy-path tests that a feature ships with; they only appear under the *interaction* of config-error × lifecycle-swap × async-timing. Validating at the boundary and making callbacks exception-safe converts "corrupts state silently" into "rejected at parse with a clear 400" or "logged to onError, schedule survives."

A related, deliberate non-trap: an authorization-shaped marker (here `decider: human|agent`, telling a supervisor agent which gates it may resolve) can be **advisory** — surfaced in the API and honored by the agent's brief — rather than enforced at the sink, *if* the surrounding trust posture already permits the action. Be explicit in the design about which markers are enforced vs advisory; don't let a reviewer assume a prompt-level convention is a server-side boundary.

## When to Apply

- Any time user-supplied config (cron strings, intervals, endpoints) is compiled into live background timers — validate it in the parse step, not the arm step.
- Any in-process scheduler living inside a runtime that supports hot-reload/delete: route every timer/fire through one mutation lock, and arm/disarm at the same seam the runtime is installed/torn down at.
- Any async spawn (subprocess, remote session, worker) tracked for later teardown: guard the success callback with a liveness re-check.

## Examples

- **Before:** `cron` validated only when `Scheduler.arm()` ran → an invalid expression on `updateChart` left the old engine resumed *and* the new runtime in the map (two owners of one marble store). **After:** `parseCron`/`everyToMs` called in `parseChart` → invalid expression returns 400 before any swap; tests assert register/reload of a bad cron is rejected and nothing installs.
- **Before:** a Feb-29 cron threw `no match within a year` inside the re-arm `setTimeout` callback → uncaught crash. **After:** the search horizon covers leap years (real Feb-29 resolves) *and* `repeat()` catches a throwing `delayMs()` → schedule stops gracefully via `onError`; an impossible cron (Feb 30) no longer crashes the daemon.
- **Before:** deleting a chart whose supervisor `spawnSession` was still in flight recorded the session *after* delete → leaked. **After:** the spawn callback re-checks `runtimes.has` and stops the late session; a deferred-launcher test reproduces the race and asserts teardown.

## Related

- See also [Subprocess timeout must bound on process exit, not stream drain](../performance-issues/subprocess-timeout-not-bounded-by-stream-drain.md) — sibling in this daemon's process-lifecycle-robustness family (bounding a runaway hook subprocess ⟷ tearing down a fire-and-forget async spawn).
