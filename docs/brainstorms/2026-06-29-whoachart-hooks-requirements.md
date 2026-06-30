# whoachart hooks — requirements

**Date:** 2026-06-29
**Status:** approved (brainstorm) — ready for planning
**Scope:** Standard, feature-tier

## Problem

A chart author wants to react to what a chart is doing — fire a notification when a
marble reaches a review gate, page on-call when a decision routes down `rejected`,
record every chart completion — without editing node activities or wiring
observability by hand. WhoaChart already emits a rich lifecycle event stream
(`enter`/`traverse`/`end`/`blocked`/`signaled`/`failed`/`retried` in `src/engine.ts`)
and already runs per-node `on_leave` / per-edge `on_traversal` shell hooks, but
there is no centralized, declarative way to say "on event X (optionally at node/edge
Y), run shell command Z." Today you get that only by attaching inline shell to
individual nodes/edges, one at a time, and there is no `enter`, `start`, or `end`
hook at all.

## Goal

Port the Claude Code hooks model to WhoaChart: a single chart-level `hooks:` block
that subscribes to lifecycle events and runs **arbitrary shell commands** as
**pure observers**. Hooks receive the full event + marble context, their output
streams into the existing node log, and they **never** change where a marble goes.

## Users / value

The chart author/operator (the same person who writes the YAML). Value: bolt
notifications, logging, paging, metrics, and external side-effects onto any chart
declaratively — without touching node logic — using the mental model they already
know from Claude Code.

## Requirements

