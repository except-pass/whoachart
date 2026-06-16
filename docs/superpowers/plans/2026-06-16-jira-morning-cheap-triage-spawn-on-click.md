# jira-morning: cheap triage + spawn-on-click — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `jira-morning` triage cheap (a `claude -p` classifier, zero sessions), spawn a real Tinstar workon session only on demand when Will clicks "work on this", and make the drawer's focus button report honestly when there is no live session to focus.

**Architecture:** Two independent changes. (1) A TypeScript "honest focus" fix: `TinstarClient.panToSession` checks `/api/state` for a live run before broadcasting a viewport directive, and the result is plumbed through `Daemon.focusSession` → control API as distinct status codes. (2) A YAML rewrite of `examples/jira-morning.yaml`: the `triage` agent node becomes a cheap `claude -p` shell node, the Jira-write lanes are removed, and a `spawn-workon` shell node creates a task+session seeded with the marble context and sets `_session` to the live session.

**Tech Stack:** TypeScript on Bun (`bun test`), YAML charts parsed by `src/schema.ts` and statically checked by `src/lint.ts`.

## Global Constraints

- Runtime is **Bun**; tests run with `bun test`. No new dependencies.
- Shell-node emits MUST be a **single line** on stdout — the engine parses only the last stdout line (`-c` on every emitting `jq`).
- Shell-node `timeout` values are **milliseconds**.
- Secrets come from `eval "$(clavis get jira/prod)"` at runtime; never write creds into the chart file or marble context.
- Tinstar base URL in the daemon is `TINSTAR_URL` (default `http://localhost:5273`); inside chart shell scripts use `${TINSTAR_URL:-http://localhost:5273}`.
- A spawned session's tmux name must be `[a-z0-9-]` only (lowercased Jira key, e.g. `cmt-716`); this equals the `run.sessionId` Tinstar matches on.
- Design doc: `docs/superpowers/specs/2026-06-16-jira-morning-cheap-triage-spawn-on-click-design.md`.

---

## Task 1: Honest focus — `panToSession` liveness check + status plumbing

Make focusing a marble's session report `ok` / `session-gone` / `unreachable` instead of a silent success. This is self-contained and reviewable without the chart change.

**Files:**
- Modify: `src/tinstar.ts` (the `CanvasControl` interface ~`src/tinstar.ts:51-54` and `TinstarClient.panToSession` ~`src/tinstar.ts:137-144`)
- Modify: `src/daemon.ts` (`focusSession` ~`src/daemon.ts:472-478`)
- Modify: `src/controlApi.ts` (focus-session route ~`src/controlApi.ts:148-153`)
- Modify: `tests/fakes.ts` (`FakeCanvas` ~`tests/fakes.ts:3-16`)
- Test: `tests/tinstarCanvas.test.ts`, `tests/daemonControl.test.ts`

**Interfaces:**
- Produces: `CanvasControl.panToSession(sessionName: string): Promise<"ok" | "no-run" | "unreachable">` and `Daemon.focusSession(name, id): Promise<"ok" | "no-session" | "session-gone" | "unreachable">`.
- Consumes: Tinstar `GET /api/state` returns `{ runs: Array<{ sessionId: string, ... }>, ... }`; a session is "live/focusable" iff some `run.sessionId === sessionName`.

- [ ] **Step 1: Update `tests/tinstarCanvas.test.ts` to drive the new contract**

Replace the existing `panToSession` tests and teach the fake state server about `runs`. Add a module-level `runs` array reset in `beforeEach`, include it in the `/api/state` response, and replace the three relevant tests:

```ts
// at top, with the other mutable fixtures:
let runs: any[] = []

// in beforeEach, alongside `widgets = []`:
runs = []

// in the fetch handler, replace the /api/state branch with:
if (req.method === "GET" && url.pathname === "/api/state") {
  return Response.json({ browserWidgets: widgets, runs })
}
```

Replace the two existing `panToSession` tests (the `toBe(true)` and the unreachable one) with:

```ts
test("panToSession focuses when a live run matches the session", async () => {
  runs.push({ sessionId: "wc-demo-m1" })
  const c = new TinstarClient(base)
  expect(await c.panToSession("wc-demo-m1")).toBe("ok")
  expect(viewportCalls[0]).toEqual({ action: "focus", sessionName: "wc-demo-m1" })
})

test("panToSession returns no-run when no live run matches", async () => {
  const c = new TinstarClient(base)
  expect(await c.panToSession("wc-demo-gone")).toBe("no-run")
  expect(viewportCalls).toHaveLength(0)
})

test("panToSession returns unreachable when tinstar is down", async () => {
  const c = new TinstarClient("http://localhost:1")
  expect(await c.panToSession("x")).toBe("unreachable")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/tinstarCanvas.test.ts`
Expected: FAIL — the current `panToSession` returns a boolean (`true`/`false`), so `toBe("ok")` / `toBe("no-run")` / `toBe("unreachable")` all fail.

- [ ] **Step 3: Change `panToSession` and the `CanvasControl` interface in `src/tinstar.ts`**

Update the interface:

```ts
export interface CanvasControl {
  ensureBrowserWidget(opts: EnsureWidgetOpts): Promise<{ widgetId: string }>
  panToSession(sessionName: string): Promise<"ok" | "no-run" | "unreachable">
}
```

Replace the `panToSession` method body:

```ts
async panToSession(sessionName: string): Promise<"ok" | "no-run" | "unreachable"> {
  // A session is focusable only if Tinstar still has a run for it — the
  // frontend resolves the focus directive by matching run.sessionId. If the
  // run is gone, the broadcast would silently no-op, so report it instead.
  const state = await fetch(`${this.baseUrl}/api/state`)
    .then((r) => r.json() as Promise<{ runs?: Array<{ sessionId?: string }> }>)
    .catch(() => null)
  if (!state) return "unreachable"
  if (!(state.runs ?? []).some((r) => r?.sessionId === sessionName)) return "no-run"
  const res = await fetch(`${this.baseUrl}/api/canvas/viewport`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "focus", sessionName }),
  }).catch(() => null)
  return res && res.ok ? "ok" : "unreachable"
}
```

- [ ] **Step 4: Update `FakeCanvas` in `tests/fakes.ts`**

```ts
export class FakeCanvas implements CanvasControl {
  ensured: EnsureWidgetOpts[] = []
  panned: string[] = []
  failEnsure = false
  panResult: "ok" | "no-run" | "unreachable" = "ok"
  async ensureBrowserWidget(opts: EnsureWidgetOpts): Promise<{ widgetId: string }> {
    if (this.failEnsure) throw new Error("tinstar down")
    this.ensured.push(opts)
    return { widgetId: "browser-fake" }
  }
  async panToSession(name: string): Promise<"ok" | "no-run" | "unreachable"> {
    this.panned.push(name)
    return this.panResult
  }
}
```

- [ ] **Step 5: Update `Daemon.focusSession` in `src/daemon.ts`**

```ts
async focusSession(name: string, id: string): Promise<"ok" | "no-session" | "session-gone" | "unreachable"> {
  const m = await this.rt(name).store.load(id)
  const session = m?.context._session
  if (typeof session !== "string" || !session) return "no-session"
  const result = await this.opts.client.panToSession(session)
  if (result === "ok") return "ok"
  if (result === "no-run") return "session-gone"
  return "unreachable"
}
```

- [ ] **Step 6: Update the focus-session route in `src/controlApi.ts`**

```ts
// POST focus the Tinstar canvas on the marble's agent session
if (req.method === "POST" && p[4] && p[5] === "focus-session") {
  const result = await daemon.focusSession(name, p[4])
  if (result === "ok") return json({ ok: true })
  if (result === "no-session") return json({ error: "marble has no linked session" }, 404)
  if (result === "session-gone") return json({ error: "session is no longer open on the canvas" }, 409)
  return json({ error: "tinstar unreachable" }, 502)
}
```

- [ ] **Step 7: Add a `session-gone` case to `tests/daemonControl.test.ts`**

The existing test (`tests/daemonControl.test.ts:260-276`) already covers `no-session` and `ok` (FakeCanvas defaults `panResult = "ok"`, so the `expect(... ).toBe("ok")` at line 274 still holds). Append a `session-gone` assertion at the end of that test, before its closing `})`:

```ts
  // session present in context but no live run on the canvas → session-gone
  canvas.panResult = "no-run"
  expect(await d.focusSession("gatey", m2.id)).toBe("session-gone")
```

- [ ] **Step 8: Run the full affected suites and verify green**

Run: `bun test tests/tinstarCanvas.test.ts tests/daemonControl.test.ts tests/controlApi.test.ts`
Expected: PASS. (`controlApi.test.ts` is included to confirm the route change didn't break existing focus-session coverage.)

- [ ] **Step 9: Commit**

```bash
git add src/tinstar.ts src/daemon.ts src/controlApi.ts tests/fakes.ts tests/tinstarCanvas.test.ts tests/daemonControl.test.ts
git commit -m "fix(focus): report no-run vs unreachable so a dead session toasts instead of silently no-op

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rewrite the `jira-morning` chart — cheap triage + spawn-on-click

Replace the agent-triage + Jira-write lanes with a `claude -p` classifier and an on-demand `spawn-workon`. Verified by a parse/lint/structure test that fails on the current chart and passes after the rewrite.

**Files:**
- Modify: `examples/jira-morning.yaml` (header comment lines 1-15; nodes/edges from line 120 to EOF)
- Test: `tests/jiraChart.test.ts` (create)

**Interfaces:**
- Consumes: `parseChart(yaml: string): Chart` from `src/schema.ts`; `lintChart(chart: Chart): { warnings: Array<{ code: string, ... }> }` from `src/lint.ts`.
- Produces: the chart's runtime contract — `triage` emits `{next: "fyi"|"attention", merge:{triage_note, issue_type}}`; `spawn-workon` emits `{merge:{_session, workon_task}}` and the marble ends at `in-session`.

- [ ] **Step 1: Write the guard test `tests/jiraChart.test.ts`**

```ts
// tests/jiraChart.test.ts — guards the jira-morning rewrite: cheap shell triage,
// no agent/Jira-write nodes, spawn-workon present, and lint stays clean.
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseChart } from "../src/schema"
import { lintChart } from "../src/lint"

function chart() {
  const yaml = readFileSync(join(import.meta.dir, "../examples/jira-morning.yaml"), "utf8")
  return parseChart(yaml)
}

test("jira-morning: triage is a cheap shell node, no agent or Jira-write nodes", () => {
  const c = chart()
  const triage = c.nodes.find((n) => n.id === "triage")
  expect(triage?.type).toBe("shell")
  expect(c.nodes.some((n) => n.type === "agent")).toBe(false)
  expect(c.nodes.some((n) => n.id === "post-comment")).toBe(false)
  expect(c.nodes.some((n) => n.id === "run-claude")).toBe(false)
  expect(c.nodes.some((n) => n.id === "spawn-workon")).toBe(true)
  expect(c.nodes.some((n) => n.id === "in-session")).toBe(true)
})

test("jira-morning: review routes to spawn-workon and skip only", () => {
  const c = chart()
  const fromReview = c.edges.filter((e) => e.from === "review").map((e) => e.name).sort()
  expect(fromReview).toEqual(["skip", "workon"])
})

