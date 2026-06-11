# jira-morning chart — design

Date: 2026-06-11
Status: approved (brainstormed with Will)

## Purpose

A whoachart chart that turns the morning Jira sweep into a board of approvable
work. Each morning Will triggers a scan; every issue that needs his attention
becomes its own marble that flows triage → draft → his approval → posted
comment. He stays in the loop on everything that goes out.

## Scope decisions (from brainstorming)

- **Deliverable:** drafted Jira responses gated by human approval; the chart
  posts approved comments to Jira. Not a digest-only tool; no automatic work
  kickoff (can be added later as another edge off review).
- **Granularity:** one marble per issue (fan-out). The scan marble spawns the
  batch and ends.
- **"Needs my attention" =** (a) issues assigned to me updated in the window,
  (b) issues where I was mentioned in the window.
- **Trigger: manual only. No cron.** Will submits the scan from the whoachart
  UI (or curl). The intake form takes a `since` time; left blank it defaults
  to the time of the last successful scan (first ever run: 24h).
- **Triage intelligence lives in the agent:** one agent session per issue does
  both triage (needs-reply vs FYI) and drafting, with full issue + comment
  context.

## Chart shape

One chart, `jira-morning`, two lanes.

```
SCAN LANE (1 marble per scan, manual submit)
  (scan) source: trigger api, form: since (text, optional)
     │
  [query-jira] shell:
     │  window = since ?? last-scan-timestamp ?? 24h
     │  JQL: assigned-to-me-updated + mentioned-in-window
     │  dedupe vs live marbles already in this chart
     │  POST 1 marble per issue → start=triage
     ◇ any issues?
    ╱ ╲
 (quiet-day)   (scan-done)            ← end nodes

PER-ISSUE LANE (N marbles, injected at start=triage)
  [triage+draft] agent: read full issue + comments, classify,
     │            draft a comment if a reply is warranted
     │  signals next=fyi  (merge: triage_note)
     │       or next=review (merge: draft, rationale)
    ╱        ╲
 (fyi) end   [review] human: present key/summary/link/reason/
              │                rationale/draft(markdown)
              │ approve │ revise (form: feedback, required) │ skip
              │         ╰────→ back to triage+draft         ╯
  [post-comment] shell: POST comment via Jira REST, verify 2xx,
     │           merge posted comment URL
  (posted) end                        (skipped) end
```

No decision node in the per-issue lane: the agent's signal carries `next`
directly.

## Node details

### `scan` (source)
- `trigger: api`. Form: `since` — text, optional. Description tells the user
  the accepted forms (`24h`, `3d`, ISO timestamp) and that blank means "since
  the last scan".

### `query-jira` (shell)
- Resolves the window: explicit `since` → parse; blank → last-scan state file;
  missing state file → 24h.
- State file: `~/.local/state/whoachart/jira-morning.last` (ISO timestamp).
  Written only after a **successful** scan, so a failed morning is re-covered
  by the next run, and a skipped weekend is covered by Monday's default.
- Queries Jira Cloud REST (`/rest/api/3/search/jql`) with JQL for the two
  buckets; tags each hit with `reason: assigned-update | mention`.
  Mention detection is instance-dependent — verify the working JQL clause
  against the real instance during implementation (fallback: scan comment
  bodies for the accountId).
- Dedupe: fetch this chart's live marbles; skip issues whose key already has
  a live marble (re-running a scan never double-drafts).
- Fan-out: `POST /api/charts/jira-morning/marbles` with `start: triage` and
  context `{key, summary, url, reason, issue}` (issue = trimmed snapshot:
  status, assignee, reporter, updated, description, recent comments).
- Merges `{found: N, spawned: N, window}` and routes: 0 spawned → `quiet-day`,
  else `scan-done`.

### `triage+draft` (agent)
- Brief: you are responding to a Jira issue on Will's behalf. Read the full
  issue and comment thread (fetch live — don't trust only the snapshot).
  Decide: does this need a reply from Will?
  - No (bare status change, FYI traffic, already resolved): signal
    `next=fyi` with `merge: {triage_note}`.
  - Yes: write the comment in Jira wiki markup, signal `next=review` with
    `merge: {draft, rationale}`.
  - If context contains `feedback` (revise loop), redraft honoring it.
- `stuck_after` set (~30 min) so a wedged session is flagged on the board.

### `review` (human)
- `present`: key (text), summary (text), url (link), reason (text),
  rationale (text), draft (markdown), triage/feedback history if present.
- Edges: `approve` → post-comment; `revise` (form: `feedback` textarea,
  required) → triage+draft; `skip` → skipped end.

### `post-comment` (shell)
- POSTs the draft as a comment on the issue via Jira REST, verifies 2xx,
  merges `{posted_url}`. Non-2xx → marble fails visibly; retry available
  from the board.

### Ends
- `quiet-day`, `scan-done`, `posted`, `fyi` → outcome success.
- `skipped` → outcome warning (visible signal that something surfaced and was
  waved off).

## Secrets

Jira credentials (email + API token) come from clavis at script runtime.
Never in the chart YAML; never merged into marble context (context is visible
in the UI and persisted on disk).

## Error handling

- query-jira / post-comment failures fail the marble on the board; fix and
  retry. Post retry may double-comment in the rare crash-after-post case —
  acceptable; the script orders "post, then merge" so a verified 2xx never
  retries.
- Agent timeout → `stuck_after` flags the marble.
- Scan state timestamp advances only on success (see above).

## Source of truth & deployment

- Chart YAML lives in this repo at `examples/jira-morning.yaml`; the repo copy
  is canonical (the running daemon's charts dir is currently a /tmp demo dir).
- Registered into the running daemon (`:5331`) via the chart-store API
  (loopback POST). Hot-reload via PUT respects the live-marble guard.

## Testing

- Per-issue lane is testable in isolation: submit a marble at `start=triage`
  with synthetic issue context; exercise fyi / revise-loop / skip without
  touching Jira; test `post-comment` once against a sandbox/test issue.
- Scan lane: live run with a short window (`since=2h`) on a quiet period;
  verify dedupe by re-running immediately.
- `lintChart` runs on register; fix any warnings it raises.

## Out of scope (explicitly deferred)

- Cron/scheduled triggering (manual only, by decision).
- Kicking off code-work sessions from an issue (future `workon` edge off
  review).
- New-issues-in-project and reporter/watcher query buckets.
