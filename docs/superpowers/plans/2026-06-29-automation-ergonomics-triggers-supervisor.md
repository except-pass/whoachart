# whoachart Automation Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make whoachart charts self-driving — registrable from anywhere, fired by cron schedules and tailnet webhooks, and optionally overseen by a long-lived Tinstar supervisor session that resolves only agent-designated gates.

**Architecture:** Charts declare a top-level `triggers:` block (cron/`every`/webhook) and an optional `supervisor:` block, both parsed in `src/schema.ts`. A new in-process `Scheduler` (injectable clock) arms cron/interval timers at the existing `installRuntime` liveness seam and fires through the existing `submit()` + form-validation path. A new `POST /api/hooks/:chart/:hook` route routes inbound JSON to a chart behind the existing tailnet trust gate. Register-anywhere is a symlink into the store dir, so "the on-disk set IS the registry" still holds with no side index. The supervisor is one Tinstar session per chart, spawned via the existing `SessionLauncher`, placed in a new `WHOACHART_AGENT_SPACE`, that consumes the control API; a `decider: human|agent` node field tells it which gates are its to resolve.

**Tech Stack:** Bun + TypeScript, `bun:test`, `zod` for schema, `yaml` for parsing. No new runtime dependencies (the cron evaluator is self-contained).

**Design spec:** `docs/superpowers/specs/2026-06-29-automation-ergonomics-triggers-supervisor-design.md`

## Global Constraints

- No new runtime dependencies — cron parsing is a self-contained module (deps stay `yaml` + `zod`).
- All chart-state mutations go through `Daemon.mutate()` (the global serialization lock). Trigger fires and webhook fires call `submit()`, which is already inside `mutate()`.
- Registration (by value or by path) is **loopback-only** (`writeGate`); triggers/webhooks ride the base trust gate (loopback + tailnet) and are NOT under `writeGate`.
- Cron is **fire-forward only** — never replay missed ticks.
- The runtime map (`this.runtimes`) is the liveness source of truth: any pending timer or retry must short-circuit when `runtimes.has(name)` is false.
- File paths in code stay as the repo uses them; tests live in `tests/*.test.ts` and reset global node-type state with `clearRegistry(); registerBuiltins()` where they parse charts.
- Time-based tests use the injectable `FakeClock`; never `setTimeout`-sleep on wall-clock for scheduling assertions.

---

## File Structure

**New files:**
- `src/cron.ts` — pure cron/interval evaluator (`nextRun`, `everyToMs`, `parseCron`).
- `src/scheduler.ts` — `Clock` interface, `realClock`, `Scheduler` class (arms time-based triggers).
- `src/supervisor.ts` — `buildSupervisorBrief(chart, apiBase)`.
- `tests/cron.test.ts`, `tests/scheduler.test.ts`, `tests/triggerSchema.test.ts`, `tests/registerPath.test.ts`, `tests/webhook.test.ts`, `tests/supervisor.test.ts`.

**Modified files:**
- `src/types.ts` — `ChartTrigger`, `SupervisorSpec`, `ChartNode.decider`, `Chart.triggers`/`Chart.supervisor`.
- `src/schema.ts` — parse + validate the new blocks.
- `src/chartStore.ts` — `link()`, `writeTarget()`.
- `src/daemon.ts` — `registerChartByPath`, `fireWebhook`, scheduler ownership + `armTriggers`/`disarmTriggers`, `ensureSupervisor`/`stopSupervisor`, `agentSpaceId`, `decider` in `def()`, `DaemonOpts.clock`/`agentSpace`, write-through on update.
- `src/controlApi.ts` — register-by-path branch on `POST /api/charts`; `POST /api/hooks/:chart/:hook`.
- `src/tinstar.ts` — `SpawnSessionOpts.spaceId` (auto-forwarded via existing `...opts` spread).
- `src/main.ts` — read `WHOACHART_AGENT_SPACE`.
- `tests/fakes.ts` — `FakeClock`.

---

## Task 1: Trigger / supervisor / decider schema

**Files:**
- Modify: `src/types.ts`
- Modify: `src/schema.ts`
- Test: `tests/triggerSchema.test.ts`

**Interfaces:**
- Produces: `ChartTrigger { cron?: string; every?: string; webhook?: string; start: string; context?: Record<string, unknown> }`, `SupervisorSpec { brief: string; cli_template?: string; project?: string }`, `ChartNode.decider?: "human" | "agent"`, `Chart.triggers?: ChartTrigger[]`, `Chart.supervisor?: SupervisorSpec`. `parseChart` validates and returns these.

- [ ] **Step 1: Write the failing test**

Create `tests/triggerSchema.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test"
import { parseChart } from "../src/schema"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"

beforeEach(() => { clearRegistry(); registerBuiltins() })

const base = (extra: string) => `
name: trig
triggers:
${extra}
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: done }
`

test("parses a cron trigger bound to a source node", () => {
  const c = parseChart(base(`  - { cron: "0 9 * * 1-5", start: scan, context: { since: "" } }`))
  expect(c.triggers).toEqual([{ cron: "0 9 * * 1-5", start: "scan", context: { since: "" } }])
})

test("parses every + webhook triggers", () => {
  const c = parseChart(base(`  - { every: 15m, start: scan }\n  - { webhook: ping, start: scan }`))
  expect(c.triggers?.[0]).toEqual({ every: "15m", start: "scan" })
  expect(c.triggers?.[1]).toEqual({ webhook: "ping", start: "scan" })
})

test("rejects a trigger with neither cron/every/webhook", () => {
  expect(() => parseChart(base(`  - { start: scan }`))).toThrow(/exactly one of/)
})

test("rejects a trigger with two of cron/every/webhook", () => {
  expect(() => parseChart(base(`  - { cron: "* * * * *", every: 5m, start: scan }`))).toThrow(/exactly one of/)
})

test("rejects a trigger whose start is not a source node", () => {
  expect(() => parseChart(base(`  - { every: 5m, start: done }`))).toThrow(/must name a source node/)
})

test("rejects duplicate webhook ids", () => {
  expect(() => parseChart(base(`  - { webhook: ping, start: scan }\n  - { webhook: ping, start: scan }`))).toThrow(/duplicate webhook/)
})

test("parses a supervisor block and node decider", () => {
  const c = parseChart(`
name: trig
supervisor: { brief: "watch it", project: whoachart }
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: gate
    type: human
    decider: agent
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: gate }
  - { from: gate, to: done, name: ok }
`)
  expect(c.supervisor).toEqual({ brief: "watch it", project: "whoachart" })
  expect(c.nodes.find((n) => n.id === "gate")?.decider).toBe("agent")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/triggerSchema.test.ts`
