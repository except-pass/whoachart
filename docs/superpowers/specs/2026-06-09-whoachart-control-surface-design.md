# whoachart Control Surface (UI v1) — Design

**Date:** 2026-06-09
**Status:** Design approved in conversation, pending spec review → implementation plan
**Author:** Will Gathright (with Claude)

## 1. Summary

The live view graduates from a status display to a **control surface**, and its
shell changes from a Tinstar HTML artifact to a **web app served by the
whoachart daemon**. Eight affordances ship in this milestone:

1. Marbles travel **along the edge curve** (with an edge pulse on traversal).
2. **Click a marble → inspector drawer** (journey + timings, context, workpiece,
   session).
3. **Human gates**: a blocked marble's outgoing edges render as buttons on the
   page; deciding can require typed input (edge forms). Gate context is
   presented **in the drawer** (declared via `present:`).
4. **Age/stuck indicator** on long-dwelling marbles.
5. **Dead-letter tray** for errored marbles, with one-click **retry**.
6. **➕ intake** on the source node with a **typed form** (radio/dropdown/number/
   checkbox/text/textarea) declared in chart YAML.
7. **Node hover stats** (runs, fail %, dwell p50/p95) and a **queue-depth bar**.
8. **Open session** → daemon asks Tinstar to **pan the canvas** to the marble's
   linked agent session.

Out of scope (named): companion Tinstar widgets for gate context, SSE push (the
`EngineEvent` seam exists; polling stays for v1), title-bar sparkline, history
replay, native Tinstar plugin packaging (later via the plugin-bridge pattern, as
stretchplan does).

## 2. Shell architecture (the decision)

**Web app served by the daemon.** Rationale: every affordance above lives inside
the widget rectangle, where native-plugin citizenship buys nothing; one origin
for page+data removes CORS and the artifact PUT lifecycle; iteration stays in
this repo; whoachart remains useful standalone.

- New env `WHOACHART_PUBLIC_URL` (default `http://localhost:<port>`). The daemon
  binds `0.0.0.0`; on a tailnet box you set the tailnet hostname (e.g.
  `http://infrapoc.taile890bc.ts.net:5331`) so remote browsers reach it with
  **no port forwarding**. All URLs handed to Tinstar or embedded in pages use
  `WHOACHART_PUBLIC_URL`; agent signal URLs keep using the local base.
- Per chart, the daemon ensures a Tinstar **browser-widget** pointing at
  `<PUBLIC_URL>/ui/charts/<name>` (replacing artifact POST/PUT). On boot it
  searches Tinstar `/api/state` for an existing widget with that URL and only
  creates one if absent — no more widget pile-up.
- The view bridge no longer renders HTML; it keeps the in-memory `ViewState`
  (now richer, §4) that the app polls.
- The page stays no-framework: a server-rendered shell (`/ui/charts/:name`)
  plus a static vanilla-JS client (`/ui/app.js`) served from a real source file
  (no more JS-in-template-string).

## 3. Data model additions

### Marble trail (timestamps per hop)
`Marble` gains `trail: { node: string; enteredAt: string; leftAt?: string }[]`,
maintained by the engine alongside `history` (kept for compatibility). Powers
drawer timings, age/stuck display, and dwell stats. Existing persisted marbles
without `trail` rehydrate with an empty trail (degrade gracefully).

### Retry
`Engine.retry(id)`: a `failed` marble is re-enqueued at its current node with
`error` cleared (status → queued). Emits a `signaled`-style event (`type:
"retried"` added to `EngineEvent`). Only `failed` marbles can be retried.

## 4. View aggregate (`ViewState`) extensions

All bounded, all O(1) per event, in-memory (reset on daemon restart — accepted
for v1):

- **`live[]`** entries gain `enteredAt` (for client-side age display) and
  `gate?: { edges: { name: string; form?: FormField[] }[], present: Present[] }`
  when blocked at a gate.
- **`stats`** per node: `{ runs, fails, dwellP50, dwellP95 }` — dwell from trail
  deltas via a fixed-size sample reservoir (e.g. last 64 dwells per node).
