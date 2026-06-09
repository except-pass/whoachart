# whoachart — Tinstar-native overhaul (MVP design)

**Date:** 2026-06-08
**Status:** Design approved, pending spec review → implementation plan
**Author:** Will Gathright (with Claude)

## 1. Summary

whoachart is being rewritten from the ground up. The only thing kept from the
current Python library is the name. The new whoachart is a **Tinstar-native,
declarative flow-chart engine**: you author a chart of states and transitions
with automation attached to each, and you watch live units of work flow through
it on the Tinstar canvas — including agent sessions linked visually to the nodes
they're working.

The defining idea: **decompose a non-trivial process into a graph of small,
focused, expert steps, and watch many independent units of work flow through that
graph at once.** It is closer to a manufacturing assembly line for agents than to
a data-transformation pipeline (n8n/Node-RED) — a real workpiece is progressively
transformed by specialists, not a single agent doing everything.

## 2. Core concepts

### Chart
A reusable **definition** — a graph of `states[]` (nodes) and `edges[]`
(transitions) plus logic. Authored once in YAML; static. Analogous to a class, a
BPMN process definition, or an n8n workflow.

### Marble
A live **instance** that traverses a chart, carrying its own payload. Many
marbles flow through the same chart concurrently; each is an independent
single-cursor state machine. Analogous to an object, a BPMN token, or an n8n
execution. A marble carries:

- **context** — a JSON blob that accumulates findings/decisions/handoff data as
  it moves. This is the inter-step handoff manifest.
- **workpiece** (optional) — a pointer to the real subject being worked: a folder
  path, a Notion URL, a ticket id, an S3 path. *Not* a forced git worktree.
- **position** — the node it currently sits on, plus its traversal history.
- **status** — queued | running | blocked (awaiting external) | done | failed.

Concurrency is **across marbles**, never *within* a marble. There is no fan-out /
fan-in inside a single marble in the MVP — that keeps the engine free of joins
and partial-failure-of-a-split semantics.

### Node (state)
Every node has a **universal block** plus a type-specific **`config` child
block** validated by that node type's schema.

Universal fields: `id`, `type`, `name`, `color`, optional `on_leave` (cleanup
hook), optional policy (`retry`, `timeout`).

`config` holds the node's behavior **and** how it decides the next edge — i.e.
"the on_enter block." Routing logic lives here and nowhere else.

### Edge (transition)
A **dumb labeled conduit**. It carries only:

- `from`, `to` — topology.
- `name` — the label the source node's code emits to select this edge (also shown
  on the canvas).
- `on_traversal` (optional) — side-effect code run *as* a marble crosses this edge
  (notify, tag, log). This is a side effect, not a routing decision.
- `default` (optional) — taken when the node emits nothing and routing is
  ambiguous.

Edges have **no `when` guard.** Routing logic is never placed on an edge.

## 3. Routing model: node-centric

This is a deliberate choice of the AWS Step Functions model (a `Choice` *state*
holds the rules; transitions are dumb `Next` pointers) over the XState model
(guards on transitions). Rationale: the code that runs the work is the code that
knows the outcome, so it should also name the transition — keeping all decision
logic for a node in exactly one place.

Rules:

1. A node's behavior runs and produces a **result** that names the next edge.
2. The engine takes the outgoing edge whose `name` matches.
3. Conventions (ergonomic sugar, not logic-spreading):
   - One outgoing edge, nothing emitted → auto-take it.
   - Multiple edges, nothing emitted → take the `default` edge, else error.

**Emit mechanism (the activity contract output):** an activity names an edge via
either a final stdout JSON object `{"next":"<edgeName>", ...otherKeys}` or a small
helper CLI (`whoachart next <name>`, `whoachart set k=v` to merge into context).
Any extra keys merge into the marble's context. An **agent** node is told the
available edge names in its generated brief and signals one as its done-signal.

## 4. Activity contract (uniform across step kinds)

Every node behavior that "does work" — shell, api, agent — runs under the same
contract so steps compose and swapping one kind for another never reshapes the
graph.

**Inputs (environment):**
- `WHOACHART_WORKSPACE` — the marble's workpiece path (if any).
- `WHOACHART_CONTEXT` — path to the marble's context JSON (readable; merge via the
  emit mechanism).