Expected: FAIL — `parseChart` ignores `triggers`/`supervisor`/`decider` (undefined), and the validation throws don't exist.

- [ ] **Step 3: Add the types**

In `src/types.ts`, add the `decider` field to `ChartNode` (after `color?`):

```typescript
  // Who may resolve this gate. The supervisor session acts ONLY on `agent`
  // gates; `human` (the default when unset) gates are left for a person.
  decider?: "human" | "agent"
```

Add these interfaces and extend `Chart` (after the `ChartEdge` interface):

```typescript
export interface ChartTrigger {
  // Exactly one of these three is set (enforced in schema.ts).
  cron?: string          // 5-field cron, local time (e.g. "0 9 * * 1-5")
  every?: string         // interval form (e.g. "15m"); <n>s|m|h
  webhook?: string       // inbound hook id -> POST /api/hooks/:chart/:webhook
  start: string          // a source node id; the marble entry point
  context?: Record<string, unknown> // static context (cron/every); merged under a webhook body
}

export interface SupervisorSpec {
  brief: string
  cli_template?: string
  project?: string
}
```

In the `Chart` interface, add:

```typescript
  triggers?: ChartTrigger[]
  supervisor?: SupervisorSpec
```

- [ ] **Step 4: Add schema parsing + validation**

In `src/schema.ts`, add `decider` to `nodeSchema` (after `color`):

```typescript
  decider: z.enum(["human", "agent"]).optional(),
```

Add these schemas before `chartSchema`:

```typescript
const triggerSchema = z
  .object({
    cron: z.string().optional(),
    every: z.string().optional(),
    webhook: z.string().regex(/^[A-Za-z0-9_-]+$/, "webhook id must be [A-Za-z0-9_-]").optional(),
    start: z.string(),
    context: z.record(z.unknown()).optional(),
  })
  .superRefine((t, ctx) => {
    const set = [t.cron, t.every, t.webhook].filter((x) => x !== undefined).length
    if (set !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "trigger must set exactly one of cron, every, webhook" })
    }
  })

const supervisorSchema = z.object({
  brief: z.string(),
  cli_template: z.string().optional(),
  project: z.string().optional(),
})
```

Add to `chartSchema`:

```typescript
  triggers: z.array(triggerSchema).optional(),
  supervisor: supervisorSchema.optional(),
```

In `parseChart`, after the edge-endpoint validation loop and before the per-node config loop, add trigger cross-checks:

```typescript
  const sourceIds = new Set(chart.nodes.filter((n) => n.type === "source").map((n) => n.id))
  const hookIds = new Set<string>()
  for (const t of chart.triggers ?? []) {
    if (!sourceIds.has(t.start)) throw new Error(`trigger start must name a source node: ${t.start}`)
    if (t.webhook) {
      if (hookIds.has(t.webhook)) throw new Error(`duplicate webhook id: ${t.webhook}`)
      hookIds.add(t.webhook)
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/triggerSchema.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `bun test`
Expected: PASS — existing charts have no `triggers`/`supervisor`/`decider`, so the optional fields are inert.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/schema.ts tests/triggerSchema.test.ts
git commit -m "feat(schema): parse top-level triggers, supervisor, and node decider

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Register-anywhere via symlink

**Files:**
- Modify: `src/chartStore.ts`
- Modify: `src/daemon.ts`
- Modify: `src/controlApi.ts`
- Test: `tests/registerPath.test.ts`

**Interfaces:**
- Consumes: `ChartStore.path()`, `assertSafeChartName`, `parseChart`, `lintChart`, `Daemon.installRuntime`, `Daemon.mutate`.
- Produces: `ChartStore.link(name, target): Promise<string>` (returns the symlink path), `ChartStore.writeTarget(path): Promise<string>` (free function, exported), `Daemon.registerChartByPath(targetPath): Promise<{ name; warnings }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/registerPath.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir, readFile, lstat } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas } from "./fakes"
import { waitForStatus } from "./poll"

const EXTERNAL = `
name: faraway
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: done }
`

let daemon: Daemon, server: ReturnType<typeof Bun.serve>, base: string
let chartsDir: string, storeDir: string, externalPath: string

beforeEach(async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-rp-"))
  chartsDir = join(root, "charts"); storeDir = join(root, "store")
  const ext = join(root, "elsewhere"); await mkdir(ext, { recursive: true }); await mkdir(chartsDir, { recursive: true })
  externalPath = join(ext, "faraway.yaml"); await writeFile(externalPath, EXTERNAL)
  daemon = new Daemon({ chartsDir, storeDir, client: new FakeCanvas() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("POST /api/charts {path} registers an external chart by reference and runs it", async () => {
  const res = await fetch(`${base}/api/charts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: externalPath }),
  })
  expect(res.status).toBe(201)
  expect(await res.json()).toEqual({ name: "faraway", warnings: [] })
  // a symlink (not a copy) landed in the store dir
  const link = join(chartsDir, "faraway.yaml")
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  // runnable immediately
  const m = await daemon.submit("faraway", {})
  const final = await waitForStatus(() => daemon.marble("faraway", m.id), "done")
  expect(final.status).toBe("done")
})

test("a chart registered by reference survives a daemon restart", async () => {
  await fetch(`${base}/api/charts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: externalPath }),
  })
  clearRegistry(); registerBuiltins()
  const d2 = new Daemon({ chartsDir, storeDir, client: new FakeCanvas() })
  await d2.start()
  expect(d2.charts()).toContain("faraway")
})

