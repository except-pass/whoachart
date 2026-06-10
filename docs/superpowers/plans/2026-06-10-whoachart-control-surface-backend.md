# whoachart Control Surface — Plan A: Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the control-surface client needs server-side: marble trail timestamps + retry, the typed form system (intake + edge forms, validating agents and humans alike), a chart-aware ViewState (gate info, stats, dead letters), Tinstar widget-ensure + canvas pan, new API routes, and a served UI shell with a v0 JSON client.

**Architecture:** Per spec `docs/superpowers/specs/2026-06-09-whoachart-control-surface-design.md`. The daemon stops posting artifacts; instead it ensures one Tinstar browser-widget per chart pointing at its own `/ui/charts/<name>` page (public URL configurable). `ViewBridge` is deleted — the daemon owns a `ViewState(chart)` directly. Plan B replaces the v0 JSON client with the real app.

**Tech Stack:** unchanged — TypeScript on Bun, zod, no new dependencies.

**⚠ Branch note:** work on `whoachart-control-surface`. Do NOT merge to main after this plan — the canvas view is a raw JSON page until Plan B (client) lands on the same branch.

**Verified Tinstar facts** (read from `/home/ubuntu/repo/tinstar/src/server/api/routes.ts`):
- `POST /api/canvas/viewport` body `{"action":"focus","sessionName":"<name>"}` pans the user's canvas to a session (actions: set|focus|reset|fit).
- `POST /api/browser-widgets` body `{url, title?, color?, ...}` → `{ok:true, data:<widget>}` where `data.id` is the widget id.
- `GET /api/state` includes `browserWidgets: [{id, url, title?, ...}]`.

---

## File Structure

| File | Change |
|---|---|
| `src/types.ts` | Add `TrailHop`, `FormField`, `PresentSpec`; extend `Marble` (trail), `ChartNode` (stuck_after, present), `ChartEdge` (form). |
| `src/engine.ts` | Maintain trail; `retry()`; `retried` event. |
| `src/forms.ts` | NEW — `formFieldSchema`, `FormError`, `validateForm`. |
| `src/schema.ts` | nodeSchema/edgeSchema gain the new fields. |
| `src/nodeTypes/source.ts` | config gains `form`. |
| `src/nodeTypes/human.ts` | NEW — blocking gate node type. |
| `src/view/viewState.ts` | Chart-aware v2: enteredAt, gate info, stats, deadLetter. |
| `src/view/bridge.ts` | DELETED (Task 5). |
| `src/view/render.ts` | DELETED (Task 6). |
| `src/tinstar.ts` | `CanvasControl`: `ensureBrowserWidget`, `panToSession`. |
| `src/daemon.ts` | ViewState direct, validations, `retry`/`def`/`focusSession`, publicUrl, widget-ensure loop. |
| `src/controlApi.ts` | `def`, `retry`, `focus-session`, FormError→400, `/ui/*` routes. |
| `src/ui/page.ts` | NEW — shell HTML. |
| `src/ui/static.ts` | NEW — serve `/ui/*.js` from `src/ui/public/`. |
| `src/ui/public/app.js` | NEW — v0 client (live JSON view; Plan B replaces). |
| `src/main.ts` | `WHOACHART_PUBLIC_URL`. |
| `tests/fakes.ts` | NEW — shared `FakeCanvas`, `FakeLauncher`. |
| `examples/gate-demo.yaml` | NEW — human-gate example with forms. |

---

## Task 1: Marble trail + Engine.retry

**Files:**
- Modify: `src/types.ts`, `src/engine.ts`, `src/daemon.ts` (fmtEvent only)
- Test: `tests/engineTrail.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/engineTrail.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import { Engine, newMarble, type EngineEvent } from "../src/engine"
import { MarbleStore } from "../src/store"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry, registerNodeType } from "../src/registry"
import type { Chart } from "../src/types"

let failOnce = 0
beforeEach(() => {
  clearRegistry()
  registerBuiltins()
  failOnce = 0
  registerNodeType({
    type: "flaky",
    configSchema: z.object({}).passthrough(),
    run: async () => {
      if (failOnce++ === 0) throw new Error("first run breaks")
      return {}
    },
  })
})

function store() { return new MarbleStore(join(tmpdir(), "wc-tr-" + crypto.randomUUID().slice(0, 8))) }

const linear: Chart = {
  name: "lin",
  nodes: [
    { id: "s", type: "source", config: {} },
    { id: "w", type: "shell", config: { on_enter: "sleep 0.05" } },
    { id: "done", type: "end", config: { outcome: "success" } },
  ],
  edges: [ { from: "s", to: "w" }, { from: "w", to: "done" } ],
}

test("trail records a timestamped hop per node, closing on leave", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart: linear, store: st })
  const m = newMarble("lin", "s")
  expect(m.trail).toEqual([{ node: "s", enteredAt: m.createdAt }])
  await eng.submit(m); await eng.drain()
  const f = (await st.load(m.id))!
  expect(f.trail!.map((h) => h.node)).toEqual(["s", "w", "done"])
  expect(f.trail![0].leftAt).toBeTruthy()
  expect(f.trail![1].leftAt).toBeTruthy()
  expect(f.trail![2].leftAt).toBeUndefined() // still at the end node
  const dwell = new Date(f.trail![1].leftAt!).getTime() - new Date(f.trail![1].enteredAt).getTime()
  expect(dwell).toBeGreaterThanOrEqual(40)
})

test("marbles without a trail rehydrate fine (legacy records)", async () => {
  const st = store(); await st.init()
  const legacy = { ...newMarble("lin", "w"), trail: undefined }
  await st.save(legacy)
  const eng = new Engine({ chart: linear, store: st })
  await eng.resume(); await eng.drain()
  const f = (await st.load(legacy.id))!
  expect(f.status).toBe("done")
  expect(f.trail!.at(-1)!.node).toBe("done")
})

test("retry re-runs a failed marble and emits a retried event", async () => {
  const chart: Chart = {
    name: "r",
    nodes: [
      { id: "a", type: "flaky", config: {} },
      { id: "z", type: "end", config: { outcome: "success" } },
    ],
    edges: [{ from: "a", to: "z" }],
  }
  const events: EngineEvent[] = []
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st, onEvent: (e) => events.push(e) })
  const m = newMarble("r", "a")
  await eng.submit(m); await eng.drain()
  expect((await st.load(m.id))!.status).toBe("failed")

  await eng.retry(m.id); await eng.drain()
  const f = (await st.load(m.id))!
  expect(f.status).toBe("done")
  expect(f.error).toBeUndefined()
  expect(events.some((e) => e.type === "retried")).toBe(true)
})

test("retry on a non-failed marble throws", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart: linear, store: st })
  const m = newMarble("lin", "s")
  await eng.submit(m); await eng.drain()
  await expect(eng.retry(m.id)).rejects.toThrow(/not failed/)
  await expect(eng.retry("nope")).rejects.toThrow(/unknown marble/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/engineTrail.test.ts` — Expected: FAIL (`trail` undefined / `retry` not a function).

- [ ] **Step 3: Implement**

`src/types.ts` — add near the top:

```ts
export interface TrailHop {
  node: string
  enteredAt: string
  leftAt?: string
}

export interface FormField {
  key: string
  type: "text" | "textarea" | "number" | "boolean" | "enum"
  label?: string
  required?: boolean
  default?: unknown
  options?: string[]
  min?: number
  max?: number
  step?: number
}

export interface PresentSpec {
  key: string
  as: "markdown" | "json" | "text" | "link"
}
```

Extend `ChartNode` with two optional fields (after `position`):

```ts
  stuck_after?: number // seconds before a dwelling marble is flagged stuck
  present?: PresentSpec[]
```

Extend `ChartEdge` with:

```ts
  form?: FormField[]
```

Extend `Marble` with (after `history`):

```ts
  trail?: TrailHop[]
```

`src/engine.ts`:

(a) `newMarble` return gains the seed hop — the return statement becomes:

```ts
  return {
    id: genId(), chart, node: startNode, context, workpiece,
    history: [startNode], trail: [{ node: startNode, enteredAt: t }],
    status: "queued", createdAt: t, updatedAt: t,
  }
```

(b) Add `"retried"` to the `EngineEvent` union:

```ts
  | { type: "retried"; marble: string; node: string }
```

(c) Add after `signal()`:

```ts
  // Re-run a failed marble from the node it failed at.
  async retry(id: string): Promise<void> {
    const m = await this.opts.store.load(id)
    if (!m) throw new Error(`unknown marble: ${id}`)
    if (m.status !== "failed") throw new Error(`marble ${id} is not failed (status: ${m.status})`)
    m.status = "queued"
    m.error = undefined
    this.emit({ type: "retried", marble: m.id, node: m.node })
    await this.persist(m)
    this.enqueue(m)
  }
```

(d) In `step()`, replace the two lines

```ts
      m.node = edge.to
      m.history.push(edge.to)
```

with

```ts
      const leftAt = now()
      const trail = (m.trail ??= [])
      const lastHop = trail[trail.length - 1]
      if (lastHop && lastHop.node === node.id && !lastHop.leftAt) lastHop.leftAt = leftAt
      m.node = edge.to
      m.history.push(edge.to)
      trail.push({ node: edge.to, enteredAt: leftAt })
```

`src/daemon.ts` — add a case to `fmtEvent` (the switch is exhaustive; compile fails without it):

```ts
    case "retried": return `retried marble=${e.marble} node=${e.node}`
```

- [ ] **Step 4: Verify**

Run: `bun test tests/engineTrail.test.ts` → 4 pass. `bun test` → all green (94). `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/engine.ts src/daemon.ts tests/engineTrail.test.ts
git commit -m "feat: timestamped marble trail and engine retry"
```

---

## Task 2: Form system + chart schema extensions + human node

**Files:**
- Create: `src/forms.ts`, `src/nodeTypes/human.ts`
- Modify: `src/schema.ts`, `src/nodeTypes/source.ts`, `src/nodeTypes/index.ts`
- Test: `tests/forms.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/forms.test.ts
import { test, expect, beforeEach } from "bun:test"
import { validateForm, FormError, formFieldSchema } from "../src/forms"
import { parseChart } from "../src/schema"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry, getNodeType, hasNodeType } from "../src/registry"
import type { FormField } from "../src/types"

beforeEach(() => { clearRegistry(); registerBuiltins() })

const FORM: FormField[] = [
  { key: "title", type: "text", required: true },
  { key: "priority", type: "enum", options: ["low", "med", "high"], default: "med" },
  { key: "copies", type: "number", min: 1, default: 1 },
  { key: "rush", type: "boolean" },
]

test("valid values pass, defaults apply, numbers coerce", () => {
  const out = validateForm(FORM, { title: "x", copies: "3", rush: "true" })
  expect(out).toEqual({ title: "x", copies: 3, rush: true, priority: "med" })
})

test("missing required + bad enum + out-of-range report per-field errors", () => {
  try {
    validateForm(FORM, { priority: "urgent", copies: 0 })
    throw new Error("should have thrown")
  } catch (err) {
    expect(err).toBeInstanceOf(FormError)
    const fields = (err as FormError).fields
    expect(fields.title).toBe("required")
    expect(fields.priority).toContain("one of")
    expect(fields.copies).toContain(">= 1")
  }
})

test("enum field without options is rejected at schema level", () => {
  expect(() => formFieldSchema.parse({ key: "x", type: "enum" })).toThrow(/options/)
})

test("chart YAML accepts form/present/stuck_after and the human node blocks", async () => {
  const chart = parseChart(`
name: g
nodes:
  - id: ingest
    type: source
    config:
      trigger: api
      form:
        - { key: title, type: text, required: true }
  - id: gate
    type: human
    stuck_after: 120
    present:
      - { key: title, as: text }
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: gate }
  - { from: gate, to: done, name: ok,
      form: [ { key: note, type: textarea, required: true } ] }
`)
  expect(hasNodeType("human")).toBe(true)
  const gate = chart.nodes.find((n) => n.id === "gate")!
  expect(gate.stuck_after).toBe(120)
  expect(gate.present![0]).toEqual({ key: "title", as: "text" })
  expect(chart.edges[1].form![0].key).toBe("note")
  const r = await getNodeType("human").run({
    chart, node: gate, outgoing: [],
    marble: { id: "m", chart: "g", node: "gate", context: {}, history: ["gate"], status: "running", createdAt: "t", updatedAt: "t" },
  })
  expect(r.block).toBe(true)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/forms.test.ts` — Expected: FAIL (cannot find `../src/forms`).

- [ ] **Step 3: Implement**

```ts
// src/forms.ts
import { z } from "zod"
import type { FormField } from "./types"

export const formFieldSchema: z.ZodType<FormField> = z
  .object({
    key: z.string(),
    type: z.enum(["text", "textarea", "number", "boolean", "enum"]),
    label: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    options: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "enum" && (!f.options || f.options.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enum field requires options" })
    }
  })

export class FormError extends Error {
  constructor(public fields: Record<string, string>) {
    super(`form validation failed: ${Object.keys(fields).join(", ")}`)
  }
}

// Validate submitted values against a form. Applies defaults, coerces numbers
// and booleans from strings (curl ergonomics), throws FormError with
// per-field messages. The SERVER is the enforcement point — agents signaling
// an edge are held to the same schema as humans.
export function validateForm(form: FormField[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values }
  const fields: Record<string, string> = {}
  for (const f of form) {
    const v = out[f.key]
    if (v === undefined || v === null || v === "") {
      if (f.default !== undefined) out[f.key] = f.default
      else if (f.required) fields[f.key] = "required"
      continue
    }
    switch (f.type) {
      case "number": {
        const n = typeof v === "number" ? v : Number(v)
        if (Number.isNaN(n)) { fields[f.key] = "must be a number"; break }
        if (f.min !== undefined && n < f.min) { fields[f.key] = `must be >= ${f.min}`; break }
        if (f.max !== undefined && n > f.max) { fields[f.key] = `must be <= ${f.max}`; break }
        out[f.key] = n
        break
      }
      case "boolean": {
        if (typeof v === "boolean") break
        if (v === "true") { out[f.key] = true; break }
        if (v === "false") { out[f.key] = false; break }
        fields[f.key] = "must be a boolean"
        break
      }
      case "enum": {
        if (!f.options!.includes(String(v))) fields[f.key] = `must be one of: ${f.options!.join(", ")}`
        break
      }
      case "text":
      case "textarea": {
        if (typeof v !== "string") fields[f.key] = "must be a string"
        break
      }
    }
  }
  if (Object.keys(fields).length > 0) throw new FormError(fields)
  return out
}
```

```ts
// src/nodeTypes/human.ts
import { z } from "zod"
import type { NodeType } from "../registry"

// A human gate: the marble blocks here until a person (or a forcing caller)
// signals an edge. Presentation/decision UX comes from the node's universal
// `present` field and the outgoing edges' `form`s.
export const humanNode: NodeType = {
  type: "human",
  configSchema: z.object({}).passthrough(),
  async run() {
    return { block: true }
  },
}
```

`src/nodeTypes/index.ts` — add the import and registration:

```ts
import { humanNode } from "./human"
```

and inside `registerBuiltins()` add (next to the others):

```ts
  registerNodeType(humanNode)
```

`src/schema.ts`:

(a) Add to the imports: `import { formFieldSchema } from "./forms"`

(b) `edgeSchema` gains (after `default`):

```ts
  form: z.array(formFieldSchema).optional(),
```

(c) `nodeSchema` gains (after `position`):

```ts
  stuck_after: z.number().int().positive().optional(),
  present: z
    .array(z.object({ key: z.string(), as: z.enum(["markdown", "json", "text", "link"]).default("text") }))
    .optional(),
```

`src/nodeTypes/source.ts` — config schema gains `form`; the schema becomes:

```ts
  configSchema: z.object({
    trigger: z.enum(["api", "manual"]).default("api"),
    template: z.record(z.unknown()).optional(),
    form: z.array(formFieldSchema).optional(),
  }),
```