- `WHOACHART_MARBLE` — marble id.
- `WHOACHART_NODE` — node id.
- For agents: a generated **brief** — workpiece location, the narrow job, relevant
  context summary, the available edge names, and how to signal done.

**Outputs:**
- Exit code (success / failure; failure routes to a `fail`-named/`default` edge or
  marks the marble failed if none).
- Optional structured stdout JSON: `next` (edge name) + arbitrary keys merged into
  context.

## 5. Node types (MVP set)

All node types register through one interface (§8). MVP ships:

| type | purpose | `config` (representative) | routing |
|---|---|---|---|
| `source` | intake — creates marbles | `trigger: api` (manual/api now; `timer`, `webhook` later), `template` (initial context) | emits to its successor |
| `shell` | run a command | `on_enter:` (script) | script emits `next` |
| `api` | HTTP call | `request:` (method, url, headers, body) | response mapped to `next` |
| `agent` | spawn a Tinstar session that works the marble | `agent:` (template), `brief:` | agent signals `next` |
| `decision` | pure routing, no work (diamond) | routing code / rules | emits `next` |
| `end` | terminal | `outcome: success \| fail \| warning` | none |

Notes:
- `end` with an `outcome` subsumes the heritage `SuccessState` / `FailState` /
  `WarningState` and their colorings.
- An `external` decision (block until a forced event names the edge) is a
  `decision` whose behavior waits — same shape, no new type needed for MVP.
- `llm` evaluator is **out of MVP** but is just an unregistered node behavior:
  a `decision`/`agent` variant whose `on_enter` asks a model and emits the name.

## 6. Execution engine

A long-lived **bun/TypeScript daemon** runs N marbles over one or more loaded
charts.

Per-marble loop:
```
enter node
  → run node behavior (under the activity contract)
  → obtain result (names an edge, or ends, or blocks)
  → run on_leave (cleanup)
  → run chosen edge's on_traversal (side effect)
  → move marble to edge.to
repeat until an `end` node or a failure
```

Cross-cutting:
- **Concurrency cap** — a global limit on simultaneously-running activities
  (especially agent sessions and shell jobs). Excess marbles wait in a per-node
  queue (the `●n queued` chip in the view).
- **Cycle/rework support** — charts may contain loops (review → revise → review);
  a per-marble step guard prevents runaway recursion.
- **Retry / timeout** — universal node policy; a failed activity retries up to
  `retry.max`, then routes to a `fail`/`default` edge or marks the marble failed.

## 7. Persistence

Marbles **must survive daemon restarts.** MVP stores marble state as **JSON files
on disk** (one source of truth; a NoSQL/doc-store is a deliberate later YAGNI
upgrade). On boot the daemon rehydrates in-flight marbles and resumes their loops.
Charts are plain YAML files on disk.

## 8. Extension model (the "extend later" guarantee)

Node types and routing behaviors are modules in an open **registry**, so new
capability is *registered*, not engine surgery.

```ts
interface NodeType {
  type: string
  configSchema: ZodSchema            // validates the child config block
  run(marble, node, ctx): Promise<NodeResult>   // behavior; may be a no-op for pure end nodes
}
// NodeResult names the next edge (or end / block) and may carry context merges.
```

Adding `timer`/`webhook` `source` triggers, an `llm` decision, or any new
flow-chart node type is implementing and registering one module.

## 9. Tinstar integration

Tinstar has **no API to draw a line/arrow between two canvas objects.** It places
widgets/sessions/artifacts and associates them by snapping + constellation
membership + matching color, and streams live updates over SSE
(`GET /api/events`); artifacts refresh via `PUT`. The design works within that.

### View bridge
- The whole chart renders as **one self-refreshing HTML artifact**
  (`POST /api/artifacts`, then `PUT` on change). All graph visuals — nodes,
  edges, marbles on nodes, per-node queue counts, active-edge animation,
  agent avatar faces, the inspector — are drawn inside our own HTML, so **edges
  just work** and we control the "Tinstar-chromed" look. (See the approved mockup
  posted to the canvas during design.)
- Live updates stream from the daemon's own SSE/HTTP endpoint into the artifact.