test("PUT on a referenced chart writes through to the real file, not the symlink", async () => {
  await fetch(`${base}/api/charts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: externalPath }),
  })
  const edited = EXTERNAL.replace("- id: ingest", "- id: ingest\n    name: Edited intake").replace("type: source", "type: source")
  const put = await fetch(`${base}/api/charts/faraway`, { method: "PUT", body: edited })
  expect(put.status).toBe(200)
  // the external file was updated and the store entry is STILL a symlink
  expect(await readFile(externalPath, "utf8")).toContain("Edited intake")
  expect((await lstat(join(chartsDir, "faraway.yaml"))).isSymbolicLink()).toBe(true)
})

test("register {path} requires the chart store and is loopback-only", async () => {
  const tailnet = createControlApi(daemon, 0, { resolveAddr: () => "100.108.201.76" })
  try {
    const res = await fetch(`http://localhost:${tailnet.port}/api/charts`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: externalPath }),
    })
    expect(res.status).toBe(403)
  } finally { tailnet.stop(true) }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/registerPath.test.ts`
Expected: FAIL — `registerChartByPath` and the `{path}` route do not exist; JSON body falls through to `registerChart(await req.text())` and errors on YAML parse.

- [ ] **Step 3: Add `link` and `writeTarget` to the chart store**

In `src/chartStore.ts`, extend the imports:

```typescript
import { mkdir, readdir, readFile, writeFile, rename, unlink, symlink, lstat, realpath } from "node:fs/promises"
```

Add this exported free function after `atomicWrite`:

```typescript
// The real file to write when updating a chart. A chart registered BY REFERENCE
// is a symlink in the store dir; follow it so an edit lands on the user's file
// instead of atomicWrite's tmp+rename clobbering the link with a plain file.
export async function writeTarget(path: string): Promise<string> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return await realpath(path)
  } catch {
    // lstat/realpath failure (dangling link, race): fall back to the path as-is.
  }
  return path
}
```

Add this method to `ChartStore` (after `write`):

```typescript
  // Register an external chart BY REFERENCE: a symlink <name>.yaml -> target.
  // listNames/resolvePath/read already follow symlinks, so the dir stays the
  // registry with no side index. Returns the symlink path (the runtime's file).
  async link(name: string, target: string): Promise<string> {
    await this.init()
    const linkPath = this.path(name) // assertSafeChartName runs inside path()
    await symlink(target, linkPath)
    return linkPath
  }
```

- [ ] **Step 4: Add `registerChartByPath` + write-through to the daemon**

In `src/daemon.ts`, extend imports:

```typescript
import { join, basename, isAbsolute } from "node:path"
import { ChartStore, ChartError, assertSafeChartName, atomicWrite, writeTarget } from "./chartStore"
```

Add this method to `Daemon`, right after `registerChart`:

```typescript
  // Register a chart that lives at an arbitrary path (register-by-reference): a
  // symlink into the store dir keeps it discoverable across restarts with no
  // side index. Loopback-only at the route (writeGate), like every chart write.
  async registerChartByPath(targetPath: string): Promise<{ name: string; warnings: LintWarning[] }> {
    if (!this.chartStore) throw new ChartError("chart store not configured (set WHOACHART_CHARTS_DIR)", 501)
    return this.mutate(async () => {
      const abs = isAbsolute(targetPath) ? targetPath : join(process.cwd(), targetPath)
      const chart = parseChart(await readFile(abs, "utf8")) // bad chart / ENOENT -> 400 (controlApi)
      assertSafeChartName(chart.name)
      if (this.runtimes.has(chart.name) || (await this.chartStore!.exists(chart.name))) {
        throw new ChartError(`chart already exists: ${chart.name}`, 409)
      }
      const lint = lintChart(chart)
      const linkPath = await this.chartStore!.link(chart.name, abs)
      await this.installRuntime(chart, linkPath)
      logLine(chart.name, `registered by reference -> ${abs}`)
      return { name: chart.name, warnings: lint.warnings }
    })
  }
```

In `updateChart`, change the write-back line so referenced charts write through to the real file. Replace:

```typescript
        await atomicWrite(existing.file, yamlText)
```

with:

```typescript
        await atomicWrite(await writeTarget(existing.file), yamlText)
```

- [ ] **Step 5: Branch the POST /api/charts route on a JSON `{path}` body**

In `src/controlApi.ts`, replace the existing `POST /api/charts` block:

```typescript
        // POST /api/charts — register a new chart from a raw YAML request body.
        if (req.method === "POST" && url.pathname === "/api/charts") {
          const blocked = writeGate(addr)
          if (blocked) return blocked
          return json(await daemon.registerChart(await req.text()), 201)
        }
```

with:

```typescript
        // POST /api/charts — register a chart. A JSON `{path}` body registers
        // BY REFERENCE (symlink to a file anywhere on disk); any other body is
        // raw YAML registered BY VALUE (copied into the store). Both loopback-only.
        if (req.method === "POST" && url.pathname === "/api/charts") {
          const blocked = writeGate(addr)
          if (blocked) return blocked
          if ((req.headers.get("content-type") ?? "").includes("application/json")) {
            const body = (await req.json().catch(() => ({}))) as { path?: unknown }
            if (typeof body.path === "string") return json(await daemon.registerChartByPath(body.path), 201)
            return json({ error: "expected { path } for a JSON register" }, 400)
          }
          return json(await daemon.registerChart(await req.text()), 201)
        }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test tests/registerPath.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: PASS — the raw-YAML register path is unchanged for non-JSON bodies.

- [ ] **Step 8: Commit**

```bash
git add src/chartStore.ts src/daemon.ts src/controlApi.ts tests/registerPath.test.ts
git commit -m "feat(store): register charts by reference via store-dir symlink

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Cron / interval evaluator (pure)

**Files:**
- Create: `src/cron.ts`
- Test: `tests/cron.test.ts`

**Interfaces:**
- Produces: `parseCron(expr): Set<number>[]`, `nextRun(expr: string, after: Date): Date` (strictly-after, local time, minute resolution), `everyToMs(spec: string): number`.

- [ ] **Step 1: Write the failing test**

Create `tests/cron.test.ts`:

```typescript
import { test, expect } from "bun:test"
import { nextRun, everyToMs, parseCron } from "../src/cron"

test("nextRun advances to the next matching minute (weekday 9am)", () => {
  // Sun 2026-06-28 10:00 local -> next weekday 09:00 is Mon 2026-06-29 09:00
  const after = new Date(2026, 5, 28, 10, 0, 0)
  const next = nextRun("0 9 * * 1-5", after)
  expect(next.getFullYear()).toBe(2026)
  expect(next.getMonth()).toBe(5)
  expect(next.getDate()).toBe(29)
  expect(next.getHours()).toBe(9)
  expect(next.getMinutes()).toBe(0)
  expect(next.getDay()).toBe(1) // Monday
})

test("nextRun is strictly after — an exact match rolls to the next occurrence", () => {
  const at = new Date(2026, 5, 29, 9, 0, 0) // exactly Mon 09:00
  const next = nextRun("0 9 * * 1-5", at)
  expect(next.getDate()).toBe(30) // Tue 09:00, not the same instant
})

test("nextRun handles step fields (every 15 min)", () => {
  const after = new Date(2026, 5, 29, 9, 7, 0)
  const next = nextRun("*/15 * * * *", after)
  expect(next.getMinutes()).toBe(15)
  expect(next.getHours()).toBe(9)
})

test("parseCron rejects a wrong field count", () => {
  expect(() => parseCron("* * * *")).toThrow(/5 fields/)
})

test("parseCron rejects out-of-range values", () => {
  expect(() => parseCron("99 * * * *")).toThrow(/out of range/)
})

