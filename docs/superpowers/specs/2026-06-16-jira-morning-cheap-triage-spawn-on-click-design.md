# jira-morning: cheap triage + spawn-on-click

**Date:** 2026-06-16
**Status:** approved (design)
**Supersedes parts of:** [2026-06-11-jira-morning-chart-design.md](2026-06-11-jira-morning-chart-design.md)

## Problem

The `jira-morning` chart triages each morning's Jira issues. Today's `triage`
node is an **agent** node (`type: agent`), which spawns a full Tinstar session
(`wc-jira-morning-<marble-id>`) *per issue* just to read the ticket and draft a
reply. A morning batch of ~30 tickets spawns ~30 sessions — Will saw the pile
and (reasonably) read them as junk. Each session is also torn down the moment
the agent signals (`Daemon.signal` stops agent-node sessions without
`keep_session`), so by the time a marble reaches the `review` gate its
`context._session` points at a **session that no longer exists**.

That dead `_session` is also why the drawer's `⌖ open session on canvas` button
appears to do nothing:

- The button calls `focusSession` → `panToSession` (`src/ui/public/app.js:75`,
  `src/daemon.ts:472`, `src/tinstar.ts:137`), which POSTs a viewport directive to
  Tinstar `/api/canvas/viewport`.
- Tinstar resolves it client-side by matching a run where
  `run.sessionId === _session` (`InfiniteCanvas.tsx:361`). No live session →
  no match → camera doesn't move.
- `/api/canvas/viewport` returns `{ok:true}` unconditionally, so the daemon
  reports success and **no error toast fires** — a silent no-op.

## Goals

1. **Triage spawns zero sessions.** Make triage cheap.
2. **Sessions are created on demand**, only for tickets Will chooses to work,
   seeded with everything the marble already knows about the ticket.
3. **The focus button tells the truth** — re-focus a live session, or say
   plainly when there is no live session to focus.

## Non-goals

- The chart no longer posts to Jira at all. It is **read-only** on Jira. Replies
  happen inside a spawned session (the agent can post) or by hand. The
  `draft` / `rationale` / `approve` / `post-comment` / `revise` lanes are removed.
- No quick "investigate without a session" path. The uncommitted
  `run-claude` / `await-claude` / `investigated` detached-investigation nodes are
  removed (superseded by spawn-on-click).

## New per-issue flow

```
scan → query-jira → (triage-intake fan-out: one marble per issue)
  → triage          [shell: claude -p, classify only]
       ├─ fyi       → end "FYI only"
       └─ attention → review [human: "Will reviews"]
            ├─ work on this → spawn-workon [shell] → end "In session"
            └─ skip         → end "Skipped"
```

`scan`, `query-jira`, `triage-intake`, and the `quiet-day` / `scan-done` end
nodes are unchanged from today.

## Component 1 — `triage` becomes a cheap shell node

Replace the `agent` node with a `shell` node that runs `claude -p` **inline**
(not detached). Inline is deliberate: the engine's concurrency cap
(`Engine.cap`, default 4 — `src/engine.ts:82`) then throttles triage to at most
4 concurrent `claude -p` processes, so a 30-ticket morning runs 4-at-a-time
rather than launching 30 at once. This is the cost-bounding mechanism.

```yaml
- id: triage
  type: shell
  name: Triage
  color: "#60a5fa"
  timeout: 180000 # ms — inline claude -p; cap=4 bounds concurrency
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

      export KEY SUMMARY REASON
      PROMPT='Triage Jira issue '"$KEY"': '"$SUMMARY"' (reason: '"$REASON"').
        Use the Atlassian Jira MCP tools to fetch the issue and its full comment
        thread. Decide whether this needs Will'\''s attention. It does NOT if it
        is a bare status/field change, FYI traffic, an already-resolved thread,
        or the last word is already Will'\''s. Reply with EXACTLY ONE LINE of
        JSON and nothing else: {"attention": true|false, "why": "<one sentence>"}'

      OUT=$(claude -p "$PROMPT" --allowedTools "mcp__atlassian__*" 2>/dev/null \
            | grep -oE '\{.*\}' | tail -1)
      ATT=$(jq -r '.attention // false' <<<"$OUT")
      WHY=$(jq -r '.why // ""' <<<"$OUT")

      NEXT=fyi; [ "$ATT" = "true" ] && NEXT=attention
      # -c: emit MUST be a single line (engine parses last stdout line only)
      jq -cn --arg n "$NEXT" --arg w "$WHY" --arg t "$ITYPE" \
        '{next: $n, merge: {triage_note: $w, issue_type: $t}}'
```

Output contract:
- `{next: fyi,       merge: {triage_note, issue_type}}` — no action needed.
- `{next: attention, merge: {triage_note, issue_type}}` — route to `review`.

Open robustness detail for the plan: `claude -p` JSON-line parsing. The
`grep -oE '\{.*\}' | tail -1` extracts the last brace-line; the plan must verify
this against real `claude -p` output and add a fallback (default to `attention`
so nothing is silently dropped) if `OUT` is empty/unparseable.

## Component 2 — `review` (human) with two edges

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

Edges:
- `review → spawn-workon  (name: workon)`
- `review → skipped       (name: skip)`

The `draft` / `feedback` presentation keys and the `revise` / `approve` edges are
gone.

