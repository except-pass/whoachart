# feat: Automation Ergonomics — Triggers, Register-Anywhere, and Supervisor Sessions

**Origin spec:** `docs/superpowers/specs/2026-06-29-automation-ergonomics-triggers-supervisor-design.md`
**Reference implementation plan (authoritative code + exact TDD steps):** `docs/superpowers/plans/2026-06-29-automation-ergonomics-triggers-supervisor.md`
**Plan depth:** Deep (cross-cutting: schema, store, HTTP surface, scheduler, Tinstar sessions)
**Execution posture:** Test-first throughout — every feature-bearing unit lands its `bun:test` file with the unit. The reference plan above contains the exact failing-test → minimal-impl → green → commit sequence for each unit; this document is the decision/sequencing layer over it.

---

## Summary

Turn whoachart charts into self-driving automations across four capabilities: (1) register chart files stored anywhere via a store-dir symlink, (2) a top-level `triggers:` block firing charts on cron/interval schedules, (3) a tailnet-internal inbound webhook API routed to a chart, and (4) an opt-in long-lived Tinstar supervisor session that resolves only the gates a chart marks `decider: agent`. All four reuse existing seams — `submit()` + form validation, the `installRuntime` liveness point, the `mutate()` serialization lock, the trust/write gates, and the `SessionLauncher` — so the new surface is additive and the existing security posture is preserved.

---

## Problem Frame

Charts today are manually driven: the only entry path is `POST /api/charts/:name/marbles`, and a chart is only discovered if it lives in the single store dir or the boot list. There is no scheduled execution, no inbound event integration, and the only agent model is the per-step `agent` node (a cold session for one step). This plan closes those gaps without weakening the loopback/tailnet trust model.

---

## Requirements Traceability

| R-ID | Requirement | Source | Unit(s) |
|---|---|---|---|
| R1 | A chart file at an arbitrary path can be registered at runtime and survives a daemon restart, with no side index | spec §2, Goals | U2 |
| R2 | A chart declares triggers in its own YAML (top-level `triggers:`); editing them is a hot-reload | spec §1 | U1, U4 |
| R3 | Cron + interval schedules fire a chart forward-only (no missed-tick replay) | spec §3 | U3, U4 |
| R4 | An inbound tailnet webhook routes its JSON body into a chart run as form-validated context | spec §4 | U1, U5 |
| R5 | An opt-in supervisor session oversees a chart and resolves only `decider: agent` gates, never human gates | spec §5 | U1, U6, U7 |
| R6 | Supervisor sessions land in a designated agent space (`WHOACHART_AGENT_SPACE`) | spec §5 | U7 |
| R7 | All trigger/webhook fires and supervisor signals serialize with hot-reload/delete and emit an audit line | spec §6 | U4, U5, U7 |

---

## Key Technical Decisions

- **KTD-1 — Register-anywhere is a symlink, not an index.** A `{path}` register creates `storeDir/<name>.yaml → realfile`. `listNames`/`resolvePath`/`read` already follow symlinks, so "the on-disk set IS the registry" holds with zero drift surface. Edits via `PUT` resolve the link and write through to the real file (so `atomicWrite`'s tmp+rename doesn't clobber the symlink). *Alternative rejected:* a JSON path-index reintroduces exactly the drift-prone side table the codebase avoids.
- **KTD-2 — Triggers bind a source node, reuse `submit()`.** Each trigger names a `start` source; cron `context` and webhook bodies pass through the source's existing `form` via `validateForm`. Cron/webhook are just new callers of `submit()`, inheriting the `mutate()` lock and form contract for free.
- **KTD-3 — In-process, fire-forward scheduler with an injectable clock.** No new dependency; a self-contained 5-field cron evaluator plus `<n>s|m|h` intervals. The `Clock` seam makes scheduling deterministically testable (`FakeClock.advance`). Missed ticks are never replayed — chart watermarks absorb gaps; replay would double-fire.
- **KTD-4 — Webhooks are tailnet-internal.** They sit behind the existing trust gate (loopback + tailnet), NOT `writeGate` (a fire is not a code-install). No HMAC/public ingress; public-service bridging is an explicit non-goal.
- **KTD-5 — Supervisor is an API consumer, not a privileged path.** The daemon only spawns one session per chart (via the existing launcher) and surfaces `decider` in `/def`; the "resolve agent gates, leave human gates" logic lives in the agent's brief. Reload preserves a running supervisor; delete stops it.

---

## High-Level Technical Design