- **`deadLetter[]`**: last 20 failed-with-error marbles `{ id, node, error
  (first line), failedAt }`. Marbles that fail at an `end` node with
  `outcome: fail` are *not* dead letters (that's a normal rejection).
- **`queued`** is derivable client-side from `live[]` statuses; the queue bar
  renders from it.

## 5. Form schema (one schema, two homes)

```yaml
# on a source node: the intake form behind ➕
- id: ingest
  type: source
  config:
    trigger: api
    form:
      - { key: title,    type: text,     required: true }
      - { key: priority, type: enum,     options: [low, med, high] }   # ≤4 → radio
      - { key: region,   type: enum,     options: [us, eu, apac, sa, af, anz] }  # >4 → dropdown
      - { key: copies,   type: number,   min: 1, default: 1 }
      - { key: rush,     type: boolean }
      - { key: notes,    type: textarea }

# on an edge: deciding this edge requires input (human OR agent)
edges:
  - { from: review, to: revise, name: revise,
      form: [ { key: reason, type: textarea, required: true } ] }
```

Field types: `text`, `textarea`, `number` (`min`/`max`/`step`), `boolean`,
`enum` (`options`; UI renders radio ≤4 options, dropdown >4). Common props:
`key`, `label?` (defaults to key), `required?`, `default?`.

**Validation is server-side and universal**: submit (`POST …/marbles`) validates
against the source form; **signal validates against the chosen edge's form** —
so agents are held to the same contract as humans (a signal missing a required
`reason` is rejected 400 with a field-level message). Client-side rendering is a
convenience, not the enforcement point.

## 6. Gate UX (drawer-only this milestone)

A node is a *gate* when a marble is `blocked` there. In the drawer:
- **Presentation**: node config `present: [{ key, as: markdown|json|text|link }]`
  declares what the decider sees, rendered above the buttons. Default when
  undeclared: prettified context + workpiece link. (`workpiece` is a valid
  `key`.)
- **Decision buttons**: one per outgoing edge (label = edge name). Clicking an
  edge with a `form` opens that form; submit POSTs the signal with the values
  as `merge`. Buttons render on the chart canvas next to the blocked marble
  *and* in the drawer.
- Agent-blocked marbles show the same drawer minus buttons-by-default (a
  human can still force an edge — same signal endpoint; show buttons behind a
  "force" disclosure to avoid accidental overrides of working agents).

## 7. API surface (daemon)

| Route | Change |
|---|---|
| `GET /ui/charts/:name` | NEW — app shell HTML. |
| `GET /ui/app.js` | NEW — static client. |
| `GET /api/charts/:name/def` | NEW — topology + layout + node/edge form schemas + present specs (static per chart; client fetches once). |
| `GET /api/charts/:name/state` | EXTENDED — `live` (+`enteredAt`, gate info), `ends`, `stats`, `deadLetter`. |
| `POST /api/charts/:name/marbles` | EXTENDED — validates context against source form when one is declared. |
| `POST /api/charts/:name/marbles/:id/signal` | EXTENDED — validates `merge` against the chosen edge's form. |
| `POST /api/charts/:name/marbles/:id/retry` | NEW — retry a failed marble. |
| `POST /api/charts/:name/marbles/:id/focus-session` | NEW — daemon asks Tinstar (`POST /api/canvas/viewport`) to pan to the marble's `_session` widget. Implementation reads the directive payload shape from the Tinstar source (`src/server/api/routes.ts` around the `canvas:viewport` broadcast) before coding. |

CORS stays permissive (harmless now that the page is same-origin).

## 8. Client behaviors (vanilla JS)

- **Edge travel**: marbles animate along the edge's bezier via
  `path.getPointAtLength` sampling (~600ms eased), instead of straight-line CSS
  translate; the traversed edge pulses for ~1s. Fallback to translate if the
  edge path isn't found (forced jumps).
- **Age/stuck**: each marble shows nothing under 60s; an age tag (`12m`) appears
  past `stuck_after` (universal node config field, default 300s); the ring turns
  amber. Ages computed client-side from `enteredAt` (no extra polling cost).
- **Drawer**: click marble → fetch `GET …/marbles/:id`, render breadcrumb from
  `trail` (per-node dwell), context (pretty), workpiece link, session row with
  *open session* button (`focus-session`), gate presentation + decision buttons
  when blocked.
- **Dead-letter tray**: collapsible bottom tray listing `deadLetter`; retry
  button per row.
- **➕ intake**: button on source node → modal form rendered from `def`; submit
  POSTs marbles.
- **Hover stats**: hover/click a node → small card from `stats` + current queue
  count.
- Identity colors, 2-char labels, agent face, fly-into-counter, last-8 + `×N`
  tallies all carry over.

## 9. Error handling

- Form validation failures → 400 with `{ error, fields: { key: message } }`;
  the client highlights fields inline.
- `retry` on a non-failed marble → 400. `focus-session` with no `_session` →
  404. Tinstar unreachable on focus → 502 surfaced as a toast, never crashes
  the daemon.
- Widget-ensure on boot tolerates Tinstar being down (logs and continues;
  `ensureWidget` retried on a timer until it succeeds).

## 10. Testing

- Engine: trail timestamps maintained across hops/block/resume; retry semantics.
- ViewState: stats reservoir percentiles, dead-letter bounding, gate info.
- Forms: zod schema build from YAML; submit + signal validation paths (reject
  missing required; accept valid; agent-signal path identical).
- API: def/state/retry/focus-session routes (Tinstar stubbed).
- Client: serve the shell, assert structure (forms rendered from def, drawer
  markup, tray) via fetch + HTML assertions; behaviorial JS covered by a small
  DOM-less unit file where practical (pure helpers extracted: slotting, age
  formatting, bezier sampling math).
- e2e: human-gate chart — submit via API with form, marble blocks, decide via
  signal-with-form, retry a failed marble, all through the real control API.

## 11. Migration notes

- `ViewBridge` rename/refactor: artifact post/PUT path removed; `ArtifactSink`
  stays for now (the affordances mockups still use artifacts) but the daemon no
  longer posts chart artifacts.
- `examples/` charts gain `form`, `present`, and `stuck_after` where useful;
  existing charts remain valid (all new fields optional).
