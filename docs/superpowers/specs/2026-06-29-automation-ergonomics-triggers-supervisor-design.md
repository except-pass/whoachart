# whoachart automation ergonomics: register-anywhere, triggers, and supervisor sessions

**Date:** 2026-06-29
**Status:** Design approved; ready for planning
**Supersedes/extends:** the manual-only trigger posture documented in `docs/superpowers/specs/2026-06-11-jira-morning-chart-design.md`

## Problem

Today a chart can only be kicked off by an explicit `POST /api/charts/:name/marbles` (the `submit` verb), and chart definitions are only discovered if they sit in the single store dir or the boot `WHOACHART_CHARTS` list. That makes whoachart a manually-driven tool: a human (or an external script the human wrote) has to poke the API on every run, and every chart has to live in one server-owned directory. There is no scheduled execution, no inbound event integration, and no way for an agent to oversee a run end-to-end — the only agent model is the per-step `agent` node that spawns a cold session for one step and is torn down on signal.

This design closes four gaps so charts become first-class automations:

1. **Register-anywhere** — chart files can live anywhere on disk and be registered with the running server.
2. **Cron triggers** — the server kicks off a chart on a schedule.
3. **Webhook triggers** — a general inbound webhook API routes an event to a chart.
4. **Supervisor session** — a single long-lived Tinstar session oversees a chart's run and makes the decisions designated for agents (never the ones designated for humans).

## Goals

- A chart stored at an arbitrary path can be registered and survives a daemon restart, without abandoning the codebase's "the on-disk set IS the registry" stance (no drift-prone side index).
- A chart can declare its own triggers (cron schedules and webhook bindings) in its YAML; editing them is a hot-reload, not a restart.
- An inbound webhook (tailnet-internal) routes its JSON body into a chart run as marble context, validated against the entry node's form.
- A chart can opt into a supervisor: one warm Tinstar session, placed in a designated agent workspace, that watches the run and resolves the gates marked for agents while leaving human gates untouched.

## Non-goals

- **Public-internet webhooks.** Webhooks are tailnet-internal and ride the existing trust gate. No HMAC/signature verification, no public ingress. Bridging public services (Jira/GitHub cloud) into the tailnet (relay, poller, Tailscale Funnel) is explicitly out of scope; a chart that needs cloud events still uses a shell/api node to poll, as `jira-morning` does today.
- **Remote chart authoring.** Registering a chart installs YAML the daemon will execute; registration stays loopback-only like every other chart write. `WHOACHART_TRUST_ALL` does not re-open it.
- **Cron catch-up.** Schedules fire forward only. Runs missed while the daemon was down are not replayed; chart-level watermarks (the `jira-morning.last` pattern) absorb gaps, and replay would double-fire.
- **Supervisor authoring/escalation power.** The supervisor does not author or edit charts, and never resolves a human gate. Its remit is bounded to agent-designated gates plus surfacing problems.

## Background: what already exists (verified against source)

- `src/chartStore.ts` — single writable dir; `listNames`/`resolvePath`/`read` are the only registry. `resolvePath`/`read` follow symlinks implicitly (they `readdir`/`readFile`). `atomicWrite` publishes via tmp+rename.
- `src/daemon.ts` — `installRuntime()` is the single place a chart goes live (calls `ensureWidgetLoop`); teardown happens in `updateChart`/`deleteChart`. All mutations serialize through `mutate()`. `submit()` already validates context against a source node's `form` via `validateForm`.
- `src/controlApi.ts` — Bun HTTP server. `isTrustedAddr` gate (loopback + tailnet) on reads/triggers; `writeGate` (loopback-absolute) on chart writes.
- `src/nodeTypes/source.ts` — source config already has `trigger: "api" | "manual"` plus an optional `form`. This is the entry-point + typed-contract seam triggers build on.
- `src/nodeTypes/human.ts` — a human gate is `type: human` returning `{ block: true }`; routing comes from the outgoing edges' forms and the node's `present` spec.
- `src/tinstar.ts` — `SessionLauncher` (`spawnSession`/`stopSession`) and `CanvasControl` (incl. `ensureSpace`) already exist. `WHOACHART_SPACE` confines *widgets* to a Tinstar space today.
- `src/nodeTypes/agent.ts` — per-step worker: spawns a session for one step, blocks, torn down on signal unless `keep_session`.

## Design

### 1. Trigger model — top-level `triggers:` in chart YAML