## Component 3 — `spawn-workon` (full workon, seeded with the marble)

Revives `spawn-workon` from commit `4c9f304`, with three changes: (a) the
session prompt is seeded from the **whole marble context** plus `triage_note`,
(b) it sets `_session` to the new live session, (c) it best-effort pans the
canvas to it.

```yaml
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
      PROMPT="Work the Jira ticket $KEY: $SUMMARY ($URL). Morning triage flagged it: $NOTE. Use the Atlassian Jira MCP tools to fetch full details including comments and attachments, then propose and carry out an approach."
      if [ "$ITYPE" = "Bug" ]; then
        HAND='"bugsearcher"'
        PROMPT="Investigate Jira bug $KEY: $SUMMARY ($URL). Morning triage flagged it: $NOTE. Use the Atlassian Jira MCP tools to fetch full details including comments and attachments. Diagnose the root cause — find where and why it fails. Deliver reproduction steps, root-cause location, and the failure path."
      fi

      jq -cn --arg n "$LKEY" --arg t "task-$LKEY" --arg p "$PROMPT" --argjson h "$HAND" \
        '{name:$n, backend:"tmux", cliTemplate:"Claude (multi-agent)", project:"cmsandbox",
          worktree:true, taskId:$t, hand:$h, prompt:$p}' \
        | curl -sf -X POST "$TINSTAR/api/sessions" -H 'Content-Type: application/json' -d @- >/dev/null

      # Best-effort pan; the drawer's focus button is the reliable re-focus path.
      jq -cn --arg s "$LKEY" '{action:"focus", sessionName:$s}' \
        | curl -s -X POST "$TINSTAR/api/canvas/viewport" -H 'Content-Type: application/json' -d @- >/dev/null || true

      # _session points at the NOW-LIVE session, so the drawer button works.
      # -c: emit MUST be a single line (engine parses last stdout line only)
      jq -cn --arg s "$LKEY" --arg t "task-$LKEY" \
        '{merge: {_session: $s, workon_task: $t}}'
```

Session name is `<lowercased key>` (e.g. `cmt-716`), matching `run.sessionId`.
The marble then ends at `end "In session"` and is no longer re-clickable; later
re-focus is the drawer button (Component 4).

End nodes:
- `in-session` — `outcome: success`, name "In session"
- `skipped` — kept (warning)
- `fyi` — kept (success)

Removed end nodes: `posted`, `investigated`.

## Component 4 — honest focus

`focusSession` must distinguish "no live run for this session" from "Tinstar
unreachable", and the drawer must toast clearly.

- `src/tinstar.ts` — `panToSession` returns a richer result. Before broadcasting,
  GET `/api/state` and look for a run whose `sessionId === sessionName`:
  ```
  panToSession(name): Promise<"ok" | "no-run" | "unreachable">
  ```
  - state fetch fails → `"unreachable"`
  - no matching run → `"no-run"` (skip the broadcast; it would no-op anyway)
  - match found → POST the focus directive → `"ok"` (or `"unreachable"` if the
    POST itself fails)
- `src/daemon.ts` — `focusSession` maps through: `no-session` (context has no
  `_session`) stays; add `session-gone` (← `panToSession "no-run"`); `unreachable`
  unchanged.
- `src/controlApi.ts:148` — map results to responses:
  - `ok` → `200 {ok:true}`
  - `no-session` → `404 {error:"marble has no linked session"}`
  - `session-gone` → `409 {error:"session is no longer open on the canvas"}`
  - `unreachable` → `502 {error:"tinstar unreachable"}`
- The drawer already toasts `b.error` (`src/ui/public/app.js:78`), so no UI change
  beyond the new message reaching it.

## Files touched

- `examples/jira-morning.yaml` — node/edge surgery (Components 1–3) + header comment.
- `src/tinstar.ts` — `panToSession` return type + liveness check.
- `src/daemon.ts` — `focusSession` result mapping.
- `src/controlApi.ts` — response mapping for the new `session-gone` result.

`src/nodeTypes/agent.ts` is **not** modified — the agent node type stays for
other charts; `jira-morning` simply stops using it.

## Testing

- **Unit (`src/tinstar.ts`)**: `panToSession` against a mocked `/api/state` —
  returns `ok` when a matching run exists, `no-run` when absent, `unreachable`
  when the fetch throws.
- **Unit (`src/daemon.ts`)**: `focusSession` returns `no-session` /
  `session-gone` / `ok` for the three context+run combinations.
- **Lint**: `lintChart` must stay clean on the rewritten chart (every node
  reachable from a source; every non-end node has an outgoing edge). Run the
  existing chart-lint test path.
- **Manual**: submit a scan, confirm triage spawns no sessions (watch
  `/api/state` session count), click "work on this" on one ticket, confirm a
  session + task appear and the canvas pans, then confirm the drawer focus
  button re-pans — and that focusing after closing the session toasts
  "session is no longer open on the canvas".

## Risks / open items for the plan

1. `claude -p` triage output parsing — verify against real output; default to
   `attention` on parse failure so nothing is dropped silently.
2. Spawn-time auto-pan races session-run propagation to the browser; treated as
   best-effort, with the drawer button as the reliable path. Acceptable.
3. Re-running a scan over the same window: existing dedupe in `query-jira`
   (live-marble + unchanged-`updated`) is unchanged and still applies.