test("jira-morning parses and lints clean", () => {
  expect(lintChart(chart()).warnings).toEqual([])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/jiraChart.test.ts`
Expected: FAIL — current `triage.type` is `"agent"`, `post-comment`/`run-claude` still exist, `spawn-workon`/`in-session` do not, and the review edges are the old set.

- [ ] **Step 3: Update the chart header comment (`examples/jira-morning.yaml` lines 1-15)**

Replace the opening comment block (lines 1-15, ending just before `name: jira-morning`) with:

```yaml
# examples/jira-morning.yaml
#
# Morning Jira triage. Will manually submits a scan (UI or curl); it finds
# issues needing his attention since the last scan (assigned-to-him updated,
# or mentioning him) and spawns ONE MARBLE PER ISSUE at start=triage-intake
# (a source node: its form is the lane's typed interface, validated on submit).
# A CHEAP `claude -p` classifier (no Tinstar session) decides fyi vs. needs-
# attention. Will reviews the flagged ones and clicks "work on this" to spin up
# a real Tinstar task + session, seeded with the marble's context. The chart is
# READ-ONLY on Jira — replies happen inside the spawned session or by hand.
#
# Trigger: manual only (no cron). Design:
#   docs/superpowers/specs/2026-06-16-jira-morning-cheap-triage-spawn-on-click-design.md
# Secrets: scripts run `eval "$(clavis get jira/prod)"` at runtime; creds
#          never appear in this file or in marble context.
# State:   ~/.local/state/whoachart/jira-morning.last — ISO time of the last
#          SUCCESSFUL scan; written only after a scan completes, so a failed
#          scan or skipped weekend is covered by the next run's window.
```

- [ ] **Step 4: Replace the `triage` node (`examples/jira-morning.yaml` lines 120-143)**

Replace the entire `- id: triage` agent node with this shell node:

```yaml
  # Cheap triage: a single headless `claude -p` per issue (NO Tinstar session).
  # Run inline so the engine's concurrency cap (default 4) throttles a morning
  # batch to 4-at-a-time rather than launching one process per ticket at once.
  - id: triage
    type: shell
    name: Triage
    color: "#60a5fa"
    timeout: 180000 # ms — inline claude -p; engine cap bounds concurrency
    config:
      on_enter: |
        set -euo pipefail
        KEY=$(jq -r .key "$WHOACHART_CONTEXT")
        SUMMARY=$(jq -r .summary "$WHOACHART_CONTEXT")
        REASON=$(jq -r .reason "$WHOACHART_CONTEXT")
        eval "$(clavis get jira/prod)"
        # issue_type captured here so spawn-workon needn't re-fetch Jira.
        ITYPE=$(curl -sf -u "$JIRA_PROD_EMAIL:$JIRA_PROD_TOKEN" \
          "$JIRA_PROD_URL/rest/api/2/issue/$KEY?fields=issuetype" | jq -r .fields.issuetype.name)

        PROMPT="Triage Jira issue $KEY: $SUMMARY (reason: $REASON). Use the Atlassian Jira MCP tools (e.g. mcp__atlassian__getJiraIssue) to fetch the issue and its full comment thread. Decide whether this needs Will's attention. It does NOT if it is a bare status/field change, FYI traffic, an already-resolved thread, or the last word is already Will's. Reply with EXACTLY ONE LINE of JSON and nothing else: {\"attention\": true|false, \"why\": \"<one sentence>\"}"

        # Parse the last brace-delimited line of claude's output. Default to
        # attention=true on empty/unparseable output so nothing is dropped silently.
        OUT=$(claude -p "$PROMPT" --allowedTools "mcp__atlassian__*" 2>/dev/null \
              | grep -oE '\{.*\}' | tail -1 || true)
        ATT=$(jq -r '.attention // true' <<<"${OUT:-{}}" 2>/dev/null || echo true)
        WHY=$(jq -r '.why // "triage output unparseable — review manually"' <<<"${OUT:-{}}" 2>/dev/null \
              || echo "triage output unparseable — review manually")

        NEXT=fyi; [ "$ATT" = "true" ] && NEXT=attention
        # -c: the emit MUST be a single line (engine parses last stdout line only)
        jq -cn --arg n "$NEXT" --arg w "$WHY" --arg t "$ITYPE" \
          '{next: $n, merge: {triage_note: $w, issue_type: $t}}'
```

- [ ] **Step 5: Replace the `review` node (`examples/jira-morning.yaml` lines 145-156)**

```yaml
  - id: review
    type: human
    name: Will reviews
    present:
      - { key: key, as: text }
      - { key: summary, as: text }
      - { key: url, as: link }
      - { key: reason, as: text }
      - { key: triage_note, as: text }
      - { key: issue_type, as: text }
    config: {}
```

- [ ] **Step 6: Replace the `run-claude` + `await-claude` + `post-comment` nodes (`examples/jira-morning.yaml` lines 158-241) with `spawn-workon`**

Delete the `run-claude`, `await-claude`, and `post-comment` node blocks (the comment block at 158-163, then nodes 164-241) and put this single node in their place:

```yaml
  # On "work on this": full /workon breakout — a Tinstar board task under the
  # dev epic plus a session in cmsandbox (worktree; bugsearcher hand for Bugs),
  # seeded with the marble's context. Sets _session to the now-live session and
  # best-effort pans the canvas to it; the drawer's focus button re-pans later.
  - id: spawn-workon
    type: shell
    name: Spawn workon
    timeout: 60000 # ms
    config:
      on_enter: |
        set -euo pipefail
        TINSTAR="${TINSTAR_URL:-http://localhost:5273}"
        KEY=$(jq -r .key "$WHOACHART_CONTEXT")
        SUMMARY=$(jq -r .summary "$WHOACHART_CONTEXT")
        URL=$(jq -r .url "$WHOACHART_CONTEXT")
        NOTE=$(jq -r '.triage_note // ""' "$WHOACHART_CONTEXT")
        ITYPE=$(jq -r '.issue_type // ""' "$WHOACHART_CONTEXT")
        LKEY=$(tr 'A-Z' 'a-z' <<<"$KEY")

        EPIC=$(curl -sf "$TINSTAR/api/state" \
          | jq -re '[.epics[] | select((.name|ascii_downcase)=="dev")][0].id')

        # Task may already exist from an earlier workon — tolerate a refusal.
        jq -cn --arg id "task-$LKEY" --arg n "$KEY: $SUMMARY" --arg e "$EPIC" --arg u "$URL" \
          '{id:$id, name:$n, epicId:$e, externalUrl:$u}' \
          | curl -s -X POST "$TINSTAR/api/tasks" -H 'Content-Type: application/json' -d @- >/dev/null || true

        HAND=null
        PROMPT="Work the Jira ticket $KEY: $SUMMARY ($URL). Morning triage flagged it: $NOTE. Use the Atlassian Jira MCP tools (e.g. mcp__atlassian__getJiraIssue) to fetch full details including comments and attachments, then propose and carry out an approach."
        if [ "$ITYPE" = "Bug" ]; then
          HAND='"bugsearcher"'
          PROMPT="Investigate Jira bug $KEY: $SUMMARY ($URL). Morning triage flagged it: $NOTE. Use the Atlassian Jira MCP tools (e.g. mcp__atlassian__getJiraIssue) to fetch full details including comments and attachments. Diagnose the root cause — find where and why it fails. Deliver reproduction steps, root-cause location, and the failure path."
        fi

        jq -cn --arg n "$LKEY" --arg t "task-$LKEY" --arg p "$PROMPT" --argjson h "$HAND" \
          '{name:$n, backend:"tmux", cliTemplate:"Claude (multi-agent)", project:"cmsandbox",
            worktree:true, taskId:$t, hand:$h, prompt:$p}' \
          | curl -sf -X POST "$TINSTAR/api/sessions" -H 'Content-Type: application/json' -d @- >/dev/null

        # Best-effort pan; the drawer focus button is the reliable re-focus path.
        jq -cn --arg s "$LKEY" '{action:"focus", sessionName:$s}' \
          | curl -s -X POST "$TINSTAR/api/canvas/viewport" -H 'Content-Type: application/json' -d @- >/dev/null || true

        # _session points at the NOW-LIVE session, so the drawer button works.
        # -c: the emit MUST be a single line (engine parses last stdout line only)
        jq -cn --arg s "$LKEY" --arg t "task-$LKEY" \
          '{merge: {_session: $s, workon_task: $t}}'
```

- [ ] **Step 7: Fix the end nodes (`examples/jira-morning.yaml` lines 243-271)**

Keep `quiet-day`, `scan-done`, `fyi`, `skipped`. Delete the `posted` and `investigated` end nodes. Add an `in-session` end node. The end-node section should read:

```yaml
  - id: quiet-day
    type: end
    name: Quiet day
    config: { outcome: success }

  - id: scan-done
    type: end
    name: Scan done
    config: { outcome: success }

  - id: fyi
    type: end
    name: FYI only
    config: { outcome: success }

  - id: skipped
    type: end
    name: Skipped
    config: { outcome: warning }

  - id: in-session
    type: end
    name: In session
    config: { outcome: success }
```

- [ ] **Step 8: Rewrite the `edges` section (`examples/jira-morning.yaml` lines 273-288)**

```yaml
edges:
  - { from: scan, to: query-jira }
  - { from: query-jira, to: quiet-day, name: quiet }
  - { from: query-jira, to: scan-done, name: done }
  - { from: triage-intake, to: triage }
  - { from: triage, to: review, name: attention }
  - { from: triage, to: fyi, name: fyi }
  - { from: review, to: spawn-workon, name: workon }
  - { from: review, to: skipped, name: skip }
  - { from: spawn-workon, to: in-session }
```

- [ ] **Step 9: Run the guard test and verify green**

Run: `bun test tests/jiraChart.test.ts`
Expected: PASS — all three tests green (shell triage, review edges `[skip, workon]`, lint clean).

If `lintChart(...).warnings` is non-empty, read each `warning.code`/`warning.message`: the likely culprits are an unreachable node (an orphaned old node not deleted) or a non-end node missing an outgoing edge. Fix the chart, not the test.

- [ ] **Step 10: Run the broader suite to confirm nothing else parses the chart and breaks**

Run: `bun test tests/lint.test.ts tests/schema.test.ts tests/jiraChart.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add examples/jira-morning.yaml tests/jiraChart.test.ts
git commit -m "feat(jira-morning): cheap claude -p triage + spawn-on-click workon

Triage no longer spawns a session per issue; sessions spawn on demand via the
review 'work on this' edge, seeded with the marble context and set as _session
so the drawer focus button works. Drops the chart's Jira-write lanes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 12: Manual verification (no commit; requires a daemon restart)**

The whoachart daemon loads charts once at boot, so it must be restarted to pick up the rewrite (a chart edited after boot returns 409 on POST / 404 on PUT). Identify the running daemon (`ss -ltnp | grep 5330`), restart it (`WHOACHART_CHARTS=examples bun run src/main.ts`, or however it is currently launched), then:
1. Submit a scan from the UI (or `curl -X POST .../api/charts/jira-morning/marbles` with `start: scan`). Confirm **no `wc-jira-morning-*` sessions appear** in Tinstar `/api/state` during triage (triage spawns none).
2. On a marble that reaches `review`, click **"work on this"**. Confirm a `task-<key>` and a `<key>` session appear in Tinstar and the canvas pans to it.
3. Open the marble's drawer and click **⌖ open session on canvas** — confirm it re-pans (now that `_session` is a live session).
4. Stop that session in Tinstar, then click the focus button again — confirm the toast reads **"session is no longer open on the canvas"** instead of doing nothing.

---

## Self-Review

**Spec coverage:**
- Cheap `claude -p` classify triage (no session) → Task 2 Step 4. ✓
- Marble carries context; triage adds `triage_note`/`issue_type` → Task 2 Step 4. ✓
- `review` with `work on this`/`skip`, no draft/approve → Task 2 Steps 5, 8. ✓
- Full workon on click, seeds prompt, sets `_session`, pans → Task 2 Step 6. ✓
- Drops all Jira-write lanes + removes run-claude/await-claude/investigated/posted → Task 2 Steps 6, 7, 8. ✓
- Honest focus (`no-run`→`session-gone`, 409, clear toast) → Task 1. ✓
- Files listed in spec (`tinstar.ts`, `daemon.ts`, `controlApi.ts`, `jira-morning.yaml`) all covered; `agent.ts` untouched. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete content; the only judgment call (lint warning triage in Task 2 Step 9) gives concrete codes to look for. ✓

**Type consistency:** `panToSession` returns `"ok" | "no-run" | "unreachable"` everywhere (interface, impl, fake, daemon consumer). `focusSession` returns `"ok" | "no-session" | "session-gone" | "unreachable"` in both `daemon.ts` and the control-API mapping. Chart emit keys (`triage_note`, `issue_type`, `_session`, `workon_task`) are consistent between producer (`triage`/`spawn-workon`) and consumer (`spawn-workon` reads `triage_note`/`issue_type`; drawer reads `_session`). ✓