A chart gains an optional top-level `triggers:` array. Each entry binds a schedule or a webhook to a source node and supplies the context to inject. The source node's `form` stays the validation contract; both cron `context` and webhook bodies pass through `validateForm` exactly like an API submit.

```yaml
name: jira-morning
triggers:
  - cron: "0 9 * * 1-5"       # weekday 09:00 (5-field cron)
    start: scan               # MUST name a source node
    context: { since: "" }    # validated against scan's form
  - every: 15m                # interval form (alternative to cron)
    start: scan
  - webhook: jira-updated     # POST /api/hooks/jira-morning/jira-updated
    start: scan               # request JSON body -> marble context
nodes:
  - id: scan
    type: source
    config: { trigger: api, form: [ { key: since, type: text } ] }
```

Rules:

- Each entry has exactly one of `cron` / `every` / `webhook`.
- `start` must name an existing `source` node; validated at parse/lint time (advisory lint warning + hard error on submit if absent, mirroring how `submit` already treats `start`).
- A cron/interval entry may carry a static `context` object. A webhook entry maps the request body to context (see §4).
- Two triggers may target the same source; a chart may have multiple sources with different triggers.

Trigger config is parsed in `src/schema.ts` (new top-level key, like `nodes`/`edges`) and surfaced in `/def` so the UI/agents can see how a chart is driven.

### 2. Register-anywhere — symlink into the store dir (approach A1)

Registration of an external path creates a **symlink** `storeDir/<name>.yaml` pointing at the real file. Because `listNames`/`resolvePath`/`read` already follow symlinks, the chart is rediscovered on every boot with **no new index** — the dir stays the registry.

- New body shape on `POST /api/charts`: a `{ "path": "/abs/chart.yaml" }` request registers by reference (symlink); a raw-YAML body keeps registering by value (copy) as today. Both are loopback-only (`writeGate`).
- `name` derives from the chart's own `name:` field (parsed first), guarded by `assertSafeChartName` before any fs op.
- **Write-back wrinkle:** `atomicWrite`'s tmp+rename would replace the symlink with a regular file, severing the reference. Resolution: for a referenced (symlinked) chart, API edits (`PUT`) resolve the link and write through to the real target — OR are refused with a clear "edit in place + reload" message. Planning picks one; the spec's preference is **write-through to the link target** so the API stays uniform, with the realpath computed before `atomicWrite`.
- `deleteChart` unlinks only the symlink, never the referenced file (verified: `unlink` on a symlink removes the link). Marble run-state purge behavior is unchanged.
- A dangling symlink (target deleted out from under the daemon) is treated like any other invalid chart at boot/rescan: skipped into `bootErrors`, not a crash.

### 3. Cron scheduler — in-process, fire-forward (approach B1)

An in-process scheduler arms per-chart timers when a chart goes live and clears them on teardown/reload.

- Lifecycle: `installRuntime()` gains `armTriggers(chart)`; `updateChart`/`deleteChart` call `disarmTriggers(name)` before swapping/removing. Re-arm on hot-reload picks up edited schedules.
- Syntax: standard 5-field cron (`min hour dom mon dow`) via a small self-contained evaluator, plus an `every: <n><s|m|h>` interval form for the common "every N minutes" case. No new heavyweight dependency; the evaluator computes the next fire time from "now."
- Fire-forward only: each tick computes the next future fire and sleeps to it (no replay of missed ticks). A fire calls `daemon.submit(name, { start, context })` through the existing `mutate()` lock, so a cron fire can't race a hot-reload.
- A fire that throws (e.g. form validation fails) is logged on the operator audit line and does not kill the schedule.
- Testability: the scheduler takes an injectable clock/timer seam so tests advance time deterministically (no wall-clock sleeps).

### 4. Webhook API — tailnet-internal

New route: `POST /api/hooks/:chart/:hook`.

- Sits behind the **existing** `isTrustedAddr` gate (loopback + tailnet). Per the non-goal, no new auth surface: being on the tailnet is the authorization. It is NOT under `writeGate` — it triggers a run, it does not install code.
- `:hook` is the `webhook:` id from the chart's YAML. Unknown chart or unknown hook id → 404.
- The request's JSON body becomes the marble context (optionally a future `map:` could reshape it; v1 passes the parsed body through), validated against the target source node's `form` via the same `validateForm` path. Invalid body → 400 with field errors, same shape as a bad API submit.
- Response: `202` with `{ id, status }` of the new marble (fast ack; the run proceeds asynchronously through the engine).
- Non-JSON / empty body is treated as empty context (then form-validated), so a "ping to fire" webhook with no payload works when the source form has no required fields.