test("everyToMs parses s/m/h", () => {
  expect(everyToMs("30s")).toBe(30_000)
  expect(everyToMs("15m")).toBe(900_000)
  expect(everyToMs("2h")).toBe(7_200_000)
})

test("everyToMs rejects bad forms", () => {
  expect(() => everyToMs("15")).toThrow(/expected/)
  expect(() => everyToMs("0m")).toThrow(/positive/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cron.test.ts`
Expected: FAIL — `src/cron.ts` does not exist (module not found).

- [ ] **Step 3: Implement the evaluator**

Create `src/cron.ts`:

```typescript
// Self-contained 5-field cron + interval evaluator. No dependency.
//
// Fields: minute hour day-of-month month day-of-week (0=Sunday).
// Supported per field: `*`, value, `a-b` range, `a,b,c` list, `*/n` or `a-b/n`
// step. SIMPLIFICATION vs crontab(5): day-of-month and day-of-week are ANDed,
// not ORed — both must match. This is correct for the common "* dom + restricted
// dow" (weekday) and "restricted dom + * dow" cases; it only diverges when BOTH
// are restricted, which charts rarely need. Times are evaluated in LOCAL time.

interface Field { min: number; max: number }
const FIELDS: Field[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day of week (0=Sun)
]

function parseField(spec: string, { min, max }: Field): Set<number> {
  const out = new Set<number>()
  for (const part of spec.split(",")) {
    let step = 1
    let range = part
    const slash = part.indexOf("/")
    if (slash !== -1) { step = Number(part.slice(slash + 1)); range = part.slice(0, slash) }
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in cron field: "${part}"`)
    let lo: number, hi: number
    if (range === "*") { lo = min; hi = max }
    else if (range.includes("-")) { const [a, b] = range.split("-").map(Number); lo = a; hi = b }
    else { lo = hi = Number(range) }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron field out of range: "${part}" (allowed ${min}-${max})`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): Set<number>[] {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron must have 5 fields, got ${parts.length}: "${expr}"`)
  return parts.map((p, i) => parseField(p, FIELDS[i]))
}

// The next fire STRICTLY AFTER `after`, at minute resolution, in local time.
export function nextRun(expr: string, after: Date): Date {
  const [mins, hours, doms, months, dows] = parseCron(expr)
  const d = new Date(after.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1) // strictly after the current minute
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      months.has(d.getMonth() + 1) && doms.has(d.getDate()) && dows.has(d.getDay()) &&
      hours.has(d.getHours()) && mins.has(d.getMinutes())
    ) return d
    d.setMinutes(d.getMinutes() + 1)
  }
  throw new Error(`no cron match within a year for "${expr}"`)
}

// Interval form: <n>s|m|h -> milliseconds. Positive only.
export function everyToMs(spec: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(spec.trim())
  if (!m) throw new Error(`bad interval "${spec}" (expected <n>s|m|h, e.g. 15m)`)
  const mult = m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000
  const ms = Number(m[1]) * mult
  if (ms <= 0) throw new Error(`interval must be positive: "${spec}"`)
  return ms
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cron.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cron.ts tests/cron.test.ts
git commit -m "feat(cron): self-contained 5-field cron + interval evaluator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Scheduler + daemon trigger wiring

**Files:**
- Create: `src/scheduler.ts`
- Modify: `tests/fakes.ts`
- Modify: `src/daemon.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `nextRun`, `everyToMs` (Task 3); `ChartTrigger` (Task 1); `Daemon.submit`, `Daemon.installRuntime`, `Daemon.runtimes`.
- Produces: `Clock { now(): number; setTimer(ms, fn): () => void }`, `realClock`, `Scheduler` with `arm(chart, triggers, fire)`, `disarm(chart)`, `disarmAll()`. `DaemonOpts.clock?: Clock`. `FakeClock` with `advance(ms): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/scheduler.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { Scheduler } from "../src/scheduler"
import { Daemon } from "../src/daemon"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas, FakeClock } from "./fakes"
import { waitFor } from "./poll"

test("Scheduler fires an interval trigger each period and stops on disarm", () => {
  const clock = new FakeClock()
  const sched = new Scheduler(clock)
  let fired = 0
  sched.arm("c", [{ every: "10m", start: "scan" }], () => { fired++ })
  expect(fired).toBe(0)
  clock.advance(10 * 60_000); expect(fired).toBe(1)
  clock.advance(10 * 60_000); expect(fired).toBe(2)
  sched.disarm("c")
  clock.advance(10 * 60_000); expect(fired).toBe(2) // no more fires
})

const CRON_CHART = `
name: ticktock
triggers:
  - { every: 1m, start: scan, context: { hello: "world" } }
nodes:
  - id: scan
    type: source
    config: { trigger: api, form: [ { key: hello, type: text } ] }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: done }
`

let daemon: Daemon, clock: FakeClock
beforeEach(async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-sch-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "ticktock.yaml"), CRON_CHART)
  clock = new FakeClock()
  daemon = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas(), clock })
  await daemon.start()
})

test("an interval trigger submits a marble with its static context when time advances", async () => {
  expect((await daemon.marbles("ticktock")).length).toBe(0)
  clock.advance(60_000)
  const m = await waitFor(async () => {
    const all = await daemon.marbles("ticktock")
    return all.length ? all[0] : null
  })
  expect(m.context.hello).toBe("world")
})

test("deleting a chart disarms its schedule", async () => {
  await daemon.deleteChart("ticktock", { force: true })
  clock.advance(60_000 * 5)
  // run-state dir for a deleted chart is gone; no fire occurred (no throw, no marble)
  expect(daemon.charts()).not.toContain("ticktock")
})
```

Add `FakeClock` to `tests/fakes.ts` (append):

```typescript
import type { Clock } from "../src/scheduler"

export class FakeClock implements Clock {
  private t = 0
  private seq = 0
  private timers: { at: number; fn: () => void; id: number }[] = []
  now(): number { return this.t }
  setTimer(ms: number, fn: () => void): () => void {
    const id = ++this.seq
    this.timers.push({ at: this.t + ms, fn, id })
    return () => { this.timers = this.timers.filter((x) => x.id !== id) }
  }
  // Advance time, firing every timer that comes due (earliest first). A timer the
  // callback re-arms lands past the new `t`, so it waits for a further advance.
  advance(ms: number): void {
    this.t += ms
    const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)
    this.timers = this.timers.filter((x) => x.at > this.t)
    for (const d of due) d.fn()
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scheduler.test.ts`
Expected: FAIL — `src/scheduler.ts` does not exist; `DaemonOpts.clock` is unknown.

- [ ] **Step 3: Implement the Scheduler**

Create `src/scheduler.ts`:

```typescript
import { nextRun, everyToMs } from "./cron"
import type { ChartTrigger } from "./types"

export interface Clock {
  now(): number
  // Run fn after ms; return a cancel function.
  setTimer(ms: number, fn: () => void): () => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => {
    const t = setTimeout(fn, ms)
    ;(t as unknown as { unref?: () => void }).unref?.() // never hold the process open
    return () => clearTimeout(t)
  },
}

// Arms one self-rescheduling timer per time-based trigger (cron/every). Webhook
// triggers are not time-based and are ignored here. `fire` is called per tick;
// it may reject — onError is notified and the schedule continues (fire-forward).
export class Scheduler {
  private cancels = new Map<string, Array<() => void>>()
  constructor(
    private clock: Clock = realClock,
    private onError?: (chart: string, err: unknown) => void,
  ) {}

  arm(chart: string, triggers: ChartTrigger[], fire: (t: ChartTrigger) => Promise<void> | void): void {
    this.disarm(chart)
    const cancels: Array<() => void> = []
    for (const t of triggers) {
      if (t.cron) cancels.push(this.repeat(chart, t, fire, () => Math.max(0, nextRun(t.cron!, new Date(this.clock.now())).getTime() - this.clock.now())))
      else if (t.every) { const ms = everyToMs(t.every); cancels.push(this.repeat(chart, t, fire, () => ms)) }
      // webhook: handled by the inbound route, not the scheduler
    }
    if (cancels.length) this.cancels.set(chart, cancels)
  }

  disarm(chart: string): void {
    for (const c of this.cancels.get(chart) ?? []) c()
    this.cancels.delete(chart)
  }

  disarmAll(): void {
    for (const chart of [...this.cancels.keys()]) this.disarm(chart)
  }

  // Schedule `fire` after delayMs(), then reschedule from delayMs() again. Cancel
  // is idempotent and stops further reschedules.
  private repeat(
    chart: string,
    t: ChartTrigger,
    fire: (t: ChartTrigger) => Promise<void> | void,
    delayMs: () => number,
  ): () => void {
    let cancelled = false
    let cancelTimer: () => void = () => {}
    const tick = (): void => {
      if (cancelled) return
      cancelTimer = this.clock.setTimer(delayMs(), () => {
        if (cancelled) return
        Promise.resolve(fire(t)).catch((err) => this.onError?.(chart, err))
        tick()
      })
    }
    tick()
    return () => { cancelled = true; cancelTimer() }
  }
}
```

- [ ] **Step 4: Wire the Scheduler into the daemon**

In `src/daemon.ts`, add imports:

```typescript
import { Scheduler, realClock, type Clock } from "./scheduler"
```

Add to `DaemonOpts` (after `space?: string`):

```typescript
  // Injectable clock for the trigger scheduler (FakeClock in tests). Defaults to
  // realClock (setTimeout).
  clock?: Clock
```

Add a private field to `Daemon` (near `private chartStore?`):

```typescript
  private scheduler!: Scheduler
```

In `start()`, construct the scheduler right after `this.baseUrl` is set:

```typescript
    this.scheduler = new Scheduler(this.opts.clock ?? realClock, (chart, err) =>
      logLine(chart, `trigger fire failed: ${errMsg(err)}`),
    )
```

Add `armTriggers` + `fireTrigger` methods (after `installRuntime`):

```typescript
  // (Re)arm a chart's time-based triggers. Idempotent: arm() disarms first, so
  // this is safe to call on both install and hot-reload.
  private armTriggers(chart: Chart): void {
    this.scheduler.arm(chart.name, chart.triggers ?? [], (t) => this.fireTrigger(chart.name, t))
  }

  // A scheduled tick: submit a marble at the trigger's source with its static
  // context. Goes through submit() -> mutate(), so it serializes with reloads.
  private async fireTrigger(name: string, t: { start: string; context?: Record<string, unknown> }): Promise<void> {
    logLine(name, `trigger fired start=${t.start}`)
    await this.submit(name, { start: t.start, context: t.context ?? {} })
  }
```

In `installRuntime`, arm triggers alongside the widget loop:

```typescript
  private async installRuntime(chart: Chart, file: string): Promise<ChartRuntime> {
    const rt = await this.buildRuntime(chart, file)
    this.runtimes.set(chart.name, rt)
    this.ensureWidgetLoop(chart)
    this.armTriggers(chart)
    return rt
  }
```

In `updateChart`, after `this.runtimes.set(name, rt)` in the rebuild `try` block, re-arm with the NEW triggers:

```typescript
        this.runtimes.set(name, rt)
        this.armTriggers(chart)
```

In `deleteChart`, disarm before deleting. After `this.runtimes.delete(name)` add:

```typescript
      this.scheduler.disarm(name)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/scheduler.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: PASS — charts without triggers arm nothing; the default `realClock` is unref'd so it never holds tests open.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler.ts src/daemon.ts tests/fakes.ts tests/scheduler.test.ts
git commit -m "feat(daemon): in-process cron/interval scheduler armed at runtime install

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Inbound webhook route

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/controlApi.ts`
- Test: `tests/webhook.test.ts`

**Interfaces:**
- Consumes: `Daemon.submit`, `Daemon.runtimes`, `ChartError`, `Chart.triggers` (Task 1).
- Produces: `Daemon.fireWebhook(name, hookId, body): Promise<Marble>` (404 on unknown chart/hook).

- [ ] **Step 1: Write the failing test**

Create `tests/webhook.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas } from "./fakes"
import { waitFor } from "./poll"

const HOOK_CHART = `
name: hooky
triggers:
  - { webhook: jira-updated, start: scan }
nodes:
  - id: scan
    type: source
    config:
      trigger: api
      form:
        - { key: key, type: text, required: true }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: done }
`

let daemon: Daemon, server: ReturnType<typeof Bun.serve>, base: string
beforeEach(async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-hook-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "hooky.yaml"), HOOK_CHART)
  daemon = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("POST /api/hooks/:chart/:hook creates a marble from the JSON body", async () => {
  const res = await fetch(`${base}/api/hooks/hooky/jira-updated`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "PROJ-7" }),
  })
  expect(res.status).toBe(202)
  const { id } = (await res.json()) as any
  const m = await waitFor(async () => (await daemon.marble("hooky", id)))
  expect(m.context.key).toBe("PROJ-7")
})

test("a webhook body that fails form validation is 400", async () => {
  const res = await fetch(`${base}/api/hooks/hooky/jira-updated`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  })
  expect(res.status).toBe(400)
  expect(((await res.json()) as any).fields.key).toBe("required")
})

test("an unknown hook id is 404", async () => {
  const res = await fetch(`${base}/api/hooks/hooky/nope`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })
  expect(res.status).toBe(404)
})

test("a webhook from a tailnet peer is accepted (trigger, not a chart write)", async () => {
  const tailnet = createControlApi(daemon, 0, { resolveAddr: () => "100.108.201.76" })
  try {
    const res = await fetch(`http://localhost:${tailnet.port}/api/hooks/hooky/jira-updated`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "PROJ-9" }),
    })
    expect(res.status).toBe(202)
  } finally { tailnet.stop(true) }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/webhook.test.ts`
Expected: FAIL — no `/api/hooks` route (404 for all), `fireWebhook` undefined.

- [ ] **Step 3: Add `fireWebhook` to the daemon**

In `src/daemon.ts`, add this method after `submit`:

```typescript
  // Inbound webhook -> a marble at the bound source. The hook id comes from the
  // chart's triggers; the request body becomes context (merged over the
  // trigger's static context) and is form-validated inside submit(). Tailnet-
  // internal: gated like other triggers, NOT a chart write.
  async fireWebhook(name: string, hookId: string, body: Record<string, unknown>): Promise<Marble> {
    const rt = this.runtimes.get(name)
    if (!rt) throw new ChartError(`unknown chart: ${name}`, 404)
    const trigger = (rt.chart.triggers ?? []).find((t) => t.webhook === hookId)
    if (!trigger) throw new ChartError(`no webhook "${hookId}" on chart "${name}"`, 404)
    logLine(name, `webhook "${hookId}" fired`)
    return this.submit(name, { start: trigger.start, context: { ...(trigger.context ?? {}), ...body } })
  }