```mermaid
flowchart LR
  subgraph triggers [Trigger sources]
    cron[cron / every timer] -->|Scheduler.fire| submit
    hook[POST /api/hooks/:chart/:hook] -->|fireWebhook| submit
    api[POST .../marbles] --> submit
  end
  submit[Daemon.submit -> validateForm -> mutate] --> engine[Engine: marble runs]
  engine --> gate{blocked gate}
  gate -->|decider: human| human[person signals]
  gate -->|decider: agent| sup[Supervisor session\nin WHOACHART_AGENT_SPACE]
  sup -->|signal| engine
  reg[POST /api/charts {path}] -->|symlink into store dir| install[installRuntime\narmTriggers + ensureSupervisor]
  install --> engine
```

Lifecycle seam: `installRuntime` (boot/register) arms triggers + ensures the supervisor alongside the widget loop; `updateChart` re-arms triggers (leaves supervisor running); `deleteChart` disarms triggers + stops the supervisor. The runtime map remains the liveness source of truth — pending timers/retries short-circuit on `runtimes.has(name)`.

---

## Implementation Units

> Each unit's exact failing tests, implementation code, and commit are in the reference plan (`docs/superpowers/plans/2026-06-29-automation-ergonomics-triggers-supervisor.md`), Task N == U(N). This section is the decision/sequencing layer; defer to the reference plan for verbatim code.

### U1. Trigger / supervisor / decider schema

- **Goal:** Parse and validate the new top-level `triggers:` and `supervisor:` blocks and the per-node `decider` field.
- **Requirements:** R2, R4, R5
- **Dependencies:** none
- **Files:** `src/types.ts`, `src/schema.ts`, test `tests/triggerSchema.test.ts`
- **Approach:** Add `ChartTrigger`, `SupervisorSpec`, `ChartNode.decider`, `Chart.triggers`/`Chart.supervisor`. Zod `triggerSchema` with a `superRefine` enforcing exactly-one-of `cron|every|webhook`; a `supervisorSchema`; `decider: enum(["human","agent"]).optional()`. In `parseChart`, cross-validate: `start` names a `source` node, webhook ids unique and `[A-Za-z0-9_-]`.
- **Patterns to follow:** existing `formFieldSchema` superRefine and the post-parse validation loop already in `src/schema.ts`.
- **Test scenarios:**
  - Parses a cron trigger with `start` + static `context`.
  - Parses `every` and `webhook` triggers.
  - Rejects a trigger with zero of cron/every/webhook (`/exactly one of/`).
  - Rejects a trigger with two of the three.
  - Rejects `start` that is not a source node (`/must name a source node/`).
  - Rejects duplicate webhook ids.
  - Parses a `supervisor:` block and a node `decider: agent`.
- **Verification:** `bun test tests/triggerSchema.test.ts` green; full suite unaffected (optional fields inert on existing charts).

### U2. Register-anywhere via symlink

- **Goal:** Register a chart stored at any path (by reference) and survive restart; `PUT` writes through to the real file.
- **Requirements:** R1
- **Dependencies:** none
- **Files:** `src/chartStore.ts`, `src/daemon.ts`, `src/controlApi.ts`, test `tests/registerPath.test.ts`
- **Approach:** `ChartStore.link(name, target)` (symlink → store dir, returns link path); exported `writeTarget(path)` (follow a symlink to its realpath). `Daemon.registerChartByPath(path)` parses the target, name-guards, refuses duplicates (409), symlinks, `installRuntime`. `POST /api/charts` branches: JSON `{path}` → register-by-reference; raw YAML → register-by-value (unchanged). Both `writeGate` (loopback-only). `updateChart` writes via `await writeTarget(existing.file)`.
- **Patterns to follow:** `registerChart`/`atomicWrite` flow; `assertSafeChartName` guard ordering; the loopback-only `writeGate` already on `POST /api/charts`.
- **Test scenarios:**
  - `POST {path}` registers an external chart, store entry is a symlink (not a copy), chart runs to `done`.
  - Registered-by-reference chart is present after a fresh daemon over the same dirs (restart survival).
  - `PUT` on a referenced chart updates the external file and leaves the store entry a symlink (write-through).
  - `POST {path}` from a tailnet peer → 403 (loopback-only).
- **Verification:** `bun test tests/registerPath.test.ts` green; raw-YAML register path unchanged.

### U3. Cron / interval evaluator (pure)