with `import { formFieldSchema } from "../forms"` added at the top.

- [ ] **Step 4: Verify**

Run: `bun test tests/forms.test.ts` → 4 pass. `bun test` → all green. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/forms.ts src/nodeTypes/human.ts src/nodeTypes/index.ts src/nodeTypes/source.ts src/schema.ts tests/forms.test.ts
git commit -m "feat: typed form system, human gate node, schema extensions"
```

---

## Task 3: ViewState v2 (chart-aware)

**Files:**
- Modify: `src/view/viewState.ts` (full rewrite below), `src/view/bridge.ts` (one line)
- Test: `tests/viewState.test.ts` (full rewrite below)

- [ ] **Step 1: Replace `tests/viewState.test.ts` with**

```ts
import { test, expect } from "bun:test"
import { ViewState } from "../src/view/viewState"
import type { Chart, Marble } from "../src/types"

const chart: Chart = {
  name: "c",
  nodes: [
    { id: "work", type: "shell", config: {} },
    { id: "gate", type: "human", stuck_after: 60, present: [{ key: "title", as: "text" }], config: {} },
    { id: "agentstep", type: "agent", config: {} },
    { id: "done", type: "end", config: {} },
  ],
  edges: [
    { from: "work", to: "gate" },
    { from: "gate", to: "done", name: "ok", form: [{ key: "note", type: "textarea", required: true }] },
    { from: "gate", to: "work", name: "redo" },
    { from: "agentstep", to: "done", name: "ship" },
  ],
}

function marble(id: string, node: string, status: Marble["status"], extra: Partial<Marble> = {}): Marble {
  return {
    id, chart: "c", node, context: {}, history: [node],
    trail: [{ node, enteredAt: "2026-06-10T00:00:00.000Z" }],
    status, createdAt: "t", updatedAt: "u", ...extra,
  }
}

test("live marbles carry enteredAt from the trail", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "work", "running"))
  expect(v.snapshot().live[0].enteredAt).toBe("2026-06-10T00:00:00.000Z")
})

test("blocked marble at a human node exposes gate info", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "gate", "blocked"))
  const gate = v.snapshot().live[0].gate!
  expect(gate.agent).toBe(false)
  expect(gate.edges.map((e) => e.name)).toEqual(["ok", "redo"])
  expect(gate.edges[0].form![0].key).toBe("note")
  expect(gate.present![0].key).toBe("title")
})

test("blocked marble at an agent node is flagged agent", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "agentstep", "blocked"))
  expect(v.snapshot().live[0].gate!.agent).toBe(true)
})

test("closed trail hops feed dwell stats exactly once", () => {
  const v = new ViewState(chart)
  const trail = [
    { node: "work", enteredAt: "2026-06-10T00:00:00.000Z", leftAt: "2026-06-10T00:00:01.000Z" },
    { node: "gate", enteredAt: "2026-06-10T00:00:01.000Z" },
  ]
  v.apply(marble("m1", "gate", "blocked", { trail }))
  v.apply(marble("m1", "gate", "blocked", { trail })) // re-apply: no double count
  const s = v.snapshot().stats
  expect(s.work.runs).toBe(1)
  expect(s.work.dwellP50).toBe(1000)
  expect(s.work.dwellP95).toBe(1000)
})

test("errored marbles go to deadLetter (first line), not the end tally", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "work", "failed", { error: "exit 7: boom\nstack stack" }))
  const snap = v.snapshot()
  expect(snap.deadLetter).toEqual([{ id: "m1", node: "work", error: "exit 7: boom", failedAt: "u" }])
  expect(Object.keys(snap.ends)).toHaveLength(0)
  expect(snap.stats.work.fails).toBe(1)
})

test("a retried marble leaves the dead letter tray", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "work", "failed", { error: "boom" }))
  v.apply(marble("m1", "work", "queued"))
  expect(v.snapshot().deadLetter).toHaveLength(0)
})

test("outcome-fail at an end node tallies normally (no error => not a dead letter)", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "done", "failed"))
  expect(v.snapshot().ends.done.total).toBe(1)
  expect(v.snapshot().deadLetter).toHaveLength(0)
})

test("dead letter tray is bounded to 20", () => {
  const v = new ViewState(chart)
  for (let i = 0; i < 25; i++) v.apply(marble(`m${i}`, "work", "failed", { error: "x" }))
  expect(v.snapshot().deadLetter).toHaveLength(20)
})