### Agent-session linking (MVP fidelity: associate, not draw)
When a marble enters an `agent` node, the daemon:
1. Spawns a **real Tinstar session** (`POST /api/sessions/.../spawn`) with the
   generated brief.
2. Snaps it into the **chart widget's constellation/slot** with the **node's
   color** (`slot` / `nearNodeId` / `snapToSession`).
3. Renders the **agent's avatar face on that marble** and badges the node live.

A literal node→session arrow is out of scope (it would require adding a connector
primitive to Tinstar itself — a named future path, since Will owns that repo).

### Control API
A small HTTP server on the daemon exposes:
- **Marble intake** — create a marble on a chart (the `source`/`start` entry).
  The CLI is a thin client of this endpoint.
- **Force transition** — push a marble across a named edge (external/manual).
- **Send event** — deliver a named event to a blocked marble.

## 10. Architecture (modules, one repo)

| Module | Responsibility |
|---|---|
| Chart loader | Parse/validate `whoachart.yaml` → canonical `{states[], edges[]}` model. |
| Node-type registry | Register/look up node-type modules + their config schemas. |
| Engine | Run N marbles; per-marble loop; concurrency cap; retry/timeout; cycle guard. |
| Activity runners | Implement the contract for `shell` / `api` / `agent`. |
| Marble store | JSON-file persistence; rehydrate on boot. |
| View bridge | Render chart → artifact; push SSE; agent spawn + constellation/color/avatar. |
| Control API | Intake, force-transition, send-event HTTP server. |
| CLI | Thin client over the Control API. |

Keep modules small and independently testable; the registry + contract are the
seams that let pieces evolve in isolation.

## 11. MVP scope

**In:**
- Chart loader + YAML schema (universal + typed `config`; dumb edges with
  `name`/`on_traversal`/`default`).
- Multi-marble engine: per-marble loop, concurrency cap, cycle guard,
  retry/timeout, JSON persistence with restart rehydration.
- Node types: `source` (api/manual), `shell`, `api`, `agent`, `decision`, `end`.
- Node-centric routing + the activity contract (env in, exit/JSON out, `whoachart
  next/set` helper).
- Live chromed view: marbles on nodes, queue counts, active edges, agent avatar
  faces, inspector — as one refreshing artifact.
- Agent session spawn + constellation/color/avatar association.
- Control API + CLI intake.
- One worked example chart: a content-through-experts pipeline
  (`research → draft → review? → edit → published / revise → rejected`).

**Out (named, not forgotten):**
- `llm` evaluator / decision (interface present; register later).
- Fan-out / fan-in within a single marble.
- Visual drag-to-author chart editor.
- Native Tinstar plugin packaging (vs. the artifact approach).
- Real drawn arrows from a node to its agent session (needs a Tinstar connector
  primitive).
- `timer` / `webhook` source triggers; NATS-triggered intake.
- NoSQL / doc-store persistence.

## 12. Error handling

- Activity non-zero exit → retry up to `retry.max`; then route to a `fail`/`default`
  edge if present, else mark the marble `failed` and surface it in the view.
- Unmatched emitted edge name → error the marble (config bug, fail loud).
- Daemon crash → marbles rehydrate from JSON on restart and resume.
- Concurrency cap reached → marbles queue (visible), never silently dropped.

## 13. Testing

- Chart loader: schema validation (good/bad configs, unknown types).
- Engine: deterministic single-marble traversal; multi-marble concurrency + cap;
  cycle guard; retry/timeout; restart rehydration from JSON.
- Activity runners: contract round-trip (env in, `next`/context-merge out) for
  shell and api; agent runner mocked against the Tinstar session API.
- View bridge: artifact POST/PUT against a stub; agent-spawn + constellation calls
  asserted against a Tinstar API stub.
- End-to-end: the worked example chart, several marbles, asserting final outcomes
  and provenance (context history) per marble.

## 14. Open questions / future

- Provenance/diff viewer for workpieces (free-ish if a workspace is a git dir).
- Reusable sub-charts / nested charts.
- Human-step UX (a `decision`/`external` node a person resolves from the canvas).
- Graduating to native per-node Tinstar widgets + a connector primitive for true
  node→session arrows.
