# jira-morning Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A whoachart chart where a manually-triggered scan fans out one marble per Jira issue needing Will's attention; an agent triages+drafts a reply, Will approves/revises/skips in the UI, and approved drafts post back to Jira.

**Architecture:** One chart YAML (`examples/jira-morning.yaml`), no engine changes. Scan lane: `source → shell(query-jira) → quiet-day|scan-done`. Per-issue lane (entered via `POST /marbles` with `start: triage`): `agent(triage) → human(review) → shell(post-comment) → posted`, with `fyi`/`skipped` exits and a revise loop back to the agent. All intelligence is in inline bash scripts + the agent brief.

**Tech Stack:** whoachart daemon (live on `:5331`, chart store CRUD enabled), bash + curl + jq, Jira Cloud REST (`fortresspower-jira.atlassian.net`), clavis bundle `jira/prod` (exports `JIRA_PROD_EMAIL`, `JIRA_PROD_TOKEN`, `JIRA_PROD_URL`).

**Verified facts this plan relies on (do not re-derive):**
- `POST /api/charts/:name/marbles` accepts `{context?, workpiece?, start?}`; `start` targeting a non-source node bypasses the intake form (`src/daemon.ts:434`).
- Shell nodes inherit the daemon's full `process.env` (so `PATH`, `HOME`, `WHOACHART_PORT` are available) plus `WHOACHART_CONTEXT` = path to the marble's context JSON (`src/context.ts:15-23`).
- Emit protocol: the **last line of stdout** must be the `{next?, merge?}` JSON (`src/context.ts:25-40`). Everything else goes to stderr or earlier lines.
- Agent nodes get the marble context inlined in their brief plus a signal curl command; they signal `{"next":"<edge>","merge":{...}}` (`src/nodeTypes/agent.ts`).
- Live JQL verified 2026-06-11 against the real instance: `assignee = currentUser() AND updated >= -24h` works; **`comment ~ currentUser()` works for mentions** (returned FIR-243/241/239 over 7d). Use these exact clauses.
- Marble statuses for dedupe: live = `queued | running | blocked`. `GET /api/charts/:name/marbles` returns `{marbles: [{id, node, status, context, ...}]}`.
- Human-node edge forms validate signals server-side; `present` supports `text|markdown|json|link` and silently skips absent keys.
- Writes to the chart store (POST/PUT/DELETE `/api/charts/...`) require loopback; marble submit/signal are "trigger" routes and also work from loopback.

---

### Task 1: Write the chart YAML

**Files:**
- Create: `examples/jira-morning.yaml`

- [ ] **Step 1: Write `examples/jira-morning.yaml` with exactly this content**