test("recent dots stay bounded while totals keep counting", () => {
  const v = new ViewState(chart, 3)
  for (let i = 0; i < 10; i++) v.apply(marble(`m${i}`, "done", "done"))
  const t = v.snapshot().ends.done
  expect(t.total).toBe(10)
  expect(t.recent.map((r) => r.id)).toEqual(["m7", "m8", "m9"])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/viewState.test.ts` — Expected: FAIL (constructor signature / missing fields).

- [ ] **Step 3: Replace `src/view/viewState.ts` with**

```ts
import type { Chart, ChartEdge, ChartNode, FormField, Marble, PresentSpec } from "../types"

const RECENT_N = 8
const DWELL_SAMPLES = 64
const DEAD_LETTER_MAX = 20

export interface GateInfo {
  agent: boolean
  edges: { name: string; form?: FormField[] }[]
  present?: PresentSpec[]
}

export interface LiveMarble {
  id: string
  node: string
  status: string
  enteredAt: string
  gate?: GateInfo
}

export interface EndTally {
  total: number
  recent: { id: string; status: string }[]
}

export interface NodeStats {
  runs: number
  fails: number
  dwellP50: number | null
  dwellP95: number | null
}

export interface DeadLetter {
  id: string
  node: string
  error: string
  failedAt: string
}

export interface ViewSnapshot {
  live: LiveMarble[]
  ends: Record<string, EndTally>
  stats: Record<string, NodeStats>
  deadLetter: DeadLetter[]
}

function pct(samples: number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

// In-memory aggregate of a chart's marbles for the live view. Updated O(1) per
// engine onChange — never rescans the store. Bounded by design: in-flight
// marbles individually, last-N completed dots + counters per end node, last-20
// dead letters, 64 dwell samples per node. In-memory only (resets on restart).
export class ViewState {
  private live = new Map<string, LiveMarble>()
  private ends = new Map<string, EndTally>()
  private nodeStats = new Map<string, { runs: number; fails: number; samples: number[] }>()
  private dead = new Map<string, DeadLetter>()
  private seenHops = new Map<string, number>() // marble id -> closed hops already counted

  constructor(private chart: Chart, private recentN = RECENT_N) {}

  private nodeById(id: string): ChartNode | undefined {
    return this.chart.nodes.find((n) => n.id === id)
  }

  private outgoing(id: string): ChartEdge[] {
    return this.chart.edges.filter((e) => e.from === id)
  }

  private stat(node: string) {
    let s = this.nodeStats.get(node)
    if (!s) {
      s = { runs: 0, fails: 0, samples: [] }
      this.nodeStats.set(node, s)
    }
    return s
  }

  // Count each CLOSED trail hop exactly once into dwell stats.
  private recordDwells(m: Marble): void {
    const trail = m.trail ?? []
    const counted = this.seenHops.get(m.id) ?? 0
    let closed = 0
    for (const hop of trail) {
      if (!hop.leftAt) continue
      closed++
      if (closed <= counted) continue
      const s = this.stat(hop.node)
      s.runs++
      s.samples.push(new Date(hop.leftAt).getTime() - new Date(hop.enteredAt).getTime())
      if (s.samples.length > DWELL_SAMPLES) s.samples.shift()
    }
    this.seenHops.set(m.id, closed)
  }

  apply(m: Marble): void {
    this.recordDwells(m)
    if (m.status === "done" || m.status === "failed") {
      this.live.delete(m.id)
      this.seenHops.delete(m.id)
      if (m.status === "failed" && m.error) {
        // an ERRORED marble is a dead letter, not a normal rejection
        this.dead.set(m.id, { id: m.id, node: m.node, error: m.error.split("\n")[0], failedAt: m.updatedAt })
        while (this.dead.size > DEAD_LETTER_MAX) {
          this.dead.delete(this.dead.keys().next().value as string)
        }
        this.stat(m.node).fails++
        return
      }
      const tally = this.ends.get(m.node) ?? { total: 0, recent: [] }
      tally.total += 1
      tally.recent.push({ id: m.id, status: m.status })
      if (tally.recent.length > this.recentN) tally.recent.shift()
      this.ends.set(m.node, tally)
      return
    }

    this.dead.delete(m.id) // a retried marble leaves the tray
    const node = this.nodeById(m.node)
    const lm: LiveMarble = {
      id: m.id,
      node: m.node,
      status: m.status,
      enteredAt: (m.trail ?? []).at(-1)?.enteredAt ?? m.updatedAt,
    }
    if (m.status === "blocked" && node) {
      lm.gate = {
        agent: node.type === "agent",
        edges: this.outgoing(node.id).map((e) => ({ name: e.name ?? e.to, form: e.form })),
        present: node.present,
      }
    }
    this.live.set(m.id, lm)
  }

  seed(marbles: Marble[]): void {
    for (const m of marbles) this.apply(m)
  }

  snapshot(): ViewSnapshot {
    const ends: Record<string, EndTally> = {}
    for (const [node, t] of this.ends) ends[node] = { total: t.total, recent: [...t.recent] }
    const stats: Record<string, NodeStats> = {}
    for (const [node, s] of this.nodeStats) {
      stats[node] = { runs: s.runs, fails: s.fails, dwellP50: pct(s.samples, 50), dwellP95: pct(s.samples, 95) }
    }
    return { live: [...this.live.values()], ends, stats, deadLetter: [...this.dead.values()] }
  }
}
```

In `src/view/bridge.ts`, change the ViewState construction line (bridge is deleted in Task 5; this keeps the repo green meanwhile):

```ts
  private state: ViewState
```
and in the constructor body (first line):
```ts
    this.state = new ViewState(chart)
```
(replacing the `private state = new ViewState()` field initializer).

- [ ] **Step 4: Verify**

Run: `bun test tests/viewState.test.ts` → 9 pass. `bun test` → all green. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/view/viewState.ts src/view/bridge.ts tests/viewState.test.ts
git commit -m "feat: chart-aware ViewState — gate info, dwell stats, dead letters"
```

---

## Task 4: Tinstar canvas control (widget ensure + pan)

**Files:**
- Modify: `src/tinstar.ts`
- Test: `tests/tinstarCanvas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tinstarCanvas.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { TinstarClient } from "../src/tinstar"

let server: ReturnType<typeof Bun.serve>
let base: string
let widgets: any[] = []
let viewportCalls: any[] = []

beforeEach(() => {
  widgets = []
  viewportCalls = []
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/api/state") {
        return Response.json({ browserWidgets: widgets })
      }
      if (req.method === "POST" && url.pathname === "/api/browser-widgets") {
        const body = (await req.json()) as any
        const w = { id: `browser-${widgets.length + 1}`, ...body }
        widgets.push(w)
        return Response.json({ ok: true, data: w })
      }
      if (req.method === "POST" && url.pathname === "/api/canvas/viewport") {
        viewportCalls.push(await req.json())
        return Response.json({ ok: true })
      }
      return new Response("nope", { status: 404 })
    },
  })
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("ensureBrowserWidget creates when absent, reuses when present", async () => {
  const c = new TinstarClient(base)
  const a = await c.ensureBrowserWidget({ url: "http://x/ui/charts/demo", title: "whoachart-demo" })
  expect(a.widgetId).toBe("browser-1")
  const b = await c.ensureBrowserWidget({ url: "http://x/ui/charts/demo" })
  expect(b.widgetId).toBe("browser-1") // no duplicate
  expect(widgets).toHaveLength(1)
})

test("panToSession posts a focus viewport directive", async () => {
  const c = new TinstarClient(base)
  expect(await c.panToSession("wc-demo-m1")).toBe(true)
  expect(viewportCalls[0]).toEqual({ action: "focus", sessionName: "wc-demo-m1" })
})

test("panToSession returns false when tinstar is unreachable", async () => {
  const c = new TinstarClient("http://localhost:1")
  expect(await c.panToSession("x")).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/tinstarCanvas.test.ts` — Expected: FAIL (`ensureBrowserWidget` not a function).

- [ ] **Step 3: Implement**

In `src/tinstar.ts`, add after the `SessionLauncher` interface:

```ts
export interface EnsureWidgetOpts {
  url: string
  title?: string
  color?: string
}

// Canvas-side controls the daemon uses: keep one widget per chart pointing at
// the daemon's UI, and pan the user's canvas to a session on request.
export interface CanvasControl {
  ensureBrowserWidget(opts: EnsureWidgetOpts): Promise<{ widgetId: string }>
  panToSession(sessionName: string): Promise<boolean>
}
```

Change the class declaration to:

```ts
export class TinstarClient implements ArtifactSink, SessionLauncher, CanvasControl {
```

Add the methods inside the class:

```ts
  async ensureBrowserWidget(opts: EnsureWidgetOpts): Promise<{ widgetId: string }> {
    const stateRes = await fetch(`${this.baseUrl}/api/state`)
    const state = (await stateRes.json().catch(() => ({}))) as any
    const existing = (state?.browserWidgets ?? []).find((w: any) => w?.url === opts.url)
    if (existing) return { widgetId: existing.id }

    const res = await fetch(`${this.baseUrl}/api/browser-widgets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    })
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok || body?.ok === false) {
      throw new Error(`ensureBrowserWidget failed: ${res.status} ${JSON.stringify(body)}`)
    }
    return { widgetId: body.data.id }
  }

  async panToSession(sessionName: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/canvas/viewport`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "focus", sessionName }),
    }).catch(() => null)
    return !!res && res.ok
  }
```

- [ ] **Step 4: Verify**

Run: `bun test tests/tinstarCanvas.test.ts` → 3 pass. `bun test` → all green. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/tinstar.ts tests/tinstarCanvas.test.ts
git commit -m "feat: tinstar canvas control — widget ensure (deduped) and session pan"
```

---

## Task 5: Daemon rework

**Files:**
- Modify: `src/daemon.ts`, `src/main.ts`
- Delete: `src/view/bridge.ts`, `tests/bridge.test.ts`
- Create: `tests/fakes.ts`
- Modify (mechanical): `tests/daemon.test.ts`, `tests/controlApi.test.ts`, `tests/daemonAgent.test.ts`, `tests/controlApiSignal.test.ts`, `tests/e2eAgent.test.ts`
- Test: `tests/daemonControl.test.ts`

- [ ] **Step 1: Create the shared fakes**

```ts
// tests/fakes.ts
import type { CanvasControl, EnsureWidgetOpts, SessionLauncher, SpawnSessionOpts } from "../src/tinstar"

export class FakeCanvas implements CanvasControl {
  ensured: EnsureWidgetOpts[] = []
  panned: string[] = []
  failEnsure = false
  async ensureBrowserWidget(opts: EnsureWidgetOpts): Promise<{ widgetId: string }> {
    if (this.failEnsure) throw new Error("tinstar down")
    this.ensured.push(opts)
    return { widgetId: "browser-fake" }
  }
  async panToSession(name: string): Promise<boolean> {
    this.panned.push(name)
    return true
  }
}

export class FakeLauncher implements SessionLauncher {
  spawned: SpawnSessionOpts[] = []
  stopped: string[] = []
  async spawnSession(o: SpawnSessionOpts) {
    this.spawned.push(o)
    return { name: o.name }
  }
  async stopSession(n: string) {
    this.stopped.push(n)
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/daemonControl.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { FormError } from "../src/forms"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"

const CHART = `
name: gatey
nodes:
  - id: ingest
    type: source
    config:
      trigger: api
      form:
        - { key: title, type: text, required: true }
  - id: gate
    type: human
    config: {}
  - id: ok
    type: end
    config: { outcome: success }
  - id: no
    type: end
    config: { outcome: fail }
edges:
  - { from: ingest, to: gate }
  - { from: gate, to: ok, name: approve }
  - { from: gate, to: no, name: decline,
      form: [ { key: reason, type: textarea, required: true } ] }
`

beforeEach(() => clearRegistry())

async function makeDaemon(canvas = new FakeCanvas()) {
  const dir = await mkdtemp(join(tmpdir(), "wc-dc-"))
  await writeFile(join(dir, "gatey.yaml"), CHART)
  const d = new Daemon({
    charts: [join(dir, "gatey.yaml")],
    storeDir: join(dir, "store"),
    client: canvas,
    launcher: new FakeLauncher(),
    baseUrl: "http://localhost:5330",
    publicUrl: "http://tailnet:5331",
  })
  await d.start()
  return { d, canvas }
}

test("start ensures a widget pointing at the public UI url", async () => {
  const { canvas } = await makeDaemon()
  expect(canvas.ensured).toHaveLength(1)
  expect(canvas.ensured[0].url).toBe("http://tailnet:5331/ui/charts/gatey")
})

test("start survives tinstar being down (widget ensure retries later)", async () => {
  const canvas = new FakeCanvas()
  canvas.failEnsure = true
  const { d } = await makeDaemon(canvas) // must not throw
  expect(d.charts()).toEqual(["gatey"])
})

test("def exposes nodes, edges with forms, layout, and the source form", async () => {
  const { d } = await makeDaemon()
  const def = d.def("gatey")
  expect(def.start).toBe("ingest")
  expect(def.nodes.find((n) => n.id === "ingest")!.form![0].key).toBe("title")
  expect(def.edges.find((e) => e.name === "decline")!.form![0].key).toBe("reason")
  expect(def.layout.boxes.gate).toBeDefined()
  expect(def.layout.width).toBeGreaterThan(0)
})

test("submit validates the source form", async () => {
  const { d } = await makeDaemon()
  await expect(d.submit("gatey", { context: {} })).rejects.toThrow(FormError)
  const m = await d.submit("gatey", { context: { title: "hi" } })
  expect(m.id).toBeTruthy()
})

test("signal validates the chosen edge form (agents held to it too)", async () => {
  const { d } = await makeDaemon()
  const m = await d.submit("gatey", { context: { title: "hi" } })
  await new Promise((r) => setTimeout(r, 200)) // reach the gate
  await expect(d.signal("gatey", m.id, { next: "decline", merge: {} })).rejects.toThrow(FormError)
  await d.signal("gatey", m.id, { next: "decline", merge: { reason: "nope" } })
  await new Promise((r) => setTimeout(r, 200))
  const f = await d.marble("gatey", m.id)
  expect(f!.node).toBe("no")
  expect(f!.context.reason).toBe("nope")
})

test("retry passes through and focusSession reports status", async () => {
  const { d, canvas } = await makeDaemon()
  const m = await d.submit("gatey", { context: { title: "hi" } })
  await new Promise((r) => setTimeout(r, 200))
  expect(await d.focusSession("gatey", m.id)).toBe("no-session")
  await expect(d.retry("gatey", m.id)).rejects.toThrow(/not failed/)
  // focusSession with a session present pans
  const m2 = await d.submit("gatey", { context: { title: "x" } })
  await new Promise((r) => setTimeout(r, 200))
  const rec = (await d.marble("gatey", m2.id))!
  rec.context._session = "wc-fake"
  const { MarbleStore } = await import("../src/store")
  // write the session into the store so focusSession sees it
  const store = new MarbleStore(join((d as any).opts.storeDir, "gatey"))
  await store.save(rec)
  expect(await d.focusSession("gatey", m2.id)).toBe("ok")
  expect(canvas.panned).toEqual(["wc-fake"])
})
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test tests/daemonControl.test.ts` — Expected: FAIL (publicUrl unknown, def/retry/focusSession missing, client type mismatch).

- [ ] **Step 4: Implement**

Replace the **entire contents** of `src/daemon.ts` with:

```ts
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseChart } from "./schema"
import { registerBuiltins } from "./nodeTypes"
import { makeAgentNode } from "./nodeTypes/agent"
import { hasNodeType, registerNodeType } from "./registry"
import { MarbleStore } from "./store"
import { Engine, newMarble, type EngineEvent } from "./engine"
import { ViewState, type ViewSnapshot } from "./view/viewState"
import { layoutChart, type Layout, type NodeBox } from "./view/layout"
import { validateForm } from "./forms"
import type { CanvasControl, SessionLauncher, SpawnSessionOpts } from "./tinstar"
import type { Chart, ChartNode, FormField, Marble, PresentSpec } from "./types"

// One timestamped line per lifecycle event — the operator audit trail.
function logLine(chart: string, msg: string): void {
  console.log(`[whoachart] ${new Date().toISOString()} ${chart} ${msg}`)
}

function fmtEvent(e: EngineEvent): string {
  switch (e.type) {
    case "enter": return `enter marble=${e.marble} node=${e.node}`
    case "blocked": return `blocked marble=${e.marble} node=${e.node} (awaiting signal)`
    case "signaled": return `resumed marble=${e.marble} node=${e.node} next=${e.next ?? "-"}`
    case "traverse": return `traverse marble=${e.marble} ${e.from}->${e.to}${e.edge ? ` edge=${e.edge}` : ""}`
    case "end": return `end marble=${e.marble} node=${e.node} outcome=${e.outcome}`
    case "failed": return `FAILED marble=${e.marble} node=${e.node} error=${e.error.split("\n")[0]}`
    case "retried": return `retried marble=${e.marble} node=${e.node}`
  }
}

function loggingLauncher(inner: SessionLauncher): SessionLauncher {
  return {
    async spawnSession(opts: SpawnSessionOpts) {
      const ref = await inner.spawnSession(opts)
      logLine("-", `session spawned name=${ref.name}`)
      return ref
    },
    async stopSession(name: string) {
      logLine("-", `session stopping name=${name}`)
      await inner.stopSession(name)
    },
  }
}

export interface DaemonOpts {
  charts: string[]
  storeDir: string
  // Tinstar canvas controls (widget ensure + pan). FakeCanvas in tests.
  client: CanvasControl
  concurrency?: number
  // This daemon's own local base (agent signal URLs).
  baseUrl?: string
  // The URL browsers use to reach this daemon (tailnet hostname in prod).
  publicUrl?: string
  launcher?: SessionLauncher
}

interface ChartRuntime {
  chart: Chart
  engine: Engine
  store: MarbleStore
  view: ViewState
  layout: Layout
  start: string
}

export interface SubmitOpts {
  context?: Record<string, unknown>
  workpiece?: string
  start?: string
}

export interface ChartDef {
  name: string
  start: string
  nodes: {
    id: string
    type: string
    name?: string
    color?: string
    present?: PresentSpec[]
    stuck_after?: number
    form?: FormField[]
  }[]
  edges: { from: string; to: string; name?: string; default?: boolean; form?: FormField[] }[]
  layout: { boxes: Record<string, NodeBox>; width: number; height: number }
}

function findStart(chart: Chart): string {
  const source = chart.nodes.find((n) => n.type === "source")
  if (source) return source.id
  const hasIncoming = new Set(chart.edges.map((e) => e.to))
  const root = chart.nodes.find((n) => !hasIncoming.has(n.id))
  return (root ?? chart.nodes[0]).id
}

export class Daemon {
  private runtimes = new Map<string, ChartRuntime>()
  private launcher?: SessionLauncher

  constructor(private opts: DaemonOpts) {}

  private get publicUrl(): string {
    return this.opts.publicUrl ?? this.opts.baseUrl ?? "http://localhost:5330"
  }

  async start(): Promise<void> {
    if (!hasNodeType("end")) registerBuiltins()
    const baseUrl = this.opts.baseUrl ?? "http://localhost:5330"
    this.launcher = this.opts.launcher ? loggingLauncher(this.opts.launcher) : undefined
    if (!hasNodeType("agent")) {
      const launcher: SessionLauncher = this.launcher ?? {
        spawnSession: async () => { throw new Error("no session launcher configured (agent nodes need one)") },
        stopSession: async () => {},
      }
      registerNodeType(makeAgentNode(launcher, (m) => `${baseUrl}/api/charts/${m.chart}/marbles/${m.id}/signal`))
    }
    for (const path of this.opts.charts) {
      const chart = parseChart(await readFile(path, "utf8"))
      const store = new MarbleStore(join(this.opts.storeDir, chart.name))
      await store.init()
      const view = new ViewState(chart)
      const engine = new Engine({
        chart,
        store,
        concurrency: this.opts.concurrency,
        onChange: (m) => view.apply(m),
        onEvent: (e) => logLine(chart.name, fmtEvent(e)),
      })
      view.seed(await store.all())
      await engine.resume()
      this.runtimes.set(chart.name, {
        chart, engine, store, view, layout: layoutChart(chart), start: findStart(chart),
      })
      this.ensureWidgetLoop(chart)
    }
  }

  // Keep one Tinstar browser-widget per chart pointing at our UI. Tolerates
  // Tinstar being down: logs and retries on a timer, never crashes the daemon.
  private ensureWidgetLoop(chart: Chart, retryMs = 15_000): void {
    const url = `${this.publicUrl}/ui/charts/${chart.name}`
    const attempt = (): void => {
      this.opts.client.ensureBrowserWidget({ url, title: `whoachart-${chart.name}` }).then(
        () => logLine(chart.name, `widget ensured url=${url}`),
        (err) => {
          logLine(chart.name, `widget ensure failed (${String(err).split("\n")[0]}); retrying in ${retryMs / 1000}s`)
          const t = setTimeout(attempt, retryMs)
          ;(t as unknown as { unref?: () => void }).unref?.()
        },
      )
    }
    attempt()
  }

  charts(): string[] {
    return [...this.runtimes.keys()]
  }

  private rt(name: string): ChartRuntime {
    const rt = this.runtimes.get(name)
    if (!rt) throw new Error(`unknown chart: ${name}`)
    return rt
  }

  private nodeById(rt: ChartRuntime, id: string): ChartNode | undefined {
    return rt.chart.nodes.find((n) => n.id === id)
  }

  def(name: string): ChartDef {
    const rt = this.rt(name)
    const boxes: Record<string, NodeBox> = {}
    for (const [id, b] of rt.layout.boxes) boxes[id] = b
    return {
      name: rt.chart.name,
      start: rt.start,
      nodes: rt.chart.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        color: n.color,
        present: n.present,
        stuck_after: n.stuck_after,
        form: n.type === "source" ? ((n.config as Record<string, unknown>).form as FormField[] | undefined) : undefined,
      })),
      edges: rt.chart.edges.map((e) => ({ from: e.from, to: e.to, name: e.name, default: e.default, form: e.form })),
      layout: { boxes, width: rt.layout.width, height: rt.layout.height },
    }
  }

  async submit(name: string, opts: SubmitOpts = {}): Promise<Marble> {
    const rt = this.rt(name)
    const startId = opts.start ?? rt.start
    const startNode = this.nodeById(rt, startId)
    let context = opts.context ?? {}
    const form = startNode?.type === "source"
      ? ((startNode.config as Record<string, unknown>).form as FormField[] | undefined)
      : undefined
    if (form) context = validateForm(form, context) // throws FormError → API 400
    const m = newMarble(name, startId, context, opts.workpiece)
    logLine(name, `marble submitted id=${m.id} start=${m.node}`)
    await rt.engine.submit(m)
    return m
  }

  async marbles(name: string): Promise<Marble[]> {
    return this.rt(name).store.all()
  }

  async marble(name: string, id: string): Promise<Marble | null> {
    return this.rt(name).store.load(id)
  }

  async retry(name: string, id: string): Promise<void> {
    logLine(name, `retry requested marble=${id}`)
    await this.rt(name).engine.retry(id)
  }

  async focusSession(name: string, id: string): Promise<"ok" | "no-session" | "unreachable"> {
    const m = await this.rt(name).store.load(id)
    const session = m?.context._session
    if (typeof session !== "string" || !session) return "no-session"
    const ok = await this.opts.client.panToSession(session)
    return ok ? "ok" : "unreachable"
  }

  // Resume a blocked marble (agent done / human decision). Validates the
  // chosen edge's form against the merge payload, then stops the marble's
  // agent session unless the node opts into keep_session.
  async signal(name: string, id: string, sig: { next?: string; merge?: Record<string, unknown> } = {}): Promise<void> {
    const rt = this.rt(name)
    logLine(name, `signal received marble=${id} next=${sig.next ?? "-"}`)
    const before = await rt.store.load(id)
    if (before && before.status === "blocked") {
      const edges = rt.chart.edges.filter((e) => e.from === before.node)
      const edge = sig.next
        ? edges.find((e) => e.name === sig.next) ?? edges.find((e) => e.to === sig.next)
        : edges.length === 1 ? edges[0] : edges.find((e) => e.default)
      if (edge?.form) sig = { ...sig, merge: validateForm(edge.form, sig.merge ?? {}) } // throws FormError → API 400
    }
    await rt.engine.signal(id, sig)
    const session = before?.context._session
    if (typeof session === "string" && session && this.launcher) {
      const node = this.nodeById(rt, before!.node)
      if (node?.type === "agent" && (node.config as Record<string, unknown>).keep_session !== true) {
        void this.launcher.stopSession(session)
      }
    }
  }

  // Bounded live view aggregate for the UI to poll. O(1) — no store scans.
  snapshot(name: string): ViewSnapshot {
    return this.rt(name).view.snapshot()
  }
}
```

Delete the bridge and its tests:

```bash
git rm src/view/bridge.ts tests/bridge.test.ts
```

Update `src/main.ts` — `main()` becomes:

```ts
async function main(): Promise<void> {
  const chartsSpec = process.env.WHOACHART_CHARTS ?? "examples"
  const storeDir = process.env.WHOACHART_STORE ?? join(process.cwd(), ".whoachart")
  const port = process.env.WHOACHART_PORT ? Number(process.env.WHOACHART_PORT) : DEFAULT_PORT
  const tinstarUrl = process.env.TINSTAR_URL ?? "http://localhost:5273"
  // The URL browsers use to reach this daemon. On a tailnet box set e.g.
  // WHOACHART_PUBLIC_URL=http://infrapoc.taile890bc.ts.net:5331 — Bun.serve
  // binds 0.0.0.0 by default, so no port forwarding is needed.
  const publicUrl = process.env.WHOACHART_PUBLIC_URL ?? `http://localhost:${port}`

  const charts = await resolveCharts(chartsSpec)
  const client = new TinstarClient(tinstarUrl)
  const daemon = new Daemon({
    charts,
    storeDir,
    client,
    launcher: client,
    baseUrl: `http://localhost:${port}`,
    publicUrl,
  })
  await daemon.start()
  createControlApi(daemon, port)
  console.log(`[whoachart] daemon up on :${port} — charts: ${daemon.charts().join(", ") || "(none)"}`)
  for (const name of daemon.charts()) console.log(`[whoachart]   ui: ${publicUrl}/ui/charts/${name}`)
}
```

Update the five existing test files that construct daemons — in each, delete the local `class FakeSink ...` (and local `FakeLauncher` where present) and replace with the shared import, passing `client: new FakeCanvas()`:

- `tests/daemon.test.ts`: add `import { FakeCanvas } from "./fakes"`; remove the `FakeSink` class and its `ArtifactSink` imports; replace `client: new FakeSink()` → `client: new FakeCanvas()` (3 occurrences).
- `tests/controlApi.test.ts`: same replacement (1 construction in `beforeEach`).
- `tests/daemonAgent.test.ts`: import `{ FakeCanvas, FakeLauncher }` from `./fakes`; delete both local fake classes; `client: new FakeCanvas()`.
- `tests/controlApiSignal.test.ts`: same as daemonAgent.
- `tests/e2eAgent.test.ts`: import `{ FakeCanvas }` from `./fakes`; delete local `FakeSink`; keep its local `AutoAgent` launcher class as-is; `client: new FakeCanvas()`.

- [ ] **Step 5: Verify**

Run: `bun test` → ALL green (the rewritten files plus the rest). `bunx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "feat: daemon control core — validations, retry, def, focus-session, widget ensure, publicUrl"
```

---

## Task 6: Control API routes + UI shell (v0 client)

**Files:**
- Create: `src/ui/page.ts`, `src/ui/static.ts`, `src/ui/public/app.js`
- Modify: `src/controlApi.ts`
- Delete: `src/view/render.ts`, `tests/render.test.ts`
- Test: `tests/uiRoutes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/uiRoutes.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"

