---
title: "feat: _testing space convention + deterministic teardown"
date: 2026-06-17
type: feat
status: ready
depth: standard
---

# feat: `_testing` space convention + deterministic teardown

## Summary

The whoachart daemon plants one Tinstar browser widget per chart onto whatever
Tinstar workspace is active (`TINSTAR_URL`, default `:5273`), re-ensuring every
15s. During development/testing this pollutes the user's **primary** Tinstar
workspace with whoachart widgets. This plan adds a `WHOACHART_SPACE` env that
routes the daemon's entire canvas footprint into a named Tinstar space (e.g.
`_testing`), keeps the `bun test` suite provably self-contained (no real
network/Claude), and makes that sandbox space **deterministically tearable**
via a `bin/whoachart-teardown` script and on-shutdown widget cleanup.

Two firm user principles drive scope:
1. **Zero testing noise on the primary workspace** — all of it lands in the
   configured space instead.
2. **Self-contained testing** — the automated suite never reaches Claude/Jira/
   external systems, so teardown is deterministic (only record-clearing, no
   live tmux sessions to orphan).

---

## Problem Frame

- **Source of the noise:** `Daemon.ensureWidgetLoop` (`src/daemon.ts`) calls
  `client.ensureBrowserWidget({ url, title })` per chart with no `spaceId`, so
  Tinstar places the widget in `activeSpaceId`. It retries every 15s and even
  re-creates a widget the user manually closed.
- **No isolation lever today:** `src/main.ts` reads `TINSTAR_URL` but has no
  notion of a target *space*; `TinstarClient.ensureBrowserWidget`
  (`src/tinstar.ts`) doesn't send `spaceId` even though the Tinstar
  `POST /api/browser-widgets` API accepts and validates one.
- **No teardown:** the daemon has no shutdown handler; widgets it created
  persist after the process dies. There is no script to clear a space.
- **Self-containment is currently incidental, not enforced:** `bun test` was
  empirically verified to leave `:5273` untouched (all tests use
  `tests/fakes.ts` `FakeCanvas`/`FakeLauncher` or `Bun.serve` on port 0), but
  nothing *prevents* a future test from constructing a real network
  `TinstarClient` and hitting the live workspace.

**Scope boundary:** This is daemon + test-harness plumbing. It does not change
chart semantics, the jira-morning rewrite, or the focus button.

---

## Requirements

- **R1** — A `WHOACHART_SPACE` env, when set, routes every daemon
  `ensureBrowserWidget` call to that named Tinstar space; unset preserves
  today's behavior (active space).
- **R2** — If the named space doesn't exist, the daemon creates it
  (`POST /api/spaces`) before placing widgets; if it can't be resolved/created,
  the daemon logs and falls back to default placement rather than crashing.
- **R3** — The daemon injects `WHOACHART_TINSTAR_SPACE=<spaceId>` into
  shell-node env (alongside the existing `WHOACHART_*` vars) so chart scripts
  *can* target the same space. (No chart is required to consume it in this plan.)
- **R4** — `bun test` stays provably self-contained: a guard test fails if the
  test process ever opens a real network connection to a non-fake Tinstar.
- **R5** — An **opt-in** integration test (`WHOACHART_IT=1`, skipped otherwise)
  exercises the real daemon→Tinstar widget flow against a trivial source→end
  sandbox chart, asserts the widget lands in the configured space, and tears
  down afterward. It must never reach Jira/Claude.