```yaml
# examples/jira-morning.yaml
#
# Morning Jira triage. Will manually submits a scan (UI or curl); it finds
# issues needing his attention since the last scan (assigned-to-him updated,
# or mentioning him) and spawns ONE MARBLE PER ISSUE at start=triage. An
# agent triages and drafts a reply, Will approves/revises/skips at the human
# gate, approved drafts are posted back to Jira.
#
# Trigger: manual only (no cron) — design: docs/superpowers/specs/2026-06-11-jira-morning-chart-design.md
# Secrets: scripts run `eval "$(clavis get jira/prod)"` at runtime; creds
#          never appear in this file or in marble context.
# State:   ~/.local/state/whoachart/jira-morning.last — ISO time of the last
#          SUCCESSFUL scan; written only after a scan completes, so a failed
#          scan or skipped weekend is covered by the next run's window.
name: jira-morning
nodes:
  - id: scan
    type: source
    name: Morning scan
    config:
      trigger: api
      form:
        - { key: since, type: text, label: "Since (24h, 3d, or ISO time; blank = last scan)" }

  - id: query-jira
    type: shell
    name: Query Jira
    timeout: 180
    config:
      on_enter: |
        set -euo pipefail
        eval "$(clavis get jira/prod)"
        AUTH="$JIRA_PROD_EMAIL:$JIRA_PROD_TOKEN"
        BASE="http://localhost:${WHOACHART_PORT:-5330}"
        STATE_DIR="$HOME/.local/state/whoachart"
        STATE="$STATE_DIR/jira-morning.last"
        mkdir -p "$STATE_DIR"
        NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

        # Window: explicit form value > last-scan state file > 24h.
        SINCE=$(jq -r '.since // empty' "$WHOACHART_CONTEXT")
        [ -z "$SINCE" ] && [ -f "$STATE" ] && SINCE=$(cat "$STATE")
        [ -z "$SINCE" ] && SINCE="24h"
        # Normalize to a JQL time. Relative forms pass through; ISO/state
        # timestamps become a JQL datetime in machine-local time (Jira
        # evaluates datetimes in Will's Jira TZ — slight skew over-includes,
        # which dedupe + agent triage absorb).
        case "$SINCE" in
          -*) JQLT="$SINCE" ;;
          *[hdwm]) JQLT="-$SINCE" ;;
          *) JQLT="\"$(date -d "$SINCE" +"%Y-%m-%d %H:%M")\"" ;;
        esac

        ME=$(curl -sf -u "$AUTH" "$JIRA_PROD_URL/rest/api/3/myself" | jq -r .accountId)
        JQL="((assignee = currentUser() AND updated >= $JQLT) OR (comment ~ currentUser() AND updated >= $JQLT)) ORDER BY updated DESC"
        ISSUES=$(curl -sf -u "$AUTH" -G "$JIRA_PROD_URL/rest/api/3/search/jql" \
          --data-urlencode "jql=$JQL" \
          --data-urlencode "fields=key,summary,status,assignee,reporter,updated" \
          --data-urlencode "maxResults=50")
        FOUND=$(jq '.issues | length' <<<"$ISSUES")
        [ "$FOUND" -eq 50 ] && echo "WARNING: hit maxResults=50 cap; widen manually if needed" >&2

        # Dedupe: never spawn for an issue that already has a live marble.
        LIVE=$(curl -sf "$BASE/api/charts/jira-morning/marbles" \
          | jq -c '[.marbles[] | select(.status == "queued" or .status == "running" or .status == "blocked") | .context.key // empty]')

        SPAWNED=0
        while IFS= read -r row; do
          KEY=$(jq -r .key <<<"$row")
          if jq -e --arg k "$KEY" 'index($k)' <<<"$LIVE" >/dev/null; then
            echo "dedupe: $KEY already live, skipping" >&2
            continue
          fi
          jq -n --argjson i "$row" --arg me "$ME" --arg url "$JIRA_PROD_URL" '
            { start: "triage",
              context: {
                key: $i.key,
                summary: $i.fields.summary,
                url: ($url + "/browse/" + $i.key),
                reason: (if (($i.fields.assignee.accountId // "") == $me) then "assigned-update" else "mention" end),
                status: ($i.fields.status.name // ""),
                reporter: ($i.fields.reporter.displayName // ""),
                updated: $i.fields.updated } }' \
            | curl -sf -X POST "$BASE/api/charts/jira-morning/marbles" \
                -H 'Content-Type: application/json' -d @- >/dev/null
          SPAWNED=$((SPAWNED+1))
        done < <(jq -c '.issues[]' <<<"$ISSUES")

        # Only a fully successful scan advances the window (set -e guards above).
        echo "$NOW_ISO" > "$STATE"
        NEXT=quiet; [ "$SPAWNED" -gt 0 ] && NEXT=done
        jq -n --arg n "$NEXT" --arg w "$SINCE" --argjson f "$FOUND" --argjson s "$SPAWNED" \
          '{next: $n, merge: {window: $w, found: $f, spawned: $s}}'

  - id: triage
    type: agent
    name: Triage + draft
    color: "#60a5fa"
    stuck_after: 1800
    config:
      brief: >
        A Jira issue needs morning triage for Will (williamg@fortresspower.com).
        The marble context has key/url/reason. Fetch the LIVE issue and full
        comment thread before judging anything: run eval "$(clavis get jira/prod)"
        then curl -s -u "$JIRA_PROD_EMAIL:$JIRA_PROD_TOKEN"
        "$JIRA_PROD_URL/rest/api/2/issue/KEY" and
        "$JIRA_PROD_URL/rest/api/2/issue/KEY/comment" (substitute the context
        key for KEY). Decide whether this needs a reply from Will. If NO (bare
        status/field change, FYI traffic, thread already resolved, or the last
        word is already Will's): signal next=fyi with merge
        {"triage_note": "<one sentence why>"}. If YES: write the reply Will
        should post — plain text (Jira wiki markup OK), concrete and brief,
        in a direct engineer-to-engineer voice — and signal next=review with
        merge {"draft": "<the comment>", "rationale": "<one sentence why a
        reply is needed>"}. If the context contains "feedback", this is a
        redraft of the existing "draft": honor the feedback over your own
        judgment and signal next=review again. NEVER post to Jira yourself —
        the chart posts only after human approval.

  - id: review
    type: human
    name: Will reviews
    present:
      - { key: key, as: text }
      - { key: summary, as: text }
      - { key: url, as: link }
      - { key: reason, as: text }
      - { key: rationale, as: text }
      - { key: draft, as: markdown }
      - { key: feedback, as: text }
    config: {}

  - id: post-comment
    type: shell
    name: Post to Jira
    timeout: 60
    config:
      on_enter: |
        set -euo pipefail
        eval "$(clavis get jira/prod)"
        KEY=$(jq -r .key "$WHOACHART_CONTEXT")
        RESP=$(jq '{body: .draft}' "$WHOACHART_CONTEXT" \
          | curl -sf -u "$JIRA_PROD_EMAIL:$JIRA_PROD_TOKEN" \
              -H 'Content-Type: application/json' -d @- \
              "$JIRA_PROD_URL/rest/api/2/issue/$KEY/comment")
        CID=$(jq -r .id <<<"$RESP")
        jq -n --arg u "$JIRA_PROD_URL/browse/$KEY?focusedCommentId=$CID" \
          '{merge: {posted_url: $u}}'

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

  - id: posted
    type: end
    name: Posted
    config: { outcome: success }

  - id: skipped
    type: end
    name: Skipped
    config: { outcome: warning }

edges:
  - { from: scan, to: query-jira }
  - { from: query-jira, to: quiet-day, name: quiet }
  - { from: query-jira, to: scan-done, name: done }
  - { from: triage, to: review, name: review }
  - { from: triage, to: fyi, name: fyi }
  - { from: review, to: post-comment, name: approve }
  - { from: review, to: triage, name: revise,
      form: [ { key: feedback, type: textarea, required: true } ] }
  - { from: review, to: skipped, name: skip }
  - { from: post-comment, to: posted }
```