const CHART = `
name: gatey
nodes:
  - id: ingest
    type: source
    config:
      trigger: api
      form:
        - { key: title, type: text, required: true }
  - id: gate
    type: human
    config: {}
  - id: ok
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: gate }
  - { from: gate, to: ok, name: approve }
`

let server: ReturnType<typeof Bun.serve>
let base: string
let daemon: Daemon

beforeEach(async () => {
  clearRegistry()
  const dir = await mkdtemp(join(tmpdir(), "wc-ui-"))
  await writeFile(join(dir, "gatey.yaml"), CHART)
  daemon = new Daemon({
    charts: [join(dir, "gatey.yaml")], storeDir: join(dir, "store"),
    client: new FakeCanvas(), launcher: new FakeLauncher(),
  })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("GET /ui/charts/:name serves the shell html", async () => {
  const res = await fetch(`${base}/ui/charts/gatey`)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/html")
  const html = await res.text()
  expect(html).toContain("gatey")
  expect(html).toContain("/ui/app.js")
})

test("GET /ui/charts/unknown is 404", async () => {
  expect((await fetch(`${base}/ui/charts/nope`)).status).toBe(404)
})

test("GET /ui/app.js serves javascript; traversal is blocked", async () => {
  const res = await fetch(`${base}/ui/app.js`)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("javascript")
  expect((await fetch(`${base}/ui/..%2F..%2Fpackage.json`)).status).toBe(404)
})

test("GET def returns topology; state includes stats and deadLetter keys", async () => {
  const def = (await (await fetch(`${base}/api/charts/gatey/def`)).json()) as any
  expect(def.nodes.map((n: any) => n.id)).toContain("gate")
  const state = (await (await fetch(`${base}/api/charts/gatey/state`)).json()) as any
  expect(state).toHaveProperty("stats")
  expect(state).toHaveProperty("deadLetter")
})

test("submit validation failures return 400 with field messages", async () => {
  const res = await fetch(`${base}/api/charts/gatey/marbles`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: {} }),
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as any
  expect(body.error).toBe("validation")
  expect(body.fields.title).toBe("required")
})

test("retry route 400s for non-failed; focus-session 404s without a session", async () => {
  const sub = await fetch(`${base}/api/charts/gatey/marbles`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: { title: "x" } }),
  })
  const { id } = (await sub.json()) as any
  await new Promise((r) => setTimeout(r, 200))
  expect((await fetch(`${base}/api/charts/gatey/marbles/${id}/retry`, { method: "POST" })).status).toBe(400)
  expect((await fetch(`${base}/api/charts/gatey/marbles/${id}/focus-session`, { method: "POST" })).status).toBe(404)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/uiRoutes.test.ts` — Expected: FAIL (routes missing).

- [ ] **Step 3: Implement**

```ts
// src/ui/page.ts
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Minimal stable shell. The client (/ui/app.js) draws everything from
// /def + /state. Plan B replaces app.js with the full control surface.
export function renderPage(chartName: string): string {
  return `<!DOCTYPE html>
<html class="dark"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>whoachart — ${esc(chartName)}</title>
<style>
:root{--bg:#0a0e14;--ink:#c9d6e3;--dim:#5d6b7a;--cyan:#00f0ff;--line:#1c2531}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif}
.bar{padding:8px 14px;border-bottom:1px solid var(--line);font-size:13px;color:var(--cyan);font-weight:600}
#app{height:calc(100% - 37px);overflow:auto;padding:12px;font:11px/1.6 monospace;color:#7fd7c4;white-space:pre}
</style></head>
<body>
<div class="bar">whoachart ▸ ${esc(chartName)}</div>
<main id="app">loading…</main>
<script>globalThis.WHOACHART = { chart: ${JSON.stringify(chartName)} }</script>
<script type="module" src="/ui/app.js"></script>
</body></html>`
}
```

```ts
// src/ui/static.ts
import { join } from "node:path"