```

- [ ] **Step 4: Add the route**

In `src/controlApi.ts`, inside the `try` block (place it right after the `POST /api/charts/reload` block, before the `def` route), add:

```typescript
        // POST /api/hooks/:chart/:hook — tailnet-internal inbound trigger. Behind
        // the base trust gate (loopback + tailnet), NOT writeGate: it fires a run,
        // it does not install code. Body JSON -> marble context (form-validated).
        if (req.method === "POST" && p[0] === "api" && p[1] === "hooks" && p[2] && p[3] && !p[4]) {
          const parsed = await req.json().catch(() => ({}))
          const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
          const m = await daemon.fireWebhook(p[2], p[3], body)
          return json({ id: m.id, status: m.status }, 202)
        }
```

Also document it in the route comment header (add under the existing route list):

```typescript
//   POST /api/hooks/:chart/:hook         (tailnet-internal inbound trigger)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/webhook.test.ts`
Expected: PASS (4 tests). `FormError` is already mapped to a 400 with `fields` by the existing catch block.

- [ ] **Step 6: Run the full suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/daemon.ts src/controlApi.ts tests/webhook.test.ts
git commit -m "feat(daemon): tailnet-internal inbound webhook route to a chart source

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Surface `decider` in /def

**Files:**
- Modify: `src/daemon.ts`
- Test: `tests/uiRoutes.test.ts` (extend) or assert via `daemon.def`