Notes for the implementer (already encoded above — do not "fix" them):
- The scan lane has no decision node: `query-jira` emits `next: quiet|done` directly. Same for the per-issue lane: the agent's signal carries `next`.
- `post-comment` deliberately has **no retry config**: an auto-retry after a network blip could double-post. Failures stay on the board for manual retry.
- The per-issue lane is unreachable by edges from `scan` — that is the fan-out design. If `lintChart` emits an "unreachable" advisory, it is expected; dismiss it.
- Uses Jira REST **v2** for comment post (plain-string body) and v3 only for search/myself.

- [ ] **Step 2: Sanity-check the YAML parses**

Run:
```bash
cd /home/ubuntu/repo/whoachart && bun -e '
import { readFileSync } from "node:fs"
import { parseChart } from "./src/schema"
import "./src/registry"
const c = parseChart(readFileSync("examples/jira-morning.yaml", "utf8"))
console.log("ok:", c.name, c.nodes.length, "nodes", c.edges.length, "edges")'
```
Expected: `ok: jira-morning 10 nodes 9 edges`. (If the registry import path differs — check how `src/run.ts` registers built-in node types and mirror it.)

- [ ] **Step 3: Commit**

```bash
git add examples/jira-morning.yaml
git commit -m "feat: jira-morning chart — manual scan, per-issue triage/draft/approve lane"
```

---

### Task 2: Register with the live daemon and verify

**Files:** none (API calls against the daemon on `:5331`)

- [ ] **Step 1: Register the chart (loopback POST of the YAML)**