const PUBLIC_DIR = join(import.meta.dir, "public")

// Serve /ui/<file>.js from src/ui/public — basename only, no traversal.
export async function serveStatic(filename: string): Promise<Response | null> {
  if (!/^[a-z0-9._-]+\.js$/i.test(filename)) return null
  const f = Bun.file(join(PUBLIC_DIR, filename))
  if (!(await f.exists())) return null
  return new Response(f, { headers: { "Content-Type": "application/javascript; charset=utf-8" } })
}
```

```js
// src/ui/public/app.js
// v0 client: proves the def/state pipeline end-to-end by rendering live JSON.
// Plan B replaces this file with the full control surface.
const chart = globalThis.WHOACHART.chart
const app = document.getElementById("app")

async function refresh() {
  try {
    const [def, state] = await Promise.all([
      fetch(`/api/charts/${chart}/def`).then((r) => r.json()),
      fetch(`/api/charts/${chart}/state`, { cache: "no-store" }).then((r) => r.json()),
    ])
    app.textContent = JSON.stringify({ def: { nodes: def.nodes.length, edges: def.edges.length }, state }, null, 2)
  } catch (err) {
    app.textContent = `unreachable: ${err}`
  }
}
setInterval(refresh, 1000)
refresh()
```

In `src/controlApi.ts`:

(a) Add imports:

```ts
import { FormError } from "./forms"
import { renderPage } from "./ui/page"
import { serveStatic } from "./ui/static"
```

(b) Inside `fetch`, right after the OPTIONS branch, add the UI routes:

```ts
        // UI shell + static client
        if (req.method === "GET" && p[0] === "ui" && p[1] === "charts" && p[2] && !p[3]) {
          if (!daemon.charts().includes(p[2])) return new Response("unknown chart", { status: 404 })
          return new Response(renderPage(p[2]), { headers: { "Content-Type": "text/html; charset=utf-8" } })
        }
        if (req.method === "GET" && p[0] === "ui" && p[1] && !p[2]) {
          const file = await serveStatic(p[1])
          return file ?? json({ error: "not found" }, 404)
        }