- **R6** — `bin/whoachart-teardown [space=_testing]` enumerates the space's
  browser widgets (and sessions) and `DELETE`s them, leaving the space empty;
  idempotent and safe (never clears the active space's contents implicitly).
- **R7** — On `SIGTERM`/`SIGINT`, when `WHOACHART_SPACE` is set, the daemon
  removes the browser widgets it created during this run.

**Out of scope (deferred):** wiring `spawn-workon`/agent sessions to actually
spawn into `_testing` — that path reaches Claude/Jira/cmsandbox and is not
self-contained, so it stays prod-only. R3 lays the env groundwork; consuming it
in a chart is follow-up work.

---

## Key Technical Decisions

- **KTD1 — Resolve space by name, in the daemon, once at startup.** `main.ts`
  reads `WHOACHART_SPACE`; the daemon resolves it to a `spaceId` via a new
  `TinstarClient.ensureSpace(name)` (GET `/api/spaces` → match by name →
  POST `/api/spaces` if absent) and holds the id. Rationale: a single resolve
  keeps the 15s `ensureWidgetLoop` cheap (no per-attempt lookup) and the id is
  what the widget API and teardown both key on.
- **KTD2 — Thread `spaceId` through `EnsureWidgetOpts`, not a client field.**
  Add optional `spaceId?: string` to `EnsureWidgetOpts` and forward it in the
  `POST /api/browser-widgets` body. Rationale: keeps `TinstarClient` stateless
  about "current space", matches the existing opts-passing pattern, and lets
  `FakeCanvas` record it for assertions.
- **KTD3 — Track created widget ids on the daemon for teardown.** The daemon
  records each `{ chart, widgetId }` returned by `ensureBrowserWidget`. The
  SIGTERM/SIGINT handler (R7) deletes exactly those. Rationale: deterministic,
  scoped cleanup that never guesses which widgets are whose.
- **KTD4 — Self-containment guard via Bun's network surface, not code grep.**
  The guard test (R4) asserts no socket to the real Tinstar opens during the
  suite. Mechanism: a small allowlist check — the only base URLs constructed in
  tests are `127.0.0.1:0`-style fakes. Concretely, assert `TinstarClient`'s
  default `baseUrl` is never used by instantiating-without-args in a test, by
  scanning that every test constructs it with an explicit fake base. Rationale:
  cheap, deterministic, no live dependency; see U4 for the exact form.
- **KTD5 — Teardown enumerates-and-deletes rather than `DELETE /api/spaces/:id`.**
  The space-delete API refuses to delete the active or last space and doesn't
  kill tmux. Enumerating widgets/sessions by `spaceId` and deleting each leaves
  the space itself intact and is safe regardless of which space is active.
  Rationale: determinism + safety; the space is a durable convention, not a
  per-run artifact.

---

## Implementation Units

### U1. `EnsureWidgetOpts.spaceId` + `ensureBrowserWidget` forwards it

**Goal:** Let callers target a Tinstar space when creating a browser widget.

**Requirements:** R1 (partial)

**Dependencies:** none

**Files:**
- Modify: `src/tinstar.ts` (`EnsureWidgetOpts`, `ensureBrowserWidget`)
- Modify: `tests/fakes.ts` (`FakeCanvas` records `spaceId`)
- Test: `tests/tinstarCanvas.test.ts`

**Approach:** Add optional `spaceId?: string` to `EnsureWidgetOpts`. In
`ensureBrowserWidget`, include `spaceId` in the `POST /api/browser-widgets`
JSON body when present. Keep the existing dedupe-by-url behavior. `FakeCanvas`
should capture the full opts (currently it pushes to `ensured`) so tests can
assert the space.

**Patterns to follow:** the existing opts spread into the POST body in
`ensureBrowserWidget`; `FakeCanvas.ensured` array.

**Test scenarios:**
- `ensureBrowserWidget` includes `spaceId` in the POST body when opts carry it
  (assert against the `Bun.serve` fake that records the received body).
- `ensureBrowserWidget` omits `spaceId` when not provided (body has no
  `spaceId` key) — preserves today's behavior.
- Dedupe-by-url still returns the existing widget id without re-POSTing.

**Verification:** `bun test tests/tinstarCanvas.test.ts` green.

### U2. `TinstarClient.ensureSpace(name)` — resolve-or-create

**Goal:** Resolve a space name to an id, creating the space if it doesn't exist.

**Requirements:** R2

**Dependencies:** none

**Files:**
- Modify: `src/tinstar.ts` (new `ensureSpace`; extend `CanvasControl` interface)
- Modify: `tests/fakes.ts` (`FakeCanvas.ensureSpace`)
- Test: `tests/tinstarCanvas.test.ts`

**Approach:** `ensureSpace(name): Promise<string | null>` — GET `/api/spaces`,
find a space whose `name === name`, return its id; else POST `/api/spaces`
with `{ name }` and return the created id. Return `null` on any failure
(unreachable / bad response) so the daemon can fall back gracefully (R2). Add
`ensureSpace` to the `CanvasControl` interface; `FakeCanvas` returns a
configurable fake id (default a deterministic stub) and records the requested
name.

**Patterns to follow:** the GET-then-POST shape already in `ensureBrowserWidget`;
the `.catch(() => null)`/`r.ok` guarding added in `panToSession`.

**Test scenarios:**
- Returns the existing space's id when a space with that name is present in
  `GET /api/spaces`.
- Creates the space (POST observed by the fake server) and returns the new id
  when absent.
- Returns `null` when `/api/spaces` is unreachable (client pointed at a dead
  port) — no throw.
- Returns `null` when `GET /api/spaces` responds non-2xx (does not
  misinterpret an error body as "no spaces").

**Verification:** `bun test tests/tinstarCanvas.test.ts` green.

### U3. Daemon: resolve space at startup, place widgets there, inject env, teardown on signal

**Goal:** Wire the daemon to use a configured space for all widgets, expose it
to shell nodes, and clean up its widgets on shutdown.

**Requirements:** R1, R3, R7; consumes U1, U2

**Dependencies:** U1, U2

**Files:**
- Modify: `src/daemon.ts` (`DaemonOpts`, startup space resolve,
  `ensureWidgetLoop`, created-widget tracking, signal handler)
- Modify: `src/main.ts` (read `WHOACHART_SPACE`, pass to daemon)
- Modify: `src/context.ts` (`buildEnv` injects `WHOACHART_TINSTAR_SPACE`)
- Test: `tests/daemonControl.test.ts` (or a focused `tests/daemonSpace.test.ts`)
- Test: `tests/context.test.ts` (env injection)

**Approach:**
- `DaemonOpts` gains optional `space?: string`. At `start()`, if `space` is set,
  call `client.ensureSpace(space)` and store the resolved `spaceId`
  (`this.spaceId`). On `null`, log a clear line and leave `spaceId` undefined
  (fallback to active-space placement — R2).
- `ensureWidgetLoop` passes `spaceId: this.spaceId` in the
  `ensureBrowserWidget` opts, and records `{ chart, widgetId }` on success in a
  `this.createdWidgets` list (KTD3).
- `buildEnv` (`src/context.ts`) adds `WHOACHART_TINSTAR_SPACE` from the daemon —
  the daemon must make the resolved id reachable to `buildEnv`. Decide the seam:
  pass the id into the node-execution path the same way `WHOACHART_PORT`-style
  values flow, or read from `process.env.WHOACHART_TINSTAR_SPACE` set by the
  daemon at startup. **Execution note:** confirm the existing
  `buildEnv(marble, node, contextPath)` call sites — if threading a new arg is
  invasive, set `process.env.WHOACHART_TINSTAR_SPACE` in the daemon after
  resolve and have `buildEnv` read it (env is already spread first in
  `buildEnv`). Pick the lower-churn seam at implementation time.
- `main.ts` reads `WHOACHART_SPACE` and passes it as `space` in `DaemonOpts`.
- Register `SIGTERM`/`SIGINT` handlers (only when `space` set) that
  `DELETE` each tracked widget via a new `TinstarClient.deleteBrowserWidget(id)`
  (see U6 — shared with teardown) then exit. Make handler idempotent and
  best-effort (never hang shutdown on a slow Tinstar).

**Patterns to follow:** `ensureWidgetLoop`'s tolerate-and-retry logging;
`buildEnv`'s env spread; `panToSession`'s defensive fetch.

**Test scenarios:**
- With `space` set and a `FakeCanvas` whose `ensureSpace` returns `"sp_test"`,
  `ensureWidgetLoop` calls `ensureBrowserWidget` with `spaceId: "sp_test"`
  (assert on the fake's recorded opts).
- With `space` set but `ensureSpace` returning `null`, widgets are still
  ensured with no `spaceId` (graceful fallback, no throw) and a fallback log
  line is emitted.
- With `space` unset, `ensureBrowserWidget` is called with no `spaceId`
  (unchanged behavior).
- `buildEnv` includes `WHOACHART_TINSTAR_SPACE` with the resolved id when set,
  and omits it (or empty) when unset. Covers R3.
- Daemon tracks created widget ids: after ensuring widgets for N charts,
  `createdWidgets` has N entries with the returned ids.
- Shutdown handler: invoking the registered teardown deletes exactly the
  tracked widget ids via the fake (assert the fake's `deleted` list equals the
  tracked ids). (Test the handler function directly; do not actually raise
  signals in the test process.)

**Verification:** `bun test tests/daemonControl.test.ts tests/context.test.ts`
green; full `bun test` green.

### U4. Self-containment guard test

**Goal:** Fail the suite if any test would hit a real (non-fake) Tinstar.

**Requirements:** R4

**Dependencies:** none (independent guard)

**Files:**
- Create: `tests/selfContained.test.ts`

**Approach:** Enforce that no test constructs a network-live `TinstarClient`
against the default base URL. Concrete mechanism (pick the most robust at
implementation time, prefer the first that works under Bun):
- **Primary:** a test that asserts the *default* `baseUrl` is never reachable
  in CI by confirming the suite does not depend on `:5273` — implemented by
  asserting `new TinstarClient()` is **not** used anywhere in `tests/` via a
  source scan (`Bun.Glob` over `tests/**/*.ts`, fail if a test file contains
  `new TinstarClient()` with no argument outside this guard file and outside
  the opt-in IT file).
- The scan is deterministic and offline. Document in the test why argless
  construction is banned (it points at the live workspace).

**Patterns to follow:** existing pure tests in `tests/` that read files
(`tests/jiraChart.test.ts` reads a chart file with `readFileSync`).

**Test scenarios:**
- Scanning `tests/**/*.ts` finds zero argless `new TinstarClient()`
  constructions (excluding `tests/selfContained.test.ts` itself and the opt-in
  integration test which is gated). Fails with a clear message naming the
  offending file if one is added later.

**Verification:** `bun test tests/selfContained.test.ts` green; deliberately
adding `new TinstarClient()` to a scratch test makes it fail (manual spot-check,
not committed).

### U5. Opt-in integration test (`WHOACHART_IT=1`)

**Goal:** Prove the real daemon→Tinstar widget flow + teardown end-to-end,
without touching Jira/Claude, and skip cleanly when not opted in.

**Requirements:** R5

**Dependencies:** U1, U2, U3, U6

**Files:**
- Create: `tests/integration/spaceWidget.it.test.ts`
- Create: `examples/_it-sandbox.yaml` (trivial source→end chart) OR build the
  chart inline in the test via the chart store API (prefer a fixture file under
  a test fixtures dir to avoid registering a demo chart in `examples/`)

**Approach:** Guard the whole suite behind `WHOACHART_IT=1` — when unset, call
`test.skip`/early-return so `bun test` stays offline-safe. When set: construct a
real `TinstarClient(process.env.TINSTAR_URL ?? "http://localhost:5273")`, run a
daemon (or call `ensureSpace` + `ensureBrowserWidget` directly) for a trivial
`source → end` chart with `WHOACHART_SPACE=_testing`, assert via
`GET /api/state` that a `whoachart-*` browser widget exists with the resolved
`_testing` `spaceId`, then run the teardown (U6) and assert the space's widgets
are gone. The sandbox chart has **no** agent/shell-external nodes, so nothing
reaches Jira/Claude.

**Execution note:** Start from a failing assertion that the widget appears in
`_testing`, then make the wiring satisfy it. Keep `afterAll` teardown
unconditional so a mid-test failure still cleans `_testing`.

**Patterns to follow:** `tests/tinstarCanvas.test.ts` `Bun.serve` lifecycle for
structure (but here the server is the *real* Tinstar, reached only under the
flag); fixture-chart shape from `examples/marble-demo.yaml`.

**Test scenarios:**
- Skipped entirely when `WHOACHART_IT` is unset (the suite reports skip, not
  pass-without-running; verify by running `bun test` normally — it must remain
  green and offline).
- (Under `WHOACHART_IT=1`, requires a live Tinstar) widget lands in `_testing`
  with the right `spaceId`; teardown removes it; `_testing` ends empty of
  whoachart widgets.

**Verification:** `bun test` (no flag) stays green and makes no `:5273` calls
(re-confirm with the before/after `/api/state` count check used this session);
`WHOACHART_IT=1 bun test tests/integration/spaceWidget.it.test.ts` green against
a running Tinstar.

### U6. `bin/whoachart-teardown` + shared `deleteBrowserWidget`/session cleanup

**Goal:** A deterministic, idempotent CLI to empty a space of whoachart widgets
and sessions, reusing one client deletion path.

**Requirements:** R6; supports R7 (shared deletion helper)

**Dependencies:** U1 (client structure)

**Files:**
- Create: `bin/whoachart-teardown` (Bun executable script)
- Modify: `src/tinstar.ts` (`deleteBrowserWidget(id)`, optional
  `stopSession`/`deleteSession` reuse, a `widgetsInSpace(spaceId)` helper or
  inline enumeration)
- Test: `tests/tinstarCanvas.test.ts` (delete helper) and
  `tests/teardown.test.ts` (script logic against a `Bun.serve` fake)

**Approach:** Add `deleteBrowserWidget(id)` → `DELETE /api/browser-widgets/:id`
(best-effort, returns ok/false). The teardown script: resolve the space id by
name (reuse `ensureSpace` but treat "missing" as "nothing to do" — do NOT create
it during teardown; add a non-creating `findSpace(name)` or have `ensureSpace`
take a `create=false` option), enumerate `GET /api/state` for browser widgets
(and sessions) whose `spaceId === <id>`, and DELETE each widget +
`POST /api/sessions/:name/stop` / `DELETE /api/sessions/:name` for sessions.
Default space arg `_testing`; accept an override argv. Print a summary
(`removed N widgets, M sessions`). Idempotent: a second run removes nothing and
exits 0.

**Execution note:** factor the enumerate-and-delete into a testable function in
`src/` that both the script and the daemon's signal handler (U3) can call, so
the logic is unit-tested without spawning the script.

**Patterns to follow:** `src/cli.ts` arg parsing for the script entry; the
defensive fetch pattern in `panToSession`.

**Test scenarios:**
- `deleteBrowserWidget` issues `DELETE /api/browser-widgets/:id` and returns ok
  on 2xx, false on failure (fake server).
- Teardown function: given a fake `/api/state` with 3 widgets in `_testing` and
  1 in another space, deletes exactly the 3 and leaves the other untouched.
- Teardown when the space has no widgets: deletes nothing, exits 0 (idempotent).
- Teardown when the space doesn't exist: no-op, exits 0, does NOT create it.
- Sessions in the target space are stopped/deleted (assert the fake records the
  stop/delete calls).

**Verification:** `bun test tests/teardown.test.ts tests/tinstarCanvas.test.ts`
green; `bin/whoachart-teardown _testing` against a seeded `_testing` empties it
and a re-run is a clean no-op.

---

## System-Wide Impact

- **`CanvasControl` interface grows** (`ensureSpace`, `deleteBrowserWidget`,
  `spaceId` opt). `FakeCanvas` and every `new Daemon({ client })` test site
  must satisfy the wider interface — all current sites use `FakeCanvas`, so
  updating the fake covers them (verified this session: no test constructs a
  real client).
- **`DaemonOpts` grows** (`space?`). Existing constructions omit it → unchanged
  behavior. `main.ts` is the only production caller.
- **`buildEnv` gains an env var.** Shell nodes see `WHOACHART_TINSTAR_SPACE`
  only when the daemon set a space; charts that ignore it are unaffected.
- **Backward compatibility:** every new behavior is gated on `WHOACHART_SPACE`
  being set. Unset = today's exact behavior. No migration.

---

## Risks & Mitigations

- **Risk:** SIGTERM handler hangs shutdown on a slow/unreachable Tinstar.
  **Mitigation:** best-effort deletes with a short timeout; never `await`
  indefinitely; the process exits regardless.
- **Risk:** `ensureSpace` race — two daemons creating `_testing` concurrently.
  **Mitigation:** create is idempotent at the name level for our use; if
  Tinstar returns a duplicate, resolve by name afterward. Low concern for a
  single-user dev box.
- **Risk:** the opt-in IT test accidentally runs in CI and fails (no Tinstar).
  **Mitigation:** hard skip when `WHOACHART_IT` unset; the `.it.test.ts`
  suffix + skip-guard keeps `bun test` offline-safe (R5).
- **Risk:** teardown deletes widgets a human placed in `_testing`.
  **Mitigation:** scope teardown to `whoachart-*`-titled widgets (and
  whoachart-spawned sessions) rather than everything in the space; document the
  `_testing`-is-a-sandbox convention.

---

## Test Strategy

- Unit tests run fully offline with fakes (`bun test`), including the new
  self-containment guard (U4).
- The real Tinstar round-trip is isolated to the opt-in IT (U5), skipped by
  default.
- After implementation, re-run the session's empirical check: snapshot
  `:5273` `/api/state` widget/run/session counts before and after a full
  `bun test` — they must be unchanged.

---

## Verification (feature-complete when)

- `bun test` is green and leaves live Tinstar `:5273` unchanged.
- Running the daemon with `WHOACHART_SPACE=_testing` places all chart widgets
  in `_testing` (not the active workspace), and stopping the daemon removes
  them.
- `bin/whoachart-teardown _testing` empties the space and is a clean no-op on
  re-run.
- `WHOACHART_IT=1 bun test <it>` passes against a running Tinstar.