### R1 — Chart-level `hooks:` block
A new optional top-level key `hooks:` on a chart, a **list** of hook entries
(mirroring the existing `triggers:` list — more YAML-idiomatic here than Claude
Code's nested-object form, same expressive power). Defined per-chart only.

```yaml
hooks:
  - on: start                 # a marble was submitted (first entry into the chart)
    run: 'echo "started $WHOACHART_MARBLE" >> /tmp/runs.log'
  - on: enter
    node: review              # matcher: only the 'review' node (omit = any node)
    run: './notify-reviewer.sh'
  - on: leave
    node: build
    run: 'curl -X POST https://...'
  - on: traverse
    edge: rejected            # matcher: only when an edge named 'rejected' is taken
    run: './page-oncall.sh'
  - on: blocked
    run: 'echo "waiting at $WHOACHART_NODE"'
  - on: failed
    run: './alert.sh'
    timeout: 5000             # ms; killed if it overruns (a default applies otherwise)
  - on: end
    run: './record.sh'        # WHOACHART_OUTCOME on env + stdin
```

### R2 — Event set
Hooks may subscribe to any of these seven lifecycle events, each mapped onto an
event the engine already produces:

| `on:` | Fires when | Maps to |
|-------|-----------|---------|
| `start` | a marble is first submitted / enters the chart | first `enter` (marble history length 1) |
| `enter` | a marble enters a node (before that node's activity runs) | `enter` |
| `leave` | a marble has resolved a node and is about to traverse out | alongside `on_leave` |
| `traverse` | an edge is taken | alongside `on_traversal` |
| `blocked` | a marble blocks at a gate / waits for a signal | `blocked` |
| `failed` | a node activity fails or routing fails | `failed` |
| `end` | a marble reaches an end node | `end` |

### R3 — Matchers
- `node:` — exact node id. Applies to `enter`, `leave`, `blocked`, `failed`, `end`
  (the node where the event happens) and `start` (the start node). Omitted = fires
  for every node.
- `edge:` — edge name. Applies to `traverse`. Omitted = fires for every traversal.
- A matcher naming a node/edge that does not exist in the chart is a **lint
  warning** (advisory, surfaced via `lintChart`/`/def` lint key), **not** a hard
  parse failure — a typo'd matcher must not reject the whole chart or break
  hot-reload. Schema still hard-rejects structurally invalid entries (unknown
  `on:` value, missing `run:`, non-positive `timeout:`).

### R4 — Observational only (never alters flow)
A hook is a side-effect. Its exit code, stdout, and stderr **never** change routing,
context, marble status, or anything else about the run. A non-zero exit is logged
(console + node log feed) and otherwise ignored. This is the same contract as
today's `on_leave`/`on_traversal`. (The exit-code / payload contract is left clean
so a future opt-in `blocking: true` could add veto power without a breaking change —
explicitly **not** in this version.)

### R5 — Fire-and-forget, bounded, non-wedging
- Hooks dispatch **off the marble's critical path**: a slow hook never delays the
  marble's progression to the next node.
- Each hook run is bounded by a **timeout** (per-hook `timeout:` in ms, else a
  sensible default) and killed if it overruns, so a hung hook cannot leak a process
  or wedge the daemon.
- Outstanding hook promises are tracked and drained on teardown; every hook promise
  is `.catch`-guarded so a failing hook can never surface as an unhandled rejection.
- Completion ordering across events is **not** guaranteed (hooks run concurrently);
  authors who need strict ordering relative to flow use inline `on_leave`.

### R6 — Payload to the hook (Claude-Code-faithful)
Each hook command receives:

- **Environment variables**: the existing set (`WHOACHART_MARBLE`, `WHOACHART_NODE`,
  `WHOACHART_CONTEXT` = path to a JSON file of the marble context,
  `WHOACHART_WORKSPACE`, `WHOACHART_TINSTAR_SPACE`) **plus** new ones —
  `WHOACHART_EVENT` (the event name), `WHOACHART_CHART` (chart name), and
  event-specific `WHOACHART_EDGE` / `WHOACHART_FROM` / `WHOACHART_TO` (traverse) and
  `WHOACHART_OUTCOME` (end).
- **A JSON event object on stdin** (the Claude Code parallel):

  ```json
  {
    "event": "enter",
    "chart": "my-chart",
    "marble": { "id": "...", "status": "running", "context": { }, "workpiece": "" },
    "node":   { "id": "review", "type": "human", "name": "Review" },
    "edge":   { "name": "rejected", "from": "review", "to": "reject" },
    "outcome": "success"
  }
  ```
  `edge` is present only for `traverse`; `outcome` only for `end`.

### R7 — Output streaming
Hook stdout/stderr streams line-by-line into the same per-`(marble, node)` log feed
that node activities use, so hook output shows up in the node inspector with no new
UI. (Subject to the same loopback + Tailscale trust-surface caveat already
documented for `runShell` output — hook output is not content-redacted.)

### R8 — Coexistence with inline hooks
Existing per-node `on_leave` and per-edge `on_traversal` remain unchanged and keep
their current await-in-flow semantics. The new `hooks:` block is the general,
multi-event, matcher-based superset; the two are independent and both fire.

## Non-goals / out of scope

- **Blocking / veto / context-mutating hooks.** Observational only this version.
  Contract kept forward-compatible for a later opt-in.
- **Global / daemon-level hooks** (Claude Code's user/project/local settings
  hierarchy). Per-chart only — confirmed there is no current use case for a
  whoachart-global hook.
- **Rich UI for hooks.** Output already streams into the node-log inspector. Raw
  `run:` command strings are **not** exposed via `/def` (avoids a secret-leak
  vector). A node-drawer "hooks attached" indicator is a possible later addition.
- **Templating in `run:`** beyond environment-variable interpolation that the shell
  already provides. No new mini-language.

## Success criteria

- A chart with a `hooks:` block fires the right command for each event, scoped
  correctly by `node`/`edge` matchers, with the documented env vars and JSON stdin.
- A hook that hangs is killed at its timeout and never delays or wedges the marble
  it fired for, nor any other marble.
- A hook that exits non-zero is logged and otherwise ignored — the marble's path is
  byte-for-byte identical to a run with no hooks.
- A typo'd matcher produces a lint warning, not a rejected chart.
- Hot-reload of a chart that adds/removes/edits hooks picks up the change with no
  daemon restart (consistent with existing chart hot-reload).

## Open questions (for planning)

- Default hook timeout value (proposal: 30s, matching a conservative ceiling; node
  activities already opt into their own `timeout`).
- Whether `start` should also be matchable by `node:` or always chart-wide
  (proposal: allow `node:` = the start node, omit = any source).
- Exact placement of dispatch calls in `src/engine.ts` `step()` and whether to
  factor a single `fireHooks(event, marble, nodeId, extra)` helper vs inline calls
  (proposal: one helper, defensive node lookup so the `failed` catch path is safe).