- **Goal:** A dependency-free `nextRun`/`everyToMs` with thorough unit coverage.
- **Requirements:** R3
- **Dependencies:** none
- **Files:** `src/cron.ts`, test `tests/cron.test.ts`
- **Approach:** 5-field cron (`*`, value, range, list, `*/n` step) → `parseCron` sets; `nextRun(expr, after)` strictly-after, minute resolution, local time, dom/dow ANDed (documented simplification vs crontab OR). `everyToMs("15m")` → ms, positive only.
- **Test scenarios:**
  - `nextRun("0 9 * * 1-5", …)` lands the next weekday 09:00.
  - Strictly-after: an exact match rolls to the next occurrence.
  - Step field `*/15` advances to the next quarter-hour.
  - `parseCron` rejects wrong field count and out-of-range values.
  - `everyToMs` parses s/m/h; rejects `15` and `0m`.
- **Verification:** `bun test tests/cron.test.ts` green.

### U4. Scheduler + daemon trigger wiring

- **Goal:** Arm cron/interval triggers at runtime install, fire through `submit()`, disarm on teardown.
- **Requirements:** R2, R3, R7
- **Dependencies:** U1, U3
- **Files:** `src/scheduler.ts`, `src/daemon.ts`, `tests/fakes.ts`, test `tests/scheduler.test.ts`
- **Approach:** `Clock`/`realClock` (unref'd `setTimeout`) + `Scheduler.arm/disarm/disarmAll` (one self-rescheduling timer per time-based trigger; webhook triggers skipped). `DaemonOpts.clock`. `installRuntime` → `armTriggers`; `updateChart` re-arms with the new triggers; `deleteChart` disarms. `fireTrigger` → `submit(name, {start, context})` (inside `mutate`), failures logged not fatal. `FakeClock.advance(ms)` drives tests deterministically.
- **Patterns to follow:** the `ensureWidgetLoop` retry/liveness-guard idiom; `mutate()` usage in `submit`.
- **Test scenarios:**
  - `Scheduler` fires an interval each period and stops after `disarm`.
  - An interval trigger submits a marble carrying its static context once `FakeClock` advances one period.
  - Deleting a chart disarms its schedule (no further fires).
  - (Integration) re-arm on hot-reload picks up a changed schedule. *Covers R2 hot-reload.*
- **Verification:** `bun test tests/scheduler.test.ts` green; full suite unaffected (default `realClock` is unref'd, never holds tests open).

### U5. Inbound webhook route

- **Goal:** `POST /api/hooks/:chart/:hook` routes a tailnet request body into a chart run.
- **Requirements:** R4, R7
- **Dependencies:** U1
- **Files:** `src/daemon.ts`, `src/controlApi.ts`, test `tests/webhook.test.ts`
- **Approach:** `Daemon.fireWebhook(name, hookId, body)` finds the `webhook===hookId` trigger (404 on unknown chart/hook via `ChartError`), `submit`s with `{...trigger.context, ...body}` (body wins), form-validated in `submit`. Route under the base trust gate (NOT `writeGate`), returns 202 `{id, status}`. Non-JSON/empty body → empty context.
- **Patterns to follow:** existing `FormError → 400 {fields}` mapping in the controlApi catch; the marble-POST 201 shape.
- **Test scenarios:**
  - `POST /api/hooks/:chart/:hook` with a JSON body creates a marble carrying that body as context (202).
  - A body failing form validation → 400 with `fields`.
  - Unknown hook id → 404.
  - A webhook from a tailnet peer is accepted (trigger, not a chart write).
- **Verification:** `bun test tests/webhook.test.ts` green.

### U6. Surface `decider` in `/def`

- **Goal:** Expose each node's `decider` so the supervisor can read which gates are its to act on.
- **Requirements:** R5
- **Dependencies:** U1
- **Files:** `src/daemon.ts`, test `tests/triggerSchema.test.ts` (extend)
- **Approach:** Add `decider?: "human" | "agent"` to the `ChartDef` node shape and emit `decider: n.decider` in `def()`. (Not run through `redactSecrets` — it's a routing flag, not config.)
- **Test scenarios:** `def(chart).nodes.find(gate).decider === "agent"`.
- **Verification:** `bun test tests/triggerSchema.test.ts` green.

### U7. Supervisor session lifecycle

- **Goal:** Spawn one supervisor session per chart that declares `supervisor:`, placed in `WHOACHART_AGENT_SPACE`, torn down on delete.
- **Requirements:** R5, R6, R7
- **Dependencies:** U1, U6
- **Files:** `src/tinstar.ts`, `src/supervisor.ts`, `src/daemon.ts`, `src/main.ts`, test `tests/supervisor.test.ts`
- **Approach:** `SpawnSessionOpts.spaceId` (auto-forwarded by the existing `...opts` spread in `TinstarClient.spawnSession`). `buildSupervisorBrief(chart, apiBase)` names the `decider:"agent"` gates and forbids human gates. `DaemonOpts.agentSpace` resolved once via `ensureSpace` → `agentSpaceId`. `ensureSupervisor(chart)` (retry/liveness-guarded like `ensureWidgetLoop`, no-op without a launcher or supervisor block, idempotent via a `supervisors` map) wired into `installRuntime`; `stopSupervisor(name)` wired into `deleteChart`. Reload deliberately leaves a running supervisor untouched (documented v1 scope). `main.ts` reads `WHOACHART_AGENT_SPACE`.
- **Patterns to follow:** `ensureWidgetLoop` (retry timer, `runtimes.has` guard, unref'd timer), the agent-node `name` sanitization, the fire-and-forget `stopSession` in `signal`.
- **Test scenarios:**
  - A chart with `supervisor:` spawns one `wc-sup-<chart>` session; brief contains the custom text, `decider:"agent"`, the agent gate id, the project; `spaceId` is the resolved agent space.
  - Deleting the chart stops the supervisor session.
  - A chart with no `supervisor:` block spawns no supervisor.
- **Verification:** `bun test tests/supervisor.test.ts` green; full suite green.

### U8. Documentation + example chart

- **Goal:** Document the automation surface and ship a runnable example exercising all four capabilities.
- **Requirements:** R1–R6 (docs)
- **Dependencies:** U1–U7
- **Files:** `README.md`, `examples/automation-demo.yaml`
- **Approach:** README section covering register-by-path, the `triggers:` block (cron/`every`/webhook), fire-forward + tailnet-internal caveats, and the supervisor + `decider` + `WHOACHART_AGENT_SPACE`. Example chart with a cron, an interval, a webhook, a `supervisor:`, and a `decider: agent` routing gate alongside a human approval gate.
- **Test expectation:** none — docs/example; `bun test` confirms nothing else broke.
- **Verification:** full suite green; example chart parses under the new schema.

---

## Scope Boundaries

**In scope:** the four capabilities above and their lifecycle wiring, behind the existing gates.

### Deferred to Follow-Up Work
- Templated webhook body→context mapping (`map:`); v1 passes the body through verbatim.
- Cron macros (`@daily`) / seconds field; v1 is plain 5-field.
- Re-spawning a supervisor when a hot-reload *adds* a `supervisor:` block (v1 takes effect on next register/boot).
- Per-chart mutation lock (the existing global `mutate()` lock is unchanged; noted as a pre-existing TODO).

### Outside this product's identity (from spec non-goals)
- Public-internet webhooks / HMAC verification (webhooks stay tailnet-internal).
- Remote chart authoring (registration stays loopback-only; `WHOACHART_TRUST_ALL` cannot re-open it).
- Cron catch-up / missed-tick replay.
- Supervisor authoring or editing charts, or resolving human gates.

---

## Risks & Dependencies

- **Symlink write-through edge:** a dangling symlink (target removed) must degrade like any invalid chart (skipped into `bootErrors`), not crash boot — covered by the existing bad-chart isolation; `writeTarget` falls back to the path on `lstat`/`realpath` failure. (U2)
- **Scheduler must not hold the process open:** `realClock` timers are `unref`'d; tests use `FakeClock`. (U4)
- **Session placement is best-effort:** `SpawnSessionOpts.spaceId` is forwarded to Tinstar; if unsupported it degrades to the active space (same posture as widget placement). (U7)
- **Serialization:** trigger fires, webhook fires, and supervisor signals all route through `submit`/`signal` → `mutate()`, so they cannot land on an engine mid-swap. (U4, U5, U7)

---

## Sources & Research

Grounded in a full read of the current daemon surface — `src/daemon.ts` (`installRuntime`/`updateChart`/`deleteChart`/`submit`/`mutate`/`ensureWidgetLoop`), `src/controlApi.ts` (trust + write gates), `src/chartStore.ts` (symlink-following registry), `src/nodeTypes/source.ts` (`trigger` enum seam) and `human.ts` (gate), `src/tinstar.ts` (`SessionLauncher`/`CanvasControl`/`...opts` spread), `src/forms.ts` (`validateForm`), `src/lint.ts`, and the `bun:test` conventions in `tests/` (`FakeCanvas`/`FakeLauncher`, `waitForStatus`, `clearRegistry`/`registerBuiltins`). No external research required — the work extends well-established local patterns. Full verbatim code per unit lives in the reference plan cited at the top.
