# whoachart Core Engine (headless) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless whoachart engine — load a chart, run many marbles through it concurrently with persistence, retry, cycle-guarding, and node-centric routing — with no Tinstar dependency.

**Architecture:** A chart is a YAML graph of typed nodes + dumb edges. Each node type is a module in a registry implementing `run(ctx) -> NodeResult`. The engine schedules many independent marbles (one cursor each) over a chart, one node-step per scheduler slot (global concurrency cap), persisting every marble as a JSON file so they survive restarts. Routing is node-centric: a node's behavior names the next edge; edges only carry identity + an `on_traversal` side-effect.

**Tech Stack:** TypeScript on Bun 1.3 (`bun test` for tests, `Bun.spawn` for shell, built-in `fetch`), `zod` for config schemas, `yaml` for chart parsing.

This is **Plan 1 of 2**. Plan 2 ("Tinstar integration") adds the live canvas view, the `agent` node type, the control API, and the CLI. This plan deliberately ships only the headless engine — it is fully runnable and testable on its own.

**Spec:** `docs/superpowers/specs/2026-06-08-whoachart-tinstar-overhaul-design.md` (MVP scope in §11).

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json` | Project scaffold, deps, scripts. |
| `src/types.ts` | Core domain types: `Chart`, `ChartNode`, `ChartEdge`, `Marble`, `NodeResult`, `RunCtx`. |
| `src/util.ts` | `now()`, `genId()` helpers (isolated so the rest stays pure). |
| `src/registry.ts` | Node-type registry: `registerNodeType`, `getNodeType`, `hasNodeType`, `clearRegistry`. |
| `src/schema.ts` | `parseChart(yaml)` — zod validation + referential integrity + per-type config validation. |
| `src/store.ts` | `MarbleStore` — atomic JSON-file persistence + load-all on boot. |
| `src/context.ts` | Activity contract: `buildEnv`, `runShell`, `parseEmit`. |
| `src/nodeTypes/end.ts` `source.ts` `shell.ts` `decision.ts` `api.ts` | Built-in node-type modules. |
| `src/nodeTypes/index.ts` | `registerBuiltins()` — registers all built-in types. |
| `src/engine.ts` | `Engine` (scheduler, retry, cycle guard, edge resolution, resume) + `newMarble`. |
| `src/run.ts` | `runChartFile(path)` headless convenience entry. |
| `examples/build-pipeline.yaml` | Worked headless example (shell-only). |
| `tests/*.test.ts` | One test file per module + an e2e test. |

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Modify: `.gitignore`
- Test: `tests/scaffold.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/scaffold.test.ts
import { test, expect } from "bun:test"

test("toolchain runs typescript", () => {
  const sum = (a: number, b: number): number => a + b
  expect(sum(2, 3)).toBe(5)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scaffold.test.ts`
Expected: FAIL — "Cannot find module" / no package.json (bun has nothing to resolve yet).

- [ ] **Step 3: Create the scaffold**

```json
// package.json
{
  "name": "whoachart",
  "version": "0.1.0",
  "type": "module",
  "module": "src/run.ts",
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "yaml": "^2.5.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "bun-types": "^1.3.0"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "module": "ESNext",
    "target": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true
  },
  "include": ["src", "tests"]
}
```

Append to `.gitignore`:

```
node_modules/
.whoachart/
*.tmp
```

- [ ] **Step 4: Install and run tests**

Run: `bun install && bun test tests/scaffold.test.ts`
Expected: PASS (1 pass).

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json bun.lockb .gitignore tests/scaffold.test.ts
git commit -m "chore: scaffold bun/typescript project"
```

---

## Task 2: Core types + utils

**Files:**
- Create: `src/types.ts`
- Create: `src/util.ts`
- Test: `tests/util.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/util.test.ts
import { test, expect } from "bun:test"
import { genId, now } from "../src/util"

test("genId returns unique non-empty ids", () => {
  const a = genId(), b = genId()
  expect(a).toBeTruthy()
  expect(a).not.toBe(b)
})

test("now returns an ISO timestamp", () => {
  expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/util.test.ts`
Expected: FAIL — cannot find `../src/util`.

- [ ] **Step 3: Write the implementation**

```ts
// src/util.ts
export function genId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function now(): string {
  return new Date().toISOString()
}
```

```ts
// src/types.ts
export type NodeKind = string

export interface ChartNode {
  id: string
  type: NodeKind
  name?: string
  color?: string
  on_leave?: string
  retry?: { max: number }
  timeout?: number // milliseconds
  position?: { x: number; y: number }
  config: Record<string, unknown>
}

export interface ChartEdge {
  from: string
  to: string
  name?: string
  on_traversal?: string
  default?: boolean
}

export interface Chart {
  name: string
  nodes: ChartNode[]
  edges: ChartEdge[]
}

export type MarbleStatus = "queued" | "running" | "blocked" | "done" | "failed"

export interface Marble {
  id: string
  chart: string
  node: string
  context: Record<string, unknown>
  workpiece?: string
  history: string[]
  status: MarbleStatus
  error?: string
  createdAt: string
  updatedAt: string
}

export interface NodeResult {
  next?: string // edge name (or target node id) to take
  merge?: Record<string, unknown> // merged into marble.context
  end?: boolean
  endOutcome?: "success" | "fail" | "warning"
  block?: boolean // wait for an external event
  failed?: boolean // activity reported failure (engine resolves routing)
}

export interface RunCtx {
  chart: Chart
  marble: Marble
  node: ChartNode
  outgoing: ChartEdge[]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/util.test.ts`
Expected: PASS (2 pass).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/util.ts tests/util.test.ts
git commit -m "feat: core domain types and id/time utils"
```

---

## Task 3: Node-type registry

**Files:**
- Create: `src/registry.ts`
- Test: `tests/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/registry.test.ts
import { test, expect, beforeEach } from "bun:test"
import { z } from "zod"
import { registerNodeType, getNodeType, hasNodeType, clearRegistry } from "../src/registry"

const dummy = {
  type: "dummy",
  configSchema: z.object({}).passthrough(),
  run: async () => ({}),
}

beforeEach(() => clearRegistry())

test("register then get a node type", () => {
  registerNodeType(dummy)
  expect(hasNodeType("dummy")).toBe(true)
  expect(getNodeType("dummy").type).toBe("dummy")
})

test("getting an unknown type throws", () => {
  expect(() => getNodeType("nope")).toThrow(/unknown node type/)
})

test("double registration throws", () => {
  registerNodeType(dummy)
  expect(() => registerNodeType(dummy)).toThrow(/already registered/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/registry.test.ts`
Expected: FAIL — cannot find `../src/registry`.

- [ ] **Step 3: Write the implementation**

```ts
// src/registry.ts
import type { ZodTypeAny } from "zod"
import type { RunCtx, NodeResult } from "./types"

export interface NodeType {
  type: string
  configSchema: ZodTypeAny
  run(ctx: RunCtx): Promise<NodeResult>
}

const registry = new Map<string, NodeType>()

export function registerNodeType(nt: NodeType): void {
  if (registry.has(nt.type)) {
    throw new Error(`node type already registered: ${nt.type}`)
  }
  registry.set(nt.type, nt)
}

export function getNodeType(type: string): NodeType {
  const nt = registry.get(type)
  if (!nt) throw new Error(`unknown node type: ${type}`)
  return nt
}

export function hasNodeType(type: string): boolean {
  return registry.has(type)
}

export function clearRegistry(): void {
  registry.clear()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/registry.test.ts`
Expected: PASS (3 pass).

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts tests/registry.test.ts
git commit -m "feat: node-type registry"
```

---

## Task 4: Chart schema + loader

**Files:**
- Create: `src/schema.ts`
- Test: `tests/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/schema.test.ts
import { test, expect, beforeEach } from "bun:test"
import { z } from "zod"
import { parseChart } from "../src/schema"
import { registerNodeType, clearRegistry } from "../src/registry"

beforeEach(() => {
  clearRegistry()
  registerNodeType({ type: "shell", configSchema: z.object({ on_enter: z.string() }), run: async () => ({}) })
  registerNodeType({ type: "end", configSchema: z.object({ outcome: z.string() }), run: async () => ({}) })
})

const good = `
name: tiny
nodes:
  - id: a
    type: shell
    config: { on_enter: "echo hi" }
  - id: b
    type: end
    config: { outcome: success }
edges:
  - { from: a, to: b, name: done }
`

test("parses a valid chart", () => {
  const chart = parseChart(good)
  expect(chart.name).toBe("tiny")
  expect(chart.nodes).toHaveLength(2)
  expect(chart.edges[0].name).toBe("done")
})

test("rejects edge referencing unknown node", () => {
  const bad = good.replace("to: b", "to: ghost")
  expect(() => parseChart(bad)).toThrow(/unknown node/)
})

test("rejects duplicate node ids", () => {
  const bad = good.replace("id: b", "id: a")
  expect(() => parseChart(bad)).toThrow(/duplicate node id/)
})

test("rejects unknown node type", () => {
  const bad = good.replace("type: shell", "type: wat")
  expect(() => parseChart(bad)).toThrow(/unknown node type/)
})

test("rejects invalid per-type config", () => {
  const bad = good.replace('config: { on_enter: "echo hi" }', "config: {}")
  expect(() => parseChart(bad)).toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/schema.test.ts`
Expected: FAIL — cannot find `../src/schema`.

- [ ] **Step 3: Write the implementation**

```ts
// src/schema.ts
import { z } from "zod"
import { parse as parseYaml } from "yaml"
import type { Chart } from "./types"
import { getNodeType } from "./registry"

const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  name: z.string().optional(),
  on_traversal: z.string().optional(),
  default: z.boolean().optional(),
})

const nodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().optional(),
  color: z.string().optional(),
  on_leave: z.string().optional(),
  retry: z.object({ max: z.number().int().nonnegative() }).optional(),
  timeout: z.number().int().positive().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  config: z.record(z.unknown()).default({}),
})

const chartSchema = z.object({
  name: z.string(),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema).default([]),
})

export function parseChart(yamlText: string): Chart {
  const raw = parseYaml(yamlText)
  const chart = chartSchema.parse(raw)

  const ids = new Set<string>()
  for (const n of chart.nodes) {
    if (ids.has(n.id)) throw new Error(`duplicate node id: ${n.id}`)
    ids.add(n.id)
  }
  for (const e of chart.edges) {
    if (!ids.has(e.from)) throw new Error(`edge references unknown node (from): ${e.from}`)
    if (!ids.has(e.to)) throw new Error(`edge references unknown node (to): ${e.to}`)
  }
  // validate + normalize each node's typed config block
  for (const n of chart.nodes) {
    const nt = getNodeType(n.type) // throws "unknown node type" if missing
    n.config = nt.configSchema.parse(n.config ?? {})
  }
  return chart as Chart
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/schema.test.ts`
Expected: PASS (5 pass).

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts tests/schema.test.ts
git commit -m "feat: chart YAML loader with zod + referential validation"
```

---

## Task 5: Marble store (JSON persistence)

**Files:**
- Create: `src/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/store.test.ts
import { test, expect } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MarbleStore } from "../src/store"
import type { Marble } from "../src/types"

function tmpDir() {
  return join(tmpdir(), "whoachart-store-" + crypto.randomUUID().slice(0, 8))
}

function marble(id: string): Marble {
  return {
    id, chart: "c", node: "a", context: { k: 1 }, history: ["a"],
    status: "queued", createdAt: "t", updatedAt: "t",
  }
}

test("save then load round-trips", async () => {
  const store = new MarbleStore(tmpDir())
  await store.init()
  await store.save(marble("m1"))
  const loaded = await store.load("m1")
  expect(loaded?.context.k).toBe(1)
})

test("load returns null for missing marble", async () => {
  const store = new MarbleStore(tmpDir())
  await store.init()
  expect(await store.load("nope")).toBeNull()
})

test("all returns every saved marble", async () => {
  const store = new MarbleStore(tmpDir())
  await store.init()
  await store.save(marble("m1"))
  await store.save(marble("m2"))
  const all = await store.all()
  expect(all.map((m) => m.id).sort()).toEqual(["m1", "m2"])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/store.test.ts`
Expected: FAIL — cannot find `../src/store`.

- [ ] **Step 3: Write the implementation**

```ts
// src/store.ts
import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import type { Marble } from "./types"

export class MarbleStore {
  constructor(private dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  async save(m: Marble): Promise<void> {
    const tmp = this.path(m.id) + ".tmp"
    await writeFile(tmp, JSON.stringify(m, null, 2))
    await rename(tmp, this.path(m.id)) // atomic replace
  }

  async load(id: string): Promise<Marble | null> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as Marble
    } catch {
      return null
    }
  }

  async all(): Promise<Marble[]> {
    await this.init()
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"))
    const out: Marble[] = []
    for (const f of files) {
      try {
        out.push(JSON.parse(await readFile(join(this.dir, f), "utf8")) as Marble)
      } catch (err) {
        // A corrupt marble file must not silently vanish — surface it loudly.
        console.error(`[whoachart] skipping unreadable marble file ${f}: ${err}`)
      }
    }
    return out
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/store.test.ts`
Expected: PASS (3 pass).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "feat: JSON-file marble store with atomic writes"
```

---

## Task 6: Activity contract (shell runner + emit parsing)

**Files:**
- Create: `src/context.ts`
- Test: `tests/context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/context.test.ts
import { test, expect } from "bun:test"
import { parseEmit, runShell } from "../src/context"
import type { Marble, ChartNode } from "../src/types"

const node: ChartNode = { id: "a", type: "shell", config: {} }
function marble(): Marble {
  return { id: "m", chart: "c", node: "a", context: { from: "ctx" }, history: ["a"], status: "running", createdAt: "t", updatedAt: "t" }
}

test("parseEmit reads next + merge from trailing JSON line", () => {
  const out = parseEmit('some log\nmore log\n{"next":"ok","merge":{"x":2}}')
  expect(out.next).toBe("ok")
  expect(out.merge).toEqual({ x: 2 })
})

test("parseEmit ignores non-JSON output", () => {
  expect(parseEmit("just logs\nno json here")).toEqual({})
})

test("runShell captures exit code and parses emit", async () => {
  const out = await runShell(`echo hello; echo '{"next":"go"}'`, marble(), node)
  expect(out.exitCode).toBe(0)
  expect(out.next).toBe("go")
})

test("runShell reports nonzero exit", async () => {
  const out = await runShell(`exit 3`, marble(), node)
  expect(out.exitCode).toBe(3)
})

test("runShell exposes context + ids via env", async () => {
  const out = await runShell(`cat "$WHOACHART_CONTEXT"; echo " node=$WHOACHART_NODE"`, marble(), node)
  expect(out.stdout).toContain("ctx")
  expect(out.stdout).toContain("node=a")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/context.test.ts`
Expected: FAIL — cannot find `../src/context`.

- [ ] **Step 3: Write the implementation**

```ts
// src/context.ts
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Marble, ChartNode } from "./types"

export interface ActivityOutput {
  exitCode: number
  stdout: string
  stderr: string
  next?: string
  merge?: Record<string, unknown>
}

export function buildEnv(marble: Marble, node: ChartNode, contextPath: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    WHOACHART_MARBLE: marble.id,
    WHOACHART_NODE: node.id,
    WHOACHART_CONTEXT: contextPath,
    WHOACHART_WORKSPACE: marble.workpiece ?? "",
  }
}

export function parseEmit(stdout: string): { next?: string; merge?: Record<string, unknown> } {
  const lines = stdout.trimEnd().split("\n")
  const last = lines[lines.length - 1]?.trim()
  if (!last) return {}
  try {
    const obj = JSON.parse(last)
    if (obj && typeof obj === "object") {
      const next = typeof obj.next === "string" ? obj.next : undefined
      const merge = obj.merge && typeof obj.merge === "object" ? (obj.merge as Record<string, unknown>) : undefined
      return { next, merge }
    }
  } catch {
    // last line is not JSON — no emit, that's fine
  }
  return {}
}

export async function runShell(script: string, marble: Marble, node: ChartNode): Promise<ActivityOutput> {
  const ctxPath = join(tmpdir(), `whoachart-ctx-${marble.id}-${node.id}.json`)
  await writeFile(ctxPath, JSON.stringify(marble.context))

  const proc = Bun.spawn(["bash", "-c", script], {
    env: buildEnv(marble, node, ctxPath),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  const { next, merge } = parseEmit(stdout)
  return { exitCode, stdout, stderr, next, merge }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/context.test.ts`
Expected: PASS (5 pass).

- [ ] **Step 5: Commit**

```bash
git add src/context.ts tests/context.test.ts
git commit -m "feat: activity contract — shell runner and stdout emit parsing"
```

---

## Task 7: Built-in node types (end, source, shell, decision)

**Files:**
- Create: `src/nodeTypes/end.ts`
- Create: `src/nodeTypes/source.ts`
- Create: `src/nodeTypes/shell.ts`
- Create: `src/nodeTypes/decision.ts`
- Create: `src/nodeTypes/index.ts`
- Test: `tests/nodeTypes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/nodeTypes.test.ts
import { test, expect, beforeEach } from "bun:test"
import { registerBuiltins } from "../src/nodeTypes"
import { getNodeType, clearRegistry, hasNodeType } from "../src/registry"
import type { RunCtx, Marble, ChartNode } from "../src/types"

beforeEach(() => { clearRegistry(); registerBuiltins() })

function ctx(node: ChartNode): RunCtx {
  const marble: Marble = { id: "m", chart: "c", node: node.id, context: {}, history: [node.id], status: "running", createdAt: "t", updatedAt: "t" }
  return { chart: { name: "c", nodes: [node], edges: [] }, marble, node, outgoing: [] }
}

test("builtins are registered", () => {
  for (const t of ["end", "source", "shell", "decision"]) expect(hasNodeType(t)).toBe(true)
})

test("end node returns terminal result with outcome", async () => {
  const node: ChartNode = { id: "e", type: "end", config: { outcome: "success" } }
  const r = await getNodeType("end").run(ctx(node))
  expect(r.end).toBe(true)
  expect(r.endOutcome).toBe("success")
})

test("source node is a pass-through", async () => {
  const node: ChartNode = { id: "s", type: "source", config: { trigger: "api" } }
  const r = await getNodeType("source").run(ctx(node))
  expect(r.end).toBeUndefined()
  expect(r.next).toBeUndefined()
})

test("shell node runs script and surfaces next + failed", async () => {
  const ok: ChartNode = { id: "a", type: "shell", config: { on_enter: `echo '{"next":"go"}'` } }
  expect((await getNodeType("shell").run(ctx(ok))).next).toBe("go")
  const bad: ChartNode = { id: "b", type: "shell", config: { on_enter: `exit 1` } }
  expect((await getNodeType("shell").run(ctx(bad))).failed).toBe(true)
})

test("decision node runs routing script and emits next", async () => {
  const node: ChartNode = { id: "d", type: "decision", config: { on_enter: `echo '{"next":"left"}'` } }
  expect((await getNodeType("decision").run(ctx(node))).next).toBe("left")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/nodeTypes.test.ts`
Expected: FAIL — cannot find `../src/nodeTypes`.

- [ ] **Step 3: Write the implementations**

```ts
// src/nodeTypes/end.ts
import { z } from "zod"
import type { NodeType } from "../registry"

export const endNode: NodeType = {
  type: "end",
  configSchema: z.object({
    outcome: z.enum(["success", "fail", "warning"]).default("success"),
  }),
  async run(ctx) {
    const cfg = ctx.node.config as { outcome: "success" | "fail" | "warning" }
    return { end: true, endOutcome: cfg.outcome }
  },
}
```

```ts
// src/nodeTypes/source.ts
import { z } from "zod"
import type { NodeType } from "../registry"

// A source defines how marbles enter (the control API reads `trigger`).
// Inside the engine loop it is a pass-through: auto-advance to its successor.
export const sourceNode: NodeType = {
  type: "source",
  configSchema: z.object({
    trigger: z.enum(["api", "manual"]).default("api"),
    template: z.record(z.unknown()).optional(),
  }),
  async run() {
    return {}
  },
}
```

```ts
// src/nodeTypes/shell.ts
import { z } from "zod"
import type { NodeType } from "../registry"
import { runShell } from "../context"

export const shellNode: NodeType = {
  type: "shell",
  configSchema: z.object({ on_enter: z.string() }),
  async run(ctx) {
    const cfg = ctx.node.config as { on_enter: string }
    const out = await runShell(cfg.on_enter, ctx.marble, ctx.node)
    return { next: out.next, merge: out.merge, failed: out.exitCode !== 0 }
  },
}
```

```ts
// src/nodeTypes/decision.ts
import { z } from "zod"
import type { NodeType } from "../registry"
import { runShell } from "../context"

// A decision is pure routing: a script whose only job is to emit `next`.
// (Rendered as a diamond by the view layer in Plan 2.)
export const decisionNode: NodeType = {
  type: "decision",
  configSchema: z.object({ on_enter: z.string() }),
  async run(ctx) {
    const cfg = ctx.node.config as { on_enter: string }
    const out = await runShell(cfg.on_enter, ctx.marble, ctx.node)
    return { next: out.next, merge: out.merge, failed: out.exitCode !== 0 }
  },
}
```

```ts
// src/nodeTypes/index.ts
import { registerNodeType } from "../registry"
import { endNode } from "./end"
import { sourceNode } from "./source"
import { shellNode } from "./shell"
import { decisionNode } from "./decision"

export function registerBuiltins(): void {
  registerNodeType(sourceNode)
  registerNodeType(shellNode)
  registerNodeType(decisionNode)
  registerNodeType(endNode)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/nodeTypes.test.ts`
Expected: PASS (5 pass).

- [ ] **Step 5: Commit**

```bash
git add src/nodeTypes tests/nodeTypes.test.ts
git commit -m "feat: built-in node types — end, source, shell, decision"
```

---

## Task 8: `api` node type

**Files:**
- Create: `src/nodeTypes/api.ts`
- Modify: `src/nodeTypes/index.ts`
- Test: `tests/apiNode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/apiNode.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { registerBuiltins } from "../src/nodeTypes"
import { getNodeType, clearRegistry } from "../src/registry"
import type { RunCtx, Marble, ChartNode } from "../src/types"

let server: ReturnType<typeof Bun.serve>
let base: string

beforeEach(() => {
  clearRegistry(); registerBuiltins()
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/ok") return Response.json({ pong: true })
      return new Response("boom", { status: 500 })
    },
  })
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

function ctx(node: ChartNode): RunCtx {
  const marble: Marble = { id: "m", chart: "c", node: node.id, context: {}, history: [node.id], status: "running", createdAt: "t", updatedAt: "t" }
  return { chart: { name: "c", nodes: [node], edges: [] }, marble, node, outgoing: [] }
}

test("api node merges JSON response and marks success", async () => {
  const node: ChartNode = { id: "h", type: "api", config: { request: { method: "GET", url: `${base}/ok` } } }
  const r = await getNodeType("api").run(ctx(node))
  expect(r.failed).toBe(false)
  expect((r.merge as any).h_response.pong).toBe(true)
})

test("api node flags failed on non-2xx", async () => {
  const node: ChartNode = { id: "h", type: "api", config: { request: { method: "GET", url: `${base}/err` } } }
  const r = await getNodeType("api").run(ctx(node))
  expect(r.failed).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/apiNode.test.ts`
Expected: FAIL — cannot find `../src/nodeTypes/api` (import inside index will error).

- [ ] **Step 3: Write the implementation**

```ts
// src/nodeTypes/api.ts
import { z } from "zod"
import type { NodeType } from "../registry"

export const apiNode: NodeType = {
  type: "api",
  configSchema: z.object({
    request: z.object({
      method: z.string().default("GET"),
      url: z.string(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
    }),
    next_on_ok: z.string().optional(),
    next_on_error: z.string().optional(),
  }),
  async run(ctx) {
    const cfg = ctx.node.config as {
      request: { method: string; url: string; headers?: Record<string, string>; body?: string }
      next_on_ok?: string
      next_on_error?: string
    }
    const res = await fetch(cfg.request.url, {
      method: cfg.request.method,
      headers: cfg.request.headers,
      body: cfg.request.body,
    })
    const text = await res.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text }
    return {
      merge: { [`${ctx.node.id}_response`]: data, [`${ctx.node.id}_status`]: res.status },
      failed: !res.ok,
      next: res.ok ? cfg.next_on_ok : cfg.next_on_error,
    }
  },
}
```

Modify `src/nodeTypes/index.ts` to register it:

```ts
// src/nodeTypes/index.ts
import { registerNodeType } from "../registry"
import { endNode } from "./end"
import { sourceNode } from "./source"
import { shellNode } from "./shell"
import { decisionNode } from "./decision"
import { apiNode } from "./api"

export function registerBuiltins(): void {
  registerNodeType(sourceNode)
  registerNodeType(shellNode)
  registerNodeType(decisionNode)
  registerNodeType(apiNode)
  registerNodeType(endNode)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/apiNode.test.ts`
Expected: PASS (2 pass).

- [ ] **Step 5: Commit**

```bash
git add src/nodeTypes/api.ts src/nodeTypes/index.ts tests/apiNode.test.ts
git commit -m "feat: api node type"
```

---

## Task 9: Engine (scheduler, routing, retry, cycle guard, resume)

**Files:**
- Create: `src/engine.ts`
- Test: `tests/engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Engine, newMarble } from "../src/engine"
import { MarbleStore } from "../src/store"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry } from "../src/registry"
import type { Chart, Marble } from "../src/types"

beforeEach(() => { clearRegistry(); registerBuiltins() })

function store() { return new MarbleStore(join(tmpdir(), "wc-eng-" + crypto.randomUUID().slice(0, 8))) }

const linear: Chart = {
  name: "linear",
  nodes: [
    { id: "s", type: "source", config: { trigger: "api" } },
    { id: "work", type: "shell", config: { on_enter: `echo '{"merge":{"did":true}}'` } },
    { id: "done", type: "end", config: { outcome: "success" } },
  ],
  edges: [ { from: "s", to: "work" }, { from: "work", to: "done" } ],
}

test("a marble runs to a success end and persists context", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart: linear, store: st })
  const m = newMarble("linear", "s")
  await eng.submit(m)
  await eng.drain()
  const final = await st.load(m.id)
  expect(final?.status).toBe("done")
  expect(final?.context.did).toBe(true)
  expect(final?.context._outcome).toBe("success")
})

test("named-edge routing picks the right branch", async () => {
  const branch: Chart = {
    name: "branch",
    nodes: [
      { id: "d", type: "decision", config: { on_enter: `echo '{"next":"left"}'` } },
      { id: "L", type: "end", config: { outcome: "success" } },
      { id: "R", type: "end", config: { outcome: "fail" } },
    ],
    edges: [ { from: "d", to: "L", name: "left" }, { from: "d", to: "R", name: "right" } ],
  }
  const st = store(); await st.init()
  const eng = new Engine({ chart: branch, store: st })
  const m = newMarble("branch", "d")
  await eng.submit(m); await eng.drain()
  expect((await st.load(m.id))?.node).toBe("L")
})

test("failed activity routes to the default edge", async () => {
  const chart: Chart = {
    name: "fail",
    nodes: [
      { id: "w", type: "shell", config: { on_enter: `exit 1` } },
      { id: "ok", type: "end", config: { outcome: "success" } },
      { id: "bad", type: "end", config: { outcome: "fail" } },
    ],
    edges: [ { from: "w", to: "ok", name: "ok" }, { from: "w", to: "bad", default: true } ],
  }
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("fail", "w")
  await eng.submit(m); await eng.drain()
  expect((await st.load(m.id))?.node).toBe("bad")
})

test("cycle guard fails a runaway loop", async () => {
  const loop: Chart = {
    name: "loop",
    nodes: [ { id: "a", type: "shell", config: { on_enter: `echo hi` } } ],
    edges: [ { from: "a", to: "a" } ],
  }
  const st = store(); await st.init()
  const eng = new Engine({ chart: loop, store: st, maxSteps: 10 })
  const m = newMarble("loop", "a")
  await eng.submit(m); await eng.drain()
  const f = await st.load(m.id)
  expect(f?.status).toBe("failed")
  expect(f?.error).toMatch(/max steps/)
})

test("resume re-enqueues in-flight marbles from disk", async () => {
  const st = store(); await st.init()
  // a marble persisted mid-flight at "work"
  const m: Marble = { id: "r1", chart: "linear", node: "work", context: {}, history: ["s", "work"], status: "running", createdAt: "t", updatedAt: "t" }
  await st.save(m)
  const eng = new Engine({ chart: linear, store: st })
  await eng.resume()
  await eng.drain()
  expect((await st.load("r1"))?.status).toBe("done")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/engine.test.ts`
Expected: FAIL — cannot find `../src/engine`.

- [ ] **Step 3: Write the implementation**

```ts
// src/engine.ts
import type { Chart, ChartEdge, ChartNode, Marble, NodeResult } from "./types"
import { getNodeType } from "./registry"
import { runShell } from "./context"
import { MarbleStore } from "./store"
import { genId, now } from "./util"

export interface EngineOpts {
  chart: Chart
  store: MarbleStore
  concurrency?: number
  maxSteps?: number
  onChange?: (m: Marble) => void
}

export function newMarble(
  chart: string,
  startNode: string,
  context: Record<string, unknown> = {},
  workpiece?: string,
): Marble {
  const t = now()
  return {
    id: genId(), chart, node: startNode, context, workpiece,
    history: [startNode], status: "queued", createdAt: t, updatedAt: t,
  }
}

async function withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
  if (!ms) return p
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("activity timeout")), ms)),
  ])
}

export class Engine {
  private running = 0
  private queue: Marble[] = []

  constructor(private opts: EngineOpts) {}

  private node(id: string): ChartNode {
    const n = this.opts.chart.nodes.find((n) => n.id === id)
    if (!n) throw new Error(`unknown node: ${id}`)
    return n
  }

  private outgoing(id: string): ChartEdge[] {
    return this.opts.chart.edges.filter((e) => e.from === id)
  }

  async submit(m: Marble): Promise<void> {
    await this.persist(m)
    this.enqueue(m)
  }

  async resume(): Promise<void> {
    const all = await this.opts.store.all()
    for (const m of all) {
      if (m.status === "running" || m.status === "queued") this.enqueue(m)
    }
  }

  drain(): Promise<void> {
    return new Promise((resolve) => {
      const check = () =>
        this.running === 0 && this.queue.length === 0 ? resolve() : setTimeout(check, 5)
      check()
    })
  }

  private enqueue(m: Marble): void {
    this.queue.push(m)
    this.pump()
  }

  private pump(): void {
    const cap = this.opts.concurrency ?? 4
    while (this.running < cap && this.queue.length > 0) {
      const m = this.queue.shift()!
      this.running++
      this.step(m).finally(() => {
        this.running--
        this.pump()
      })
    }
  }

  private async persist(m: Marble): Promise<void> {
    m.updatedAt = now()
    await this.opts.store.save(m)
    this.opts.onChange?.(m)
  }

  private async execNode(node: ChartNode, m: Marble): Promise<NodeResult> {
    const nt = getNodeType(node.type)
    const max = node.retry?.max ?? 0
    let lastErr: unknown
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const res = await withTimeout(
          nt.run({ chart: this.opts.chart, marble: m, node, outgoing: this.outgoing(node.id) }),
          node.timeout,
        )
        if (res.failed && attempt < max) continue
        return res
      } catch (err) {
        lastErr = err
        if (attempt === max) throw err
      }
    }
    throw lastErr
  }

  private resolveEdge(node: ChartNode, result: NodeResult): ChartEdge | undefined {
    const out = this.outgoing(node.id)
    if (result.next) {
      return out.find((e) => e.name === result.next) ?? out.find((e) => e.to === result.next)
    }
    if (result.failed) {
      return out.find((e) => e.name === "fail") ?? out.find((e) => e.default)
    }
    if (out.length === 1) return out[0]
    return out.find((e) => e.default)
  }

  // Runs exactly one node-step, then re-enqueues if the marble advanced.
  private async step(m: Marble): Promise<void> {
    const node = this.node(m.node)
    m.status = "running"
    await this.persist(m)

    let result: NodeResult
    try {
      result = await this.execNode(node, m)
    } catch (err) {
      m.status = "failed"
      m.error = String(err)
      await this.persist(m)
      return
    }

    if (result.merge) m.context = { ...m.context, ...result.merge }

    if (result.end || node.type === "end") {
      m.context._outcome = result.endOutcome ?? "success"
      m.status = result.endOutcome === "fail" ? "failed" : "done"
      await this.persist(m)
      return
    }

    if (result.block) {
      m.status = "blocked"
      await this.persist(m)
      return
    }

    const edge = this.resolveEdge(node, result)
    if (!edge) {
      m.status = "failed"
      m.error = `no matching edge from ${node.id} (next=${result.next ?? "-"})`
      await this.persist(m)
      return
    }

    if (node.on_leave) await runShell(node.on_leave, m, node)
    if (edge.on_traversal) await runShell(edge.on_traversal, m, node)

    m.node = edge.to
    m.history.push(edge.to)

    if (m.history.length > (this.opts.maxSteps ?? 1000)) {
      m.status = "failed"
      m.error = "max steps exceeded (cycle guard)"
      await this.persist(m)
      return
    }

    await this.persist(m)
    this.enqueue(m)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/engine.test.ts`
Expected: PASS (5 pass).

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts tests/engine.test.ts
git commit -m "feat: marble engine — scheduler, routing, retry, cycle guard, resume"
```

---

## Task 10: Headless run entry + worked example (e2e)

**Files:**
- Create: `src/run.ts`
- Create: `examples/build-pipeline.yaml`
- Test: `tests/e2e.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/e2e.test.ts
import { test, expect } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runChartFile } from "../src/run"

test("build-pipeline example: passing marble reaches 'shipped'", async () => {
  const dir = join(tmpdir(), "wc-e2e-" + crypto.randomUUID().slice(0, 8))
  const marble = await runChartFile("examples/build-pipeline.yaml", {
    start: "ingest",
    context: { tests_pass: "yes" },
    storeDir: dir,
  })
  expect(marble.status).toBe("done")
  expect(marble.node).toBe("shipped")
  expect(marble.history).toContain("build")
})

test("build-pipeline example: failing marble reaches 'halted'", async () => {
  const dir = join(tmpdir(), "wc-e2e-" + crypto.randomUUID().slice(0, 8))
  const marble = await runChartFile("examples/build-pipeline.yaml", {
    start: "ingest",
    context: { tests_pass: "no" },
    storeDir: dir,
  })
  expect(marble.status).toBe("failed")
  expect(marble.node).toBe("halted")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/e2e.test.ts`
Expected: FAIL — cannot find `../src/run`.

- [ ] **Step 3: Write the implementation + example**

```ts
// src/run.ts
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseChart } from "./schema"
import { registerBuiltins } from "./nodeTypes"
import { hasNodeType } from "./registry"
import { MarbleStore } from "./store"
import { Engine, newMarble } from "./engine"
import type { Marble } from "./types"

export interface RunOpts {
  start: string
  context?: Record<string, unknown>
  workpiece?: string
  storeDir?: string
}

// Convenience headless runner: load a chart file, run ONE marble to completion,
// and return its final state. (Plan 2 adds the long-lived daemon + control API.)
export async function runChartFile(path: string, opts: RunOpts): Promise<Marble> {
  if (!hasNodeType("end")) registerBuiltins()
  const chart = parseChart(await readFile(path, "utf8"))
  const store = new MarbleStore(opts.storeDir ?? join(tmpdir(), "whoachart-" + crypto.randomUUID().slice(0, 8)))
  await store.init()

  const engine = new Engine({ chart, store })
  const m = newMarble(chart.name, opts.start, opts.context ?? {}, opts.workpiece)
  await engine.submit(m)
  await engine.drain()

  const final = await store.load(m.id)
  if (!final) throw new Error(`marble ${m.id} vanished from store`)
  return final
}
```

```yaml
# examples/build-pipeline.yaml
# A headless demo: a marble flows through a build/test pipeline.
# Routing is node-centric — the `test` decision emits the next edge name.
name: build-pipeline
nodes:
  - id: ingest
    type: source
    name: New build
    config:
      trigger: api

  - id: build
    type: shell
    name: Build
    config:
      on_enter: |
        echo "building..."
        echo '{"merge":{"built":true}}'

  - id: test
    type: decision
    name: Tests pass?
    config:
      on_enter: |
        ctx=$(cat "$WHOACHART_CONTEXT")
        if echo "$ctx" | grep -q '"tests_pass":"yes"'; then
          echo '{"next":"pass"}'
        else
          echo '{"next":"fail"}'
        fi

  - id: shipped
    type: end
    name: Shipped
    config:
      outcome: success

  - id: halted
    type: end
    name: Halted
    config:
      outcome: fail

edges:
  - { from: ingest, to: build }
  - { from: build, to: test }
  - { from: test, to: shipped, name: pass, on_traversal: "echo shipping >&2" }
  - { from: test, to: halted, name: fail }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/e2e.test.ts`
Expected: PASS (2 pass).

- [ ] **Step 5: Run the full suite + commit**

Run: `bun test`
Expected: PASS — all suites green.

```bash
git add src/run.ts examples/build-pipeline.yaml tests/e2e.test.ts
git commit -m "feat: headless run entry and build-pipeline e2e example"
```

---

## Self-Review

**Spec coverage (against §11 MVP "In"):**
- Chart loader + YAML schema (universal + typed config; dumb edges w/ name/on_traversal/default) → Tasks 2, 4. ✅
- Multi-marble engine: per-marble loop, concurrency cap, cycle guard, retry/timeout, JSON persistence + restart rehydration → Tasks 5, 9. ✅
- Node types `source`, `shell`, `api`, `decision`, `end` → Tasks 7, 8. ✅ (`agent` is Plan 2, per the split — §11 lists it but it requires Tinstar.)
- Node-centric routing + activity contract (env in, exit/JSON out) → Tasks 6, 9. ✅
- One worked example chart → Task 10 (shell-based; the agent-bearing content-pipeline lands in Plan 2 once `agent` exists). ✅
- **Deferred to Plan 2 (by the scope split):** live chromed view, agent session spawn + constellation/color/avatar, control API + CLI intake. These are the entire "Tinstar integration" subsystem.
- The `whoachart next/set` helper CLI (spec §3/§4) is sugar over the stdout-JSON contract; the JSON contract is implemented here, the helper ships with the CLI in Plan 2.

**Placeholder scan:** none — every step has full code and concrete commands.

**Type consistency:** `Chart`/`ChartNode`/`ChartEdge`/`Marble`/`NodeResult`/`RunCtx` (Task 2) are used unchanged in registry (3), schema (4), store (5), context (6), node types (7,8), engine (9). `NodeType.run(ctx: RunCtx)` signature is consistent across all node modules. Snake_case hook keys (`on_leave`, `on_traversal`, `on_enter`) match the spec YAML and the types throughout. `newMarble` / `Engine` signatures used by tests match Task 9 definitions.