```bash
curl -s -X POST http://localhost:5331/api/charts \
  -H 'Content-Type: application/yaml' \
  --data-binary @examples/jira-morning.yaml | jq .
```
Expected: 2xx JSON naming the chart, with a `warnings`/`lint` key that is empty or contains only the expected fan-out "unreachable" advisory. If the endpoint shape differs (e.g. expects `{name, yaml}` JSON), check `src/controlApi.ts` register route and adapt. If it 409s because the name exists, use `PUT /api/charts/jira-morning`.

- [ ] **Step 2: Verify the def and lint**

```bash
curl -s http://localhost:5331/api/charts/jira-morning/def | jq '{start, nodes: [.nodes[].id], lint}'
```
Expected: `start: "scan"`, all 10 node ids, acceptable lint.

---

### Task 3: Smoke-test the per-issue lane mechanics (no Jira writes)

This verifies: fan-out entry at `start=triage`, agent spawn + signal routing, the review gate, and the `skip` exit. It spawns one real Tinstar agent session.

- [ ] **Step 1: Inject a synthetic per-issue marble for a real issue**

Pick a real, currently-assigned issue key (Task 5's JQL found e.g. FIR-231). Then:
```bash
curl -s -X POST http://localhost:5331/api/charts/jira-morning/marbles \
  -H 'Content-Type: application/json' -d '{
    "start": "triage",
    "context": {
      "key": "FIR-231",
      "summary": "(smoke test — fill real summary)",
      "url": "https://fortresspower-jira.atlassian.net/browse/FIR-231",
      "reason": "assigned-update",
      "status": "In Progress", "reporter": "smoke", "updated": "now"
    }}' | jq .
```
Expected: marble id returned; marble at `triage`, status `blocked` shortly after (agent session spawned).

- [ ] **Step 2: Wait for the agent's signal and verify routing**

Poll (the agent session may take a few minutes):
```bash
watch -n 15 'curl -s http://localhost:5331/api/charts/jira-morning/marbles | jq -c ".marbles[] | {id, node, status}"'
```
Expected: marble moves to `review` (blocked) with `draft`+`rationale` in context, **or** ends at `fyi` with `triage_note`. Either proves the lane.

- [ ] **Step 3: If it parked at review, exercise the skip edge (clean exit, no post)**

```bash
curl -s -X POST http://localhost:5331/api/charts/jira-morning/marbles/<ID>/signal \
  -H 'Content-Type: application/json' -d '{"next":"skip"}' | jq .
```
Expected: marble ends `skipped` (warning outcome). Also eyeball the review presentation in the UI before skipping — key/summary/link/draft should all render.

---

### Task 4: Smoke-test post-comment against a scratch issue

- [ ] **Step 1: Create a scratch issue in the KC project**

```bash
eval "$(clavis get jira/prod)"
SCRATCH=$(curl -sf -u "$JIRA_PROD_EMAIL:$JIRA_PROD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"fields":{"project":{"key":"KC"},"issuetype":{"name":"Task"},
       "summary":"whoachart jira-morning smoke test (ignore)",
       "description":"Scratch issue for chart post-comment verification."}}' \
  "$JIRA_PROD_URL/rest/api/2/issue" | jq -r .key)
echo "$SCRATCH"
```
Expected: a new key like `KC-NNN`. (If KC rejects the issuetype, list types with `curl .../rest/api/2/issue/createmeta?projectKeys=KC | jq '.projects[].issuetypes[].name'` and pick one.)

- [ ] **Step 2: Inject a marble directly at review with a canned draft, approve it**

```bash
MID=$(curl -s -X POST http://localhost:5331/api/charts/jira-morning/marbles \
  -H 'Content-Type: application/json' -d "{
    \"start\": \"review\",
    \"context\": {\"key\": \"$SCRATCH\", \"summary\": \"smoke\", \"url\": \"$JIRA_PROD_URL/browse/$SCRATCH\",
                  \"reason\": \"assigned-update\", \"draft\": \"whoachart post-comment smoke test — ignore.\",
                  \"rationale\": \"smoke\"}}" | jq -r '.id // .marble.id')
sleep 2
curl -s -X POST "http://localhost:5331/api/charts/jira-morning/marbles/$MID/signal" \
  -H 'Content-Type: application/json' -d '{"next":"approve"}' | jq .
```
Expected: marble runs `post-comment` and ends `posted` with `posted_url` in context.

- [ ] **Step 3: Verify the comment landed, then close the scratch issue**

```bash
curl -sf -u "$JIRA_PROD_EMAIL:$JIRA_PROD_TOKEN" "$JIRA_PROD_URL/rest/api/2/issue/$SCRATCH/comment" \
  | jq -r '.comments[-1].body'
TID=$(curl -sf -u "$JIRA_PROD_EMAIL:$JIRA_PROD_TOKEN" "$JIRA_PROD_URL/rest/api/2/issue/$SCRATCH/transitions" \
  | jq -r '.transitions[] | select(.name | test("Done|Close|Resolve"; "i")) | .id' | head -1)
curl -sf -u "$JIRA_PROD_EMAIL:$JIRA_PROD_TOKEN" -X POST -H 'Content-Type: application/json' \
  -d "{\"transition\":{\"id\":\"$TID\"}}" "$JIRA_PROD_URL/rest/api/2/issue/$SCRATCH/transitions"
```
Expected: comment body echoes the draft; scratch issue transitions to Done.

---

### Task 5: Live scan run + dedupe + state file

- [ ] **Step 1: First real scan (no state file yet → 24h default)**

```bash
ls ~/.local/state/whoachart/jira-morning.last 2>/dev/null || echo "no state (expected)"
curl -s -X POST http://localhost:5331/api/charts/jira-morning/marbles \
  -H 'Content-Type: application/json' -d '{"context":{}}' | jq .
```
Wait for the scan marble to end, then:
```bash
curl -s http://localhost:5331/api/charts/jira-morning/marbles \
  | jq -c '.marbles[] | {id, node, status, key: .context.key, window: .context.window, spawned: .context.spawned}'
cat ~/.local/state/whoachart/jira-morning.last
```
Expected: scan marble ended `scan-done` (or `quiet-day` if genuinely nothing) with `found`/`spawned` counts matching a manual JQL spot-check; one live marble per spawned issue sitting at `triage`/`review`; state file now holds an ISO timestamp.

- [ ] **Step 2: Dedupe check — rerun with an explicit wide window**

```bash
curl -s -X POST http://localhost:5331/api/charts/jira-morning/marbles \
  -H 'Content-Type: application/json' -d '{"context":{"since":"24h"}}' | jq .
```
Expected: scan ends with `found` ≥ 1 but `spawned: 0` (all keys already live) → `quiet-day`. The daemon log/stderr for query-jira shows `dedupe: <KEY> already live` lines.

- [ ] **Step 3: Hand off to Will**

Leave the spawned per-issue marbles in place — working them in the UI **is the product**. Report the chart URL and marble count.

---

### Task 6: Docs touch + final commit

- [ ] **Step 1: Add the chart to the examples list if a README enumerates them**

Run `grep -rn "gate-demo" README.md docs/ --include=*.md -l` and add a one-liner for `jira-morning` wherever the other examples are listed (skip if nowhere lists them).

- [ ] **Step 2: Commit any remaining changes**

```bash
git add -A && git diff --cached --quiet || git commit -m "docs: jira-morning chart plan + readme touch"
```

---

## Self-review (done at write time)

- **Spec coverage:** manual trigger w/ last-scan default (Task 1 source form + window logic); fan-out per issue (query-jira loop); agent triage+draft incl. revise loop (triage node + revise edge); human gate w/ presentation (review node); post via REST w/ verified 2xx (`curl -sf`); secrets via clavis at runtime; state-file-only-on-success; dedupe; ends incl. skipped=warning; repo YAML canonical; testing per spec (Tasks 3–5). Deferred items in spec stay deferred. ✔
- **Placeholders:** none — all scripts and commands are complete; the two "if shape differs, check controlApi" notes are contingencies with the file to consult, not TBDs. ✔
- **Consistency:** edge names (`quiet/done/review/fyi/approve/revise/skip`) match script emits, agent brief, and signal commands; context keys (`key/summary/url/reason/draft/rationale/feedback/triage_note/posted_url/window/found/spawned`) consistent across nodes and `present`. ✔