```

(c) Inside the `p[3] === ...` chart routes, add a `def` branch above the `state` branch:

```ts
        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "def" && req.method === "GET") {
          return json(daemon.def(p[2]))
        }
```

(d) Inside the marbles block, next to the signal branch, add:

```ts
          // POST single-marble retry
          if (req.method === "POST" && p[4] && p[5] === "retry") {
            await daemon.retry(name, p[4])
            return json({ ok: true })
          }
          // POST focus the Tinstar canvas on the marble's agent session
          if (req.method === "POST" && p[4] && p[5] === "focus-session") {
            const result = await daemon.focusSession(name, p[4])
            if (result === "ok") return json({ ok: true })
            if (result === "no-session") return json({ error: "marble has no linked session" }, 404)
            return json({ error: "tinstar unreachable" }, 502)
          }
```

(e) In the catch block, handle FormError before the generic 400:

```ts
      } catch (err) {
        if (err instanceof FormError) return json({ error: "validation", fields: err.fields }, 400)
        return json({ error: String(err) }, 400)
      }
```

(f) Update the route comment block to list the new routes.

Delete the old server-rendered view:

```bash
git rm src/view/render.ts tests/render.test.ts
```

- [ ] **Step 4: Verify**

Run: `bun test tests/uiRoutes.test.ts` → 6 pass. `bun test` → ALL green. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "feat: UI shell + def/retry/focus-session routes, v0 JSON client"
```