**Interfaces:**
- Consumes: `ChartNode.decider` (Task 1).
- Produces: `ChartDef.nodes[].decider?: "human" | "agent"` in the `/def` payload.

- [ ] **Step 1: Write the failing test**

Append to `tests/triggerSchema.test.ts` a daemon-level assertion (it already imports parse; add daemon imports at the top of the file):

```typescript
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { FakeCanvas } from "./fakes"

test("def() surfaces a node's decider for the supervisor to read", async () => {
  const root = await mkdtemp(join(tmpdir(), "wc-dec-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "trig.yaml"), `
name: trig
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: gate
    type: human
    decider: agent
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: gate }
  - { from: gate, to: done, name: ok }
`)
  const d = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas() })
  await d.start()
  const node = d.def("trig").nodes.find((n) => n.id === "gate")
  expect(node?.decider).toBe("agent")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/triggerSchema.test.ts`
Expected: FAIL — `def()` does not emit `decider`, so `node?.decider` is `undefined`.

- [ ] **Step 3: Add `decider` to `ChartDef` and `def()`**

In `src/daemon.ts`, in the `ChartDef` interface `nodes` item shape, add after `name?: string`:

```typescript
    decider?: "human" | "agent"
```

In `def()`, in the node mapping object (after `name: n.name,`), add:

```typescript
        decider: n.decider,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/triggerSchema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/triggerSchema.test.ts
git commit -m "feat(def): expose node decider so the supervisor knows its gates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Supervisor session lifecycle

**Files:**
- Modify: `src/tinstar.ts`
- Create: `src/supervisor.ts`
- Modify: `src/daemon.ts`
- Modify: `src/main.ts`
- Test: `tests/supervisor.test.ts`

**Interfaces:**
- Consumes: `SessionLauncher.spawnSession`/`stopSession`, `CanvasControl.ensureSpace`, `Chart.supervisor` + `ChartNode.decider` (Task 1), `Daemon.installRuntime`/`deleteChart`/`runtimes`.
- Produces: `SpawnSessionOpts.spaceId?: string` (auto-forwarded in the POST body), `buildSupervisorBrief(chart, apiBase): string`, `DaemonOpts.agentSpace?: string`, `Daemon.ensureSupervisor`/`stopSupervisor`.

- [ ] **Step 1: Write the failing test**

Create `tests/supervisor.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas, FakeLauncher } from "./fakes"
import { waitFor } from "./poll"

const SUP_CHART = `
name: oversee
supervisor:
  brief: "Resolve routing gates; leave approvals to a human."
  project: whoachart
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: route
    type: human
    decider: agent
    config: {}
  - id: approve
    type: human
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: route }
  - { from: route, to: approve, name: ok }
  - { from: approve, to: done, name: post }
`

let daemon: Daemon, launcher: FakeLauncher
async function boot(agentSpace?: string) {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-sup-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "oversee.yaml"), SUP_CHART)
  launcher = new FakeLauncher()
  daemon = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas(), launcher, agentSpace })
  await daemon.start()
}

test("a chart with a supervisor block spawns one session, briefed on its agent gates", async () => {
  await boot("whoachart-agents")
  const sup = await waitFor(async () => launcher.spawned.find((s) => s.name.startsWith("wc-sup-")) ?? null)
  expect(sup.name).toBe("wc-sup-oversee")
  expect(sup.prompt).toContain("Resolve routing gates")
  expect(sup.prompt).toContain('decider:"agent"')   // it is told which gates are its to act on
  expect(sup.prompt).toContain("route")              // the agent gate is named
  expect(sup.project).toBe("whoachart")
  // placed in the configured agent space (FakeCanvas resolves to "sp-fake")
  expect(sup.spaceId).toBe("sp-fake")
})