### 5. Supervisor session + the `decider` marking

A chart gains an optional top-level `supervisor:` block (opt-in):

```yaml
supervisor:
  brief: |
    You oversee this chart's runs. Resolve gates marked for agents;
    leave human gates alone; flag stuck or failed marbles.
  cli_template: "Claude (multi-agent)"   # optional
  project: whoachart                       # optional
```

Behavior:

- When the chart goes live, the daemon spawns **one** long-lived Tinstar session for it, re-spawned best-effort if it dies (mirrors `ensureWidgetLoop`'s tolerance of Tinstar being down). Torn down on chart delete; preserved or refreshed on hot-reload.
- Placement: a **new** `WHOACHART_AGENT_SPACE` env names the Tinstar space for supervisor sessions — distinct from `WHOACHART_SPACE` (widgets only). Unset → falls back to the active space, same degradation pattern as widget placement.
- The supervisor's brief points it at this daemon's API (`/state`, `/marbles`, the signal endpoint) so it polls the run and acts. It is a *consumer* of the existing control API, not a new privileged path.

The "agent decisions yes, human decisions no" boundary is expressed by a `decider:` field on gate nodes:

```yaml
  - id: route-triage
    type: human
    decider: agent       # supervisor MAY resolve this gate
  - id: approve-post
    type: human          # decider defaults to `human`; supervisor never touches it
```

- `decider: "human" | "agent"`, default `human`. Added to the node schema; surfaced in `/def`.
- The supervisor resolves a blocked marble only when its node's `decider` is `agent`: it reads the `present`/context, picks an outgoing edge, and signals via the normal endpoint (the same path a human or the per-step agent uses). Every `decider: human` gate is left for a person.
- This is distinct from `agent` *nodes*, which still spawn per-step specialist workers for heavy isolated work. The supervisor is the warm, chart-wide-context alternative for lightweight routing gates: one session resolving many gates instead of N cold one-step spawns. Both models coexist in the same chart.

### 6. Lifecycle, security, and audit (cross-cutting)

- **Single liveness seam:** `installRuntime()` arms triggers and ensures the supervisor alongside the widget loop; the three teardown sites (`updateChart`, `deleteChart`, and SIGTERM/SIGINT) disarm timers and stop the supervisor. The runtime map stays the liveness source of truth (a disarmed/deleted chart's pending timer/respawn must check `runtimes.has(name)`, mirroring `ensureWidgetLoop`).
- **Security posture:** registration-by-path is loopback-only (`writeGate`); triggers and webhooks ride the read/trigger gate (loopback + tailnet); supervisor sessions are spawned by the daemon, not by a remote caller. Cron/webhook context is always form-validated before a marble is created.
- **Audit:** every trigger fire, supervisor spawn/teardown, and supervisor signal emits an operator audit line (the existing `logLine` format), so an unattended run is fully reconstructable from the log.
- **Concurrency:** all trigger-fired submits and supervisor signals go through `mutate()`, so they serialize with hot-reload/delete the same way manual submits/signals already do.

## Open questions for planning

1. **Symlink write-through vs refuse-and-reload** for editing a referenced chart via `PUT` (§2). Spec preference: write-through to the realpath.
2. **Cron evaluator scope** — confirm 5-field is enough (no seconds field, no `@daily` macros) for v1.
3. **Webhook body→context mapping** — v1 passes the body through verbatim; a templated `map:` is a deliberate later extension, not v1.
4. **Supervisor respawn cadence/back-off** — reuse the 15s widget retry, or a longer interval given a session is heavier than a widget.
5. **One supervisor per chart vs per active run** — spec assumes per-chart (oversees all in-flight marbles); confirm that's the desired granularity.

## Success criteria

- A chart file outside the store dir can be registered (`POST /api/charts` with `{path}`), runs, and is still present after a daemon restart.
- A chart with a `cron`/`every` trigger fires on schedule with no manual poke; a hot-reload that changes the schedule re-arms it.
- `POST /api/hooks/:chart/:hook` from a tailnet peer creates a marble with the request body as (form-validated) context and returns 202.
- A chart with a `supervisor:` block spawns one session in `WHOACHART_AGENT_SPACE`; the supervisor advances `decider: agent` gates and demonstrably leaves `decider: human` gates blocked for a person.
- All of the above serialize correctly with hot-reload/delete (no marble stranded on a dead engine) and emit a complete operator audit trail.