---

## Task 7: Gate-demo example + e2e

**Files:**
- Create: `examples/gate-demo.yaml`
- Test: `tests/e2eGate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/e2eGate.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"

let server: ReturnType<typeof Bun.serve>
let base: string
let daemon: Daemon

beforeEach(async () => {
  clearRegistry()
  daemon = new Daemon({
    charts: ["examples/gate-demo.yaml"],
    storeDir: join(tmpdir(), "wc-e2eg-" + crypto.randomUUID().slice(0, 8)),
    client: new FakeCanvas(),
    launcher: new FakeLauncher(),
  })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
}

test("full human-gate flow: validated intake, gate info, validated decline, approve", async () => {
  // 1. intake form enforced
  expect((await post("/api/charts/gate-demo/marbles", { context: {} })).status).toBe(400)

  // 2. valid submission flows to the gate and blocks with gate info
  const sub = await post("/api/charts/gate-demo/marbles", { context: { title: "first", priority: "high" } })
  expect(sub.status).toBe(201)
  const { id } = (await sub.json()) as any
  await new Promise((r) => setTimeout(r, 250))
  const state = (await (await fetch(`${base}/api/charts/gate-demo/state`)).json()) as any
  const lm = state.live.find((m: any) => m.id === id)
  expect(lm.status).toBe("blocked")
  expect(lm.gate.agent).toBe(false)
  expect(lm.gate.edges.map((e: any) => e.name).sort()).toEqual(["approve", "decline"])
  expect(lm.gate.present[0].key).toBe("title")

  // 3. declining without the required reason is rejected — same rule for agents
  const bad = await post(`/api/charts/gate-demo/marbles/${id}/signal`, { next: "decline", merge: {} })
  expect(bad.status).toBe(400)
  expect(((await bad.json()) as any).fields.reason).toBe("required")

  // 4. declining with a reason lands at the declined end with reason merged
  await post(`/api/charts/gate-demo/marbles/${id}/signal`, { next: "decline", merge: { reason: "not ready" } })
  await new Promise((r) => setTimeout(r, 250))
  const m1 = (await (await fetch(`${base}/api/charts/gate-demo/marbles/${id}`)).json()) as any
  expect(m1.node).toBe("declined")
  expect(m1.context.reason).toBe("not ready")
  expect(m1.trail.map((h: any) => h.node)).toEqual(["ingest", "prep", "approve", "declined"])

  // 5. a second marble approved goes to shipped
  const sub2 = await post("/api/charts/gate-demo/marbles", { context: { title: "second" } })
  const { id: id2 } = (await sub2.json()) as any
  await new Promise((r) => setTimeout(r, 250))
  await post(`/api/charts/gate-demo/marbles/${id2}/signal`, { next: "approve" })
  await new Promise((r) => setTimeout(r, 250))
  const m2 = (await (await fetch(`${base}/api/charts/gate-demo/marbles/${id2}`)).json()) as any
  expect(m2.node).toBe("shipped")
  expect(m2.context.priority).toBe("med") // form default applied
})

test("dead letter + retry round-trip via the API", async () => {
  const sub = await post("/api/charts/gate-demo/marbles", { context: { title: "boomer" }, start: "breaker" })
  const { id } = (await sub.json()) as any
  await new Promise((r) => setTimeout(r, 250))
  let state = (await (await fetch(`${base}/api/charts/gate-demo/state`)).json()) as any
  expect(state.deadLetter.map((d: any) => d.id)).toContain(id)

  const res = await fetch(`${base}/api/charts/gate-demo/marbles/${id}/retry`, { method: "POST" })
  expect(res.status).toBe(200)
  await new Promise((r) => setTimeout(r, 250))
  state = (await (await fetch(`${base}/api/charts/gate-demo/state`)).json()) as any
  // breaker always fails: it lands back in the tray, but only once (same id)
  expect(state.deadLetter.filter((d: any) => d.id === id)).toHaveLength(1)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/e2eGate.test.ts` — Expected: FAIL (`examples/gate-demo.yaml` missing).

- [ ] **Step 3: Write the example chart**

```yaml
# examples/gate-demo.yaml
# Human-in-the-loop demo: typed intake form, a human gate with presentation
# and a decline form, and a deliberately broken node for retry demos.
name: gate-demo
nodes:
  - id: ingest
    type: source
    name: New request
    config:
      trigger: api
      form:
        - { key: title, type: text, required: true }
        - { key: priority, type: enum, options: [low, med, high], default: med }
        - { key: rush, type: boolean, default: false }
        - { key: notes, type: textarea }

  - id: prep
    type: shell
    name: Prep
    config:
      on_enter: |
        echo '{"merge":{"prepped":true}}'

  - id: approve
    type: human
    name: Approve?
    stuck_after: 120
    present:
      - { key: title, as: text }
      - { key: priority, as: text }
      - { key: notes, as: markdown }
    config: {}

  - id: breaker
    type: shell
    name: Breaker
    config:
      on_enter: |
        echo "this node always fails" >&2
        exit 7

  - id: shipped
    type: end
    name: Shipped
    config:
      outcome: success

  - id: declined
    type: end
    name: Declined
    config:
      outcome: fail

edges:
  - { from: ingest, to: prep }
  - { from: prep, to: approve }
  - { from: approve, to: shipped, name: approve }
  - { from: approve, to: declined, name: decline,
      form: [ { key: reason, type: textarea, required: true } ] }
  - { from: breaker, to: shipped }
```

- [ ] **Step 4: Verify**

Run: `bun test tests/e2eGate.test.ts` → 2 pass. Full `bun test` → ALL green. `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add examples/gate-demo.yaml tests/e2eGate.test.ts
git commit -m "feat: gate-demo example and human-gate e2e (forms, decline, retry)"
```

---

## Manual smoke (optional, after Task 7)

```bash
WHOACHART_CHARTS=examples/gate-demo.yaml WHOACHART_STORE=/tmp/wc-gate \
WHOACHART_PORT=5331 WHOACHART_PUBLIC_URL=http://localhost:5331 bun run src/main.ts &
# the daemon ensures a Tinstar widget at http://localhost:5331/ui/charts/gate-demo (v0 JSON view)
curl -s -X POST localhost:5331/api/charts/gate-demo/marbles \
  -H 'Content-Type: application/json' -d '{"context":{"title":"smoke"}}'
# watch the JSON state update live; signal via:
#   curl -X POST localhost:5331/api/charts/gate-demo/marbles/<id>/signal \
#     -H 'Content-Type: application/json' -d '{"next":"approve"}'
```

---

## Self-Review

**Spec coverage (spec §2–§7, §9–§11):** shell/publicUrl/widget-ensure → Tasks 5–6 (§2); trail + retry → Task 1 (§3); ViewState gate/stats/deadLetter → Task 3 (§4); form schema + server-side enforcement incl. agent signals → Tasks 2, 5 (§5); gate info for drawer-only UX → Task 3 (the rendering itself is Plan B, §6); API surface def/state/retry/focus-session/validated submit+signal + `/ui` routes → Tasks 5–6 (§7); error handling (FormError 400 w/ fields, retry 400, focus 404/502, widget-ensure tolerant) → Tasks 5–6 (§9); human gate node added (Task 2 — the spec implied blocked-at-gate marbles but had no non-agent blocker; `human` fills it); examples → Task 7 (§11). Client behaviors (§8) are **Plan B** by design.

**Placeholder scan:** none — `app.js` v0 is working software (live JSON view), not a stub; all code complete.

**Type consistency:** `TrailHop`/`FormField`/`PresentSpec` (Task 1) used by forms (2), viewState (3), daemon def (5). `validateForm`/`FormError` (2) used in daemon (5) and controlApi catch (6). `CanvasControl`/`EnsureWidgetOpts` (4) consumed by daemon (5) and `tests/fakes.ts` (5). `ViewState(chart, recentN?)` (3) constructed in daemon (5). `ChartDef`/`focusSession` return union (5) consumed by routes (6). `renderPage`/`serveStatic` (6) used in controlApi (6).