test("deleting the chart stops the supervisor session", async () => {
  await boot()
  const sup = await waitFor(async () => launcher.spawned.find((s) => s.name === "wc-sup-oversee") ?? null)
  await daemon.deleteChart("oversee", { force: true })
  expect(launcher.stopped).toContain(sup.name)
})

test("a chart without a supervisor block spawns no supervisor", async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-nosup-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "plain.yaml"), `
name: plain
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: done }
`)
  const l = new FakeLauncher()
  const d = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas(), launcher: l })
  await d.start()
  expect(l.spawned.filter((s) => s.name.startsWith("wc-sup-"))).toHaveLength(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/supervisor.test.ts`
Expected: FAIL — `DaemonOpts.agentSpace` unknown, no supervisor spawn, `SpawnSessionOpts.spaceId` unknown.

- [ ] **Step 3: Add `spaceId` to the session launch surface**

In `src/tinstar.ts`, add to `SpawnSessionOpts` (after `worktree?: boolean`):

```typescript
  // Tinstar space to place the session in (supervisor sessions). Forwarded in the
  // create body; Tinstar honors it where supported, else the session lands in the
  // active space (best-effort, same degradation as widget placement).
  spaceId?: string
```

No change to `spawnSession`'s body is needed — it already spreads `...opts` into the POST body, so `spaceId` is forwarded automatically.

- [ ] **Step 4: Add the supervisor brief builder**

Create `src/supervisor.ts`:

```typescript
import type { Chart } from "./types"

// The kickoff prompt for a chart's supervisor session. It points the agent at
// the control API and names the gates it MAY resolve (decider:"agent"), with an
// explicit prohibition on human gates.
export function buildSupervisorBrief(chart: Chart, apiBase: string): string {
  const agentGates = chart.nodes.filter((n) => n.decider === "agent").map((n) => n.id)
  return [
    `You are the SUPERVISOR for the whoachart chart "${chart.name}". You oversee its runs end-to-end.`,
    chart.supervisor?.brief ?? "",
    ``,
    `Watch the run:`,
    `  GET ${apiBase}/api/charts/${chart.name}/state`,
    `  GET ${apiBase}/api/charts/${chart.name}/marbles`,
    `Inspect topology and which gates are yours (each node's "decider"):`,
    `  GET ${apiBase}/api/charts/${chart.name}/def`,
    ``,
    `You MAY resolve ONLY gates whose node has decider:"agent"${agentGates.length ? ` (currently: ${agentGates.join(", ")})` : ""}.`,
    `For such a blocked marble, choose an outgoing edge and signal:`,
    `  curl -X POST ${apiBase}/api/charts/${chart.name}/marbles/<id>/signal -H 'Content-Type: application/json' -d '{"next":"<edge>","merge":{}}'`,
    `NEVER signal a gate whose decider is "human" or unset — leave those for a person.`,
    `Surface stuck or failed marbles. Do not author or edit the chart.`,
  ].filter(Boolean).join("\n")
}
```

- [ ] **Step 5: Wire the supervisor into the daemon**

In `src/daemon.ts`, add the import:

```typescript
import { buildSupervisorBrief } from "./supervisor"
```

Add to `DaemonOpts` (after `clock?: Clock`):

```typescript
  // Tinstar space NAME for supervisor sessions (WHOACHART_AGENT_SPACE) — distinct
  // from `space` (widgets). Resolved to an id once at start; unset → active space.
  agentSpace?: string
```

Add private fields to `Daemon` (near `private supervisors`):

```typescript
  private supervisors = new Map<string, string>() // chart -> supervisor session name
  private agentSpaceId?: string
```

In `start()`, after the existing `space` resolution block, resolve the agent space:

```typescript
    // Resolve the supervisor-session space once (best-effort; unset/unresolvable
    // → sessions land in Tinstar's active space).
    if (this.opts.agentSpace) {
      this.agentSpaceId = (await this.opts.client.ensureSpace(this.opts.agentSpace)) ?? undefined
    }
```

Add `ensureSupervisor` + `stopSupervisor` (after `ensureWidgetLoop`):

```typescript
  // Keep one long-lived supervisor session per chart that has a `supervisor:`
  // block. Tolerates Tinstar being down: logs and retries on a timer, never
  // crashes the daemon (mirrors ensureWidgetLoop). No-op without a launcher.
  private ensureSupervisor(chart: Chart, retryMs = 15_000): void {
    if (!chart.supervisor || !this.launcher) return
    if (this.supervisors.has(chart.name)) return
    const sessionName = `wc-sup-${chart.name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")
    const sup = chart.supervisor
    const attempt = (): void => {
      // Bail if the chart was deleted/replaced while a retry was pending, or a
      // prior attempt already landed the session.
      if (!this.runtimes.has(chart.name) || this.supervisors.has(chart.name)) return
      this.launcher!.spawnSession({
        name: sessionName,
        prompt: buildSupervisorBrief(chart, this.baseUrl),
        project: sup.project,
        cliTemplate: sup.cli_template,
        spaceId: this.agentSpaceId,
      }).then(
        () => { this.supervisors.set(chart.name, sessionName); logLine(chart.name, `supervisor spawned name=${sessionName}`) },
        (err) => {
          logLine(chart.name, `supervisor spawn failed (${String(err).split("\n")[0]}); retrying in ${retryMs / 1000}s`)
          const t = setTimeout(attempt, retryMs)
          ;(t as unknown as { unref?: () => void }).unref?.()
        },
      )
    }
    attempt()
  }

  // Stop a chart's supervisor session (delete path). Fire-and-forget; a rejecting
  // launcher must not surface as an unhandled rejection.
  private stopSupervisor(name: string): void {
    const session = this.supervisors.get(name)
    if (!session || !this.launcher) return
    this.supervisors.delete(name)
    void this.launcher.stopSession(session).catch((err) =>
      logLine(name, `supervisor stop failed for ${session}: ${String(err).split("\n")[0]}`),
    )
  }
```

In `installRuntime`, ensure the supervisor alongside triggers:

```typescript
    this.ensureWidgetLoop(chart)
    this.armTriggers(chart)
    this.ensureSupervisor(chart)
    return rt
```

In `deleteChart`, stop the supervisor next to the scheduler disarm:

```typescript
      this.runtimes.delete(name)
      this.scheduler.disarm(name)
      this.stopSupervisor(name)
```

> Note (v1 scope, from the spec's Open Questions): hot-reload (`updateChart`) does NOT touch the supervisor — an existing supervisor keeps running across a reload (it polls the API, so topology changes are fine). Adding or removing a `supervisor:` block takes effect on the next register/boot, not mid-reload.

- [ ] **Step 6: Read `WHOACHART_AGENT_SPACE` in main**

In `src/main.ts`, add to the `new Daemon({ ... })` options (after the `space:` line):

```typescript
    // Supervisor sessions land in this Tinstar space (distinct from `space`,
    // which is widgets only). Unset → Tinstar's active space.
    agentSpace: process.env.WHOACHART_AGENT_SPACE || undefined,
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/supervisor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Run the full suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tinstar.ts src/supervisor.ts src/daemon.ts src/main.ts tests/supervisor.test.ts
git commit -m "feat(daemon): per-chart supervisor session in a designated agent space

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Documentation + example chart

**Files:**
- Modify: `README.md`
- Create: `examples/automation-demo.yaml`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add an example chart exercising the new surface**

Create `examples/automation-demo.yaml`:

```yaml
# examples/automation-demo.yaml
#
# Demonstrates the automation surface: a cron schedule, an interval, a webhook,
# a supervisor session, and an agent-decided routing gate.
#
#   Cron:     fires the scan weekday mornings.
#   Interval: a lightweight heartbeat every 30m.
#   Webhook:  POST /api/hooks/automation-demo/poke  (tailnet-internal).
#   Supervisor: one session oversees runs and resolves the `route` gate
#               (decider: agent); the `approve` gate stays human.
name: automation-demo
triggers:
  - { cron: "0 9 * * 1-5", start: scan, context: { reason: "morning" } }
  - { every: 30m, start: scan, context: { reason: "heartbeat" } }
  - { webhook: poke, start: scan }
supervisor:
  brief: |
    Oversee this chart. Resolve the `route` gate by choosing the edge that
    matches the marble's context. Leave `approve` to a human.
  project: whoachart
nodes:
  - id: scan
    type: source
    config:
      trigger: api
      form:
        - { key: reason, type: text }
  - id: route
    type: human
    name: Route (agent-decided)
    decider: agent
    config: {}
  - id: approve
    type: human
    name: Approve (human-only)
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: route }
  - { from: route, to: approve, name: escalate }
  - { from: route, to: done, name: ignore }
  - { from: approve, to: done, name: ok }
```

- [ ] **Step 2: Document the automation surface in the README**

Add a section to `README.md` after the existing chart-registration material (match the README's existing heading style and prose voice):

```markdown
## Triggers, registration, and supervisors

Charts can be stored anywhere and registered with a running daemon, and can fire
themselves on a schedule, on a webhook, or be overseen by an agent.

**Register a chart from anywhere** (symlinked into the store dir, survives restart):

    curl -X POST http://localhost:5330/api/charts \
      -H 'Content-Type: application/json' -d '{"path":"/abs/path/to/chart.yaml"}'

(Registration is loopback-only. A raw-YAML body still registers by value.)

**Triggers** are a top-level block. Each entry binds a source node to a schedule
or webhook; cron/interval context and webhook bodies are validated against the
source's form:

    triggers:
      - { cron: "0 9 * * 1-5", start: scan }     # 5-field cron, local time
      - { every: 15m, start: scan }              # interval: <n>s|m|h
      - { webhook: poke, start: scan }           # POST /api/hooks/<chart>/poke

Schedules are in-process and fire-forward (missed ticks while the daemon was down
are not replayed). Webhooks are tailnet-internal (loopback + Tailscale peers).

**Supervisor** — an optional long-lived agent that oversees a chart's runs. It
resolves only gates marked `decider: agent` and never touches `decider: human`
gates. Set `WHOACHART_AGENT_SPACE` to confine supervisor sessions to a Tinstar
space.

    supervisor:
      brief: "Resolve routing gates; leave approvals to a human."
    nodes:
      - { id: route, type: human, decider: agent, config: {} }
```

- [ ] **Step 3: Verify the example chart parses**

Run: `bun test`
Expected: PASS (no test references the example; this confirms nothing else broke). Optionally sanity-check parsing in a scratch REPL if desired.

- [ ] **Step 4: Commit**

```bash
git add README.md examples/automation-demo.yaml
git commit -m "docs: document triggers, register-by-path, and supervisors + example chart

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| §1 Trigger model (top-level `triggers:`) | Task 1 (parse), Task 4 (cron/every fire), Task 5 (webhook fire) |
| §2 Register-anywhere (symlink, A1) + write-through | Task 2 |
| §3 Cron scheduler (B1: 5-field + `every`), fire-forward | Task 3 (evaluator), Task 4 (wiring) |
| §4 Webhook API (tailnet-internal, 202, form-validated) | Task 5 |
| §5 Supervisor + `decider` marking + `WHOACHART_AGENT_SPACE` | Task 1 (`decider`/`supervisor` parse), Task 6 (`decider` in `/def`), Task 7 (session lifecycle) |
| §6 Lifecycle/security/audit | Tasks 2/4/5/7 (loopback vs trust gate; `mutate()`; `runtimes.has` guards; `logLine` audit) |
| Success criteria (restart survival, schedule re-arm, 202, decider boundary, serialization) | Tasks 2 (restart), 4 (re-arm via `armTriggers` in `updateChart`), 5 (202), 7 (decider boundary in brief), all (mutate) |

No spec requirement is without a task.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Every code step shows full code; every test step shows full assertions.

**3. Type consistency check:**
- `ChartTrigger`/`SupervisorSpec`/`ChartNode.decider` defined in Task 1 are consumed verbatim in Tasks 4/5/7.
- `Scheduler.arm(chart, triggers, fire)` / `disarm` / `disarmAll` defined in Task 4 match their daemon call sites.
- `Clock`/`realClock`/`FakeClock.advance(ms)` consistent across Task 4 (scheduler, fakes, daemon opts).
- `fireWebhook(name, hookId, body)` defined and called consistently in Task 5.
- `buildSupervisorBrief(chart, apiBase)` (Task 7) matches `src/supervisor.ts` export.
- `ChartStore.link()` returns the symlink path used as `installRuntime`'s `file` arg; `writeTarget()` is a free export used in `updateChart` — consistent (Task 2).
- `SpawnSessionOpts.spaceId` (Task 7) forwarded by the existing `...opts` spread in `TinstarClient.spawnSession` — verified against current source.

**Open design forks (deferred to implementer judgment, per the spec's Open Questions):** symlink write-through is implemented (Task 2 chose write-through); cron is 5-field with dom/dow AND-ed (documented simplification in `src/cron.ts`); webhook body is pass-through; supervisor respawn reuses the 15s widget cadence; one supervisor per chart. Any of these can be revisited without restructuring the plan.
