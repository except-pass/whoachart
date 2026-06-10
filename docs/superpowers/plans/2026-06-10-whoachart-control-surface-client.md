# whoachart Control Surface — Plan B: Client (inline execution record)

**Goal:** Replace the v0 JSON client with the full control surface per spec §8
(`docs/superpowers/specs/2026-06-09-whoachart-control-surface-design.md`).

**Execution mode:** Inline by the orchestrating agent (UI code is iterate-heavy;
a transcription plan would duplicate the implementation). Quality gates: pure
helpers unit-tested, page/API structure tested, live smoke against real
Tinstar, final independent review subagent over the whole diff.

## Files

| File | Responsibility |
|---|---|
| `src/ui/page.ts` | Full shell: bar, canvas+drawer grid, tray, modal, hovercard containers, all CSS. |
| `src/ui/public/helpers.js` | Pure functions: `hue`, `ringFor`, `fmtAge`, `fmtMs`, `ageSeconds`, `slotPos`, `counterPos`, `enumWidget`, `escHtml`. Unit-tested. |
| `src/ui/public/forms.js` | Render `FormField[]` → typed inputs (radio ≤4 / select >4 / number / checkbox / text / textarea); read values; inline field errors. |
| `src/ui/public/drawer.js` | Marble inspector: trail breadcrumb + dwell, present rendering, context, session row + focus, gate decisions (force-disclosure for agents), retry. |
| `src/ui/public/app.js` | Boot (def), draw SVG (edges/nodes/➕), 600ms poll, marble reconcile with **edge-path travel** (`getPointAtLength` + rAF) and edge pulse, age/stuck ring, counters + fly-in, gate buttons on canvas, tray, node stats hovercard, modal intake. |

## Behaviors (from spec §8, all in scope)

Edge travel + pulse · drawer (click marble) · gate buttons on canvas + drawer,
edge forms, agent force-disclosure · age tag past `stuck_after` (default 300s)
· dead-letter tray + retry · ➕ intake modal from source form · node hover
stats + queue count · focus-session button · identity colors, 2-char labels,
agent face, last-8 + ×N tallies carried over.

## Tests

- `tests/uiHelpers.test.ts` — pure helper behavior.
- `tests/uiRoutes.test.ts` — extended: all client modules serve; shell contains
  the new containers.
- Existing API/e2e suites remain the behavioral safety net (the client calls
  only those routes).
- Manual live smoke vs real Tinstar before merge (gate-demo + agent-review).
