# whoachart Agent Linking (Plan 2b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chart node of type `agent` spawns a real Tinstar agent session (with a generated narrow brief), the marble blocks at that node (shown with an agent face on the canvas), and when the agent signals done — naming the next edge via the control API — the marble resumes and the session is torn down.

**Architecture:** The engine gains `signal(marbleId, {next?, merge?})`, which re-enqueues a blocked marble with a pending result that substitutes for the node activity. The `agent` node type is a *factory* (`makeAgentNode(launcher, signalUrlFor)`) so the session launcher is injectable — tests use a fake; production uses `TinstarClient`, which gains `spawnSession`/`stopSession`. The daemon registers the agent node, exposes `signal()`, and stops the session after the signal (unless `keep_session: true`). The view marks blocked marbles with a pulsing agent face.

**Tech Stack:** Same as Plans 1/2a — TypeScript on Bun, zod, no new dependencies.

**Out of scope (explicit):** LLM evaluator, native Tinstar plugin widget, NATS intake, drawn node→session arrows (needs a Tinstar connector primitive).

**Spec:** `docs/superpowers/specs/2026-06-08-whoachart-tinstar-overhaul-design.md` §9.

**Tinstar facts (verified earlier):** `POST /api/sessions` creates a session; the kickoff prompt MUST be in the creation body (`prompt` field) — a separate prompt POST races boot and drops. `POST /api/sessions/:name/stop` stops one. Session names cannot contain dots; stick to `[a-z0-9-]`. `cliTemplate: "Claude (multi-agent)"` enables NATS; plain sessions omit it. `color` associates the session visually.

---

## File Structure

| File | Change |
|---|---|
| `src/engine.ts` | Add `pendingSignals` map + public `signal()`; `step()` consumes a pending signal instead of running the node. |
| `src/tinstar.ts` | Add `SessionLauncher` interface + `SpawnSessionOpts`; `TinstarClient` implements it. |
| `src/nodeTypes/agent.ts` | New: `makeAgentNode(launcher, signalUrlFor)` + `buildBrief`. |
| `src/daemon.ts` | Accept `launcher`, register agent node, add `signal()` (stops session unless `keep_session`). |
| `src/controlApi.ts` | Add `POST /api/charts/:name/marbles/:id/signal`. |
| `src/cli.ts` | Add `signal` command. |
| `src/view/render.ts` | Agent face + pulse on blocked marbles. |
| `src/main.ts` | Pass the client as launcher. |
| `examples/agent-review.yaml` | Worked agent chart. |
| `tests/*` | Per-module tests + e2e. |

---

## Task 1: Engine signal support

**Files:**
- Modify: `src/engine.ts`
- Test: `tests/engineSignal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/engineSignal.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import { Engine, newMarble } from "../src/engine"
import { MarbleStore } from "../src/store"
import { registerBuiltins } from "../src/nodeTypes"
import { clearRegistry, registerNodeType } from "../src/registry"
import type { Chart } from "../src/types"

beforeEach(() => {
  clearRegistry()
  registerBuiltins()
  // a node type that blocks (stand-in for an agent step)
  registerNodeType({
    type: "waiter",
    configSchema: z.object({}).passthrough(),
    run: async () => ({ block: true }),
  })
})

function store() { return new MarbleStore(join(tmpdir(), "wc-sig-" + crypto.randomUUID().slice(0, 8))) }

const chart: Chart = {
  name: "sig",
  nodes: [
    { id: "wait", type: "waiter", config: {} },
    { id: "ok", type: "end", config: { outcome: "success" } },
    { id: "bad", type: "end", config: { outcome: "fail" } },
  ],
  edges: [
    { from: "wait", to: "ok", name: "pass" },
    { from: "wait", to: "bad", name: "fail" },
  ],
}

test("marble blocks, then signal(next) resumes it along the named edge", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("sig", "wait")
  await eng.submit(m); await eng.drain()
  expect((await st.load(m.id))?.status).toBe("blocked")

  await eng.signal(m.id, { next: "pass", merge: { verdict: "looks good" } })
  await eng.drain()
  const f = await st.load(m.id)
  expect(f?.status).toBe("done")
  expect(f?.node).toBe("ok")
  expect(f?.context.verdict).toBe("looks good")
})

test("signal on a non-blocked marble throws", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  const m = newMarble("sig", "wait")
  await eng.submit(m); await eng.drain()
  await eng.signal(m.id, { next: "pass" })
  await eng.drain()
  await expect(eng.signal(m.id, { next: "pass" })).rejects.toThrow(/not blocked/)
})

test("signal on an unknown marble throws", async () => {
  const st = store(); await st.init()
  const eng = new Engine({ chart, store: st })
  await expect(eng.signal("nope", {})).rejects.toThrow(/unknown marble/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/engineSignal.test.ts`
Expected: FAIL — `eng.signal is not a function`.

- [ ] **Step 3: Implement**

In `src/engine.ts`:

(a) Add a field next to `inFlight`:

```ts
  private inFlight = new Set<string>()
  private pendingSignals = new Map<string, NodeResult>()
```

(b) Add a public method after `resume()`:

```ts
  // Resume a blocked marble with an externally supplied result (e.g. an agent
  // signaling done). The pending result substitutes for the node activity on
  // the next step, so routing/hooks/persistence all run the normal path.
  async signal(id: string, sig: { next?: string; merge?: Record<string, unknown> } = {}): Promise<void> {
    const m = await this.opts.store.load(id)
    if (!m) throw new Error(`unknown marble: ${id}`)
    if (m.status !== "blocked") throw new Error(`marble ${id} is not blocked (status: ${m.status})`)
    this.pendingSignals.set(id, { next: sig.next, merge: sig.merge })
    m.status = "queued"
    await this.persist(m)
    this.enqueue(m)
  }
```

(c) In `step()`, replace the line

```ts
      const result = await this.execNode(node, m)
```

with

```ts
      const pending = this.pendingSignals.get(m.id)
      let result: NodeResult
      if (pending) {
        this.pendingSignals.delete(m.id)
        result = pending
      } else {
        result = await this.execNode(node, m)
      }
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/engineSignal.test.ts` → PASS (3 pass). Then `bun test` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts tests/engineSignal.test.ts
git commit -m "feat: engine signal() resumes blocked marbles with an external result"
```

---

## Task 2: Session launcher on the Tinstar client

**Files:**
- Modify: `src/tinstar.ts`
- Test: `tests/tinstarSessions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tinstarSessions.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { TinstarClient } from "../src/tinstar"

let server: ReturnType<typeof Bun.serve>
let base: string
let calls: { method: string; path: string; body: any }[] = []

beforeEach(() => {
  calls = []
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => null) : null
      calls.push({ method: req.method, path: url.pathname, body })
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        return Response.json({ ok: true, data: { name: (body as any).name } })
      }
      if (req.method === "POST" && /^\/api\/sessions\/[^/]+\/stop$/.test(url.pathname)) {
        return Response.json({ ok: true })
      }
      return new Response("nope", { status: 404 })
    },
  })
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("spawnSession POSTs name + prompt in the CREATION body (no separate prompt call)", async () => {
  const c = new TinstarClient(base)
  const ref = await c.spawnSession({ name: "wc-demo-m1", prompt: "do the thing", color: "#a78bfa" })
  expect(ref.name).toBe("wc-demo-m1")
  const post = calls.find((c) => c.path === "/api/sessions")!
  expect(post.body.name).toBe("wc-demo-m1")
  expect(post.body.prompt).toBe("do the thing")
  expect(post.body.color).toBe("#a78bfa")
  // exactly one call — kickoff prompt must ride the creation request
  expect(calls).toHaveLength(1)
})

test("spawnSession sanitizes dots out of the session name", async () => {
  const c = new TinstarClient(base)
  const ref = await c.spawnSession({ name: "wc.demo.M1", prompt: "x" })
  expect(ref.name).toBe("wc-demo-m1")
})

test("stopSession hits the stop endpoint and survives errors", async () => {
  const c = new TinstarClient(base)
  await c.stopSession("wc-demo-m1")
  expect(calls.some((c) => c.path === "/api/sessions/wc-demo-m1/stop")).toBe(true)
  await c.stopSession("missing/${weird}") // must not throw even if server 404s
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tinstarSessions.test.ts`
Expected: FAIL — `spawnSession is not a function`.

- [ ] **Step 3: Implement**

In `src/tinstar.ts`, add after the `ArtifactSink` interface:

```ts
export interface SpawnSessionOpts {
  name: string
  prompt: string
  color?: string
  project?: string
  cliTemplate?: string
  worktree?: boolean
}

// Minimal surface for spawning/stopping agent sessions — injectable for tests.
export interface SessionLauncher {
  spawnSession(opts: SpawnSessionOpts): Promise<{ name: string }>
  stopSession(name: string): Promise<void>
}
```

Change the class declaration to implement both:

```ts
export class TinstarClient implements ArtifactSink, SessionLauncher {
```

Add the methods inside the class:

```ts
  async spawnSession(opts: SpawnSessionOpts): Promise<{ name: string }> {
    // tmux reads "." as a pane separator — session names must be [a-z0-9-]
    const name = opts.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The kickoff prompt MUST be in the creation request — a separate
      // prompt POST races CLI boot and is silently dropped.
      body: JSON.stringify({ ...opts, name, backend: "tmux" }),
    })
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok || body?.ok === false) {
      throw new Error(`spawnSession failed: ${res.status} ${JSON.stringify(body)}`)
    }
    return { name }
  }

  async stopSession(name: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(name)}/stop`, {
      method: "POST",
    }).catch(() => {})
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/tinstarSessions.test.ts` → PASS (3 pass). Then `bun test` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/tinstar.ts tests/tinstarSessions.test.ts
git commit -m "feat: tinstar session launcher — spawn with kickoff prompt, stop"
```

---

## Task 3: `agent` node type

**Files:**
- Create: `src/nodeTypes/agent.ts`
- Test: `tests/agentNode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agentNode.test.ts
import { test, expect } from "bun:test"
import { makeAgentNode, buildBrief } from "../src/nodeTypes/agent"
import type { SessionLauncher, SpawnSessionOpts } from "../src/tinstar"
import type { RunCtx, Marble, ChartNode } from "../src/types"

class FakeLauncher implements SessionLauncher {
  spawned: SpawnSessionOpts[] = []
  stopped: string[] = []
  async spawnSession(opts: SpawnSessionOpts) { this.spawned.push(opts); return { name: opts.name } }
  async stopSession(name: string) { this.stopped.push(name) }
}

const node: ChartNode = {
  id: "review", type: "agent", name: "Review", color: "#a78bfa",
  config: { brief: "Review the draft for factual errors." },
}

function ctx(): RunCtx {
  const marble: Marble = {
    id: "m1", chart: "content", node: "review", context: { stage: "drafted" },
    workpiece: "/tmp/post.md", history: ["review"], status: "running", createdAt: "t", updatedAt: "t",
  }
  return {
    chart: { name: "content", nodes: [node], edges: [] },
    marble, node,
    outgoing: [
      { from: "review", to: "edit", name: "pass" },
      { from: "review", to: "revise", name: "revise" },
    ],
  }
}

test("agent node spawns a session and blocks the marble", async () => {
  const launcher = new FakeLauncher()
  const agent = makeAgentNode(launcher, (m) => `http://x/api/charts/${m.chart}/marbles/${m.id}/signal`)
  const r = await agent.run(ctx())
  expect(r.block).toBe(true)
  expect(launcher.spawned).toHaveLength(1)
  expect(launcher.spawned[0].name).toBe("wc-content-m1")
  expect(launcher.spawned[0].color).toBe("#a78bfa") // node color rides along
  expect((r.merge as any)._session).toBe("wc-content-m1")
})

test("the brief tells the agent its job, the edges, and how to signal", async () => {
  const launcher = new FakeLauncher()
  const agent = makeAgentNode(launcher, (m) => `http://x/api/charts/${m.chart}/marbles/${m.id}/signal`)
  await agent.run(ctx())
  const brief = launcher.spawned[0].prompt
  expect(brief).toContain("Review the draft for factual errors.")
  expect(brief).toContain("/tmp/post.md")          // workpiece
  expect(brief).toContain("pass")                   // edge names
  expect(brief).toContain("revise")
  expect(brief).toContain("http://x/api/charts/content/marbles/m1/signal")
  expect(brief).toContain('"stage":"drafted"')     // context rides along
})

test("buildBrief lists edges and signal curl", () => {
  const m: Marble = { id: "m2", chart: "c", node: "n", context: {}, history: ["n"], status: "running", createdAt: "t", updatedAt: "t" }
  const b = buildBrief(m, node, "Do X.", ["a", "b"], "http://sig")
  expect(b).toContain("Do X.")
  expect(b).toContain("a, b")
  expect(b).toContain("curl -X POST http://sig")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agentNode.test.ts`
Expected: FAIL — cannot find `../src/nodeTypes/agent`.

- [ ] **Step 3: Implement**

```ts
// src/nodeTypes/agent.ts
import { z } from "zod"
import type { NodeType } from "../registry"
import type { SessionLauncher } from "../tinstar"
import type { Marble, ChartNode } from "../types"

export function buildBrief(
  marble: Marble,
  node: ChartNode,
  job: string,
  edges: string[],
  signalUrl: string,
): string {
  return [
    `You are an automated specialist working ONE step of a whoachart flow.`,
    `Work item (marble): ${marble.id} on chart "${marble.chart}", at step "${node.name ?? node.id}".`,
    marble.workpiece ? `Workpiece: ${marble.workpiece}` : "",
    `Context so far: ${JSON.stringify(marble.context)}`,
    ``,
    `Your job (do ONLY this): ${job}`,
    ``,
    `When finished, choose the next edge — one of: ${edges.join(", ")} — and signal completion:`,
    `  curl -X POST ${signalUrl} -H 'Content-Type: application/json' -d '{"next":"<edge>","merge":{"<key>":"<your findings>"}}'`,
    `Use "merge" to hand findings to later steps. Your session may be stopped after you signal.`,
  ].filter(Boolean).join("\n")
}

// Factory: the launcher and signal-URL builder are injected so tests use a
// fake and production uses TinstarClient.
export function makeAgentNode(
  launcher: SessionLauncher,
  signalUrlFor: (m: Marble) => string,
): NodeType {
  return {
    type: "agent",
    configSchema: z.object({
      brief: z.string(),
      cli_template: z.string().optional(),
      project: z.string().optional(),
      keep_session: z.boolean().default(false),
    }),
    async run(ctx) {
      const cfg = ctx.node.config as { brief: string; cli_template?: string; project?: string }
      const edges = ctx.outgoing.map((e) => e.name ?? e.to)
      const name = `wc-${ctx.marble.chart}-${ctx.marble.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")
      const { name: sessionName } = await launcher.spawnSession({
        name,
        prompt: buildBrief(ctx.marble, ctx.node, cfg.brief, edges, signalUrlFor(ctx.marble)),
        color: ctx.node.color,
        project: cfg.project,
        cliTemplate: cfg.cli_template,
      })
      // _session is reserved in context: the live session working this marble.
      return { block: true, merge: { _session: sessionName } }
    },
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/agentNode.test.ts` → PASS (3 pass). Then `bun test` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/nodeTypes/agent.ts tests/agentNode.test.ts
git commit -m "feat: agent node type — spawn session with generated brief, block marble"
```

---

## Task 4: Daemon integration (register agent, signal, session teardown)

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/main.ts`
- Test: `tests/daemonAgent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/daemonAgent.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import type { ArtifactRef, ArtifactPlacement, ArtifactSink, SessionLauncher, SpawnSessionOpts } from "../src/tinstar"
import { clearRegistry } from "../src/registry"

class FakeSink implements ArtifactSink {
  async postArtifact(_h: string, _p?: ArtifactPlacement): Promise<ArtifactRef> { return { artifactId: "a", widgetId: "w" } }
  async putArtifact(): Promise<boolean> { return true }
  async deleteArtifact(): Promise<void> {}
}
class FakeLauncher implements SessionLauncher {
  spawned: SpawnSessionOpts[] = []
  stopped: string[] = []
  async spawnSession(o: SpawnSessionOpts) { this.spawned.push(o); return { name: o.name } }
  async stopSession(n: string) { this.stopped.push(n) }
}

const CHART = `
name: agency
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: review
    type: agent
    name: Review
    config: { brief: "Review it." }
  - id: ok
    type: end
    config: { outcome: success }
  - id: bad
    type: end
    config: { outcome: fail }
edges:
  - { from: ingest, to: review }
  - { from: review, to: ok, name: pass }
  - { from: review, to: bad, name: fail }
`

beforeEach(() => clearRegistry())

async function makeDaemon(launcher: FakeLauncher) {
  const dir = await mkdtemp(join(tmpdir(), "wc-da-"))
  const path = join(dir, "agency.yaml")
  await writeFile(path, CHART)
  const d = new Daemon({
    charts: [path],
    storeDir: join(dir, "store"),
    client: new FakeSink(),
    launcher,
    baseUrl: "http://localhost:5330",
  })
  await d.start()
  return d
}

test("marble blocks at the agent node with a spawned session", async () => {
  const launcher = new FakeLauncher()
  const d = await makeDaemon(launcher)
  const m = await d.submit("agency", {})
  await new Promise((r) => setTimeout(r, 250))
  const blocked = await d.marble("agency", m.id)
  expect(blocked?.status).toBe("blocked")
  expect(blocked?.node).toBe("review")
  expect(launcher.spawned).toHaveLength(1)
  expect(launcher.spawned[0].prompt).toContain("http://localhost:5330/api/charts/agency/marbles/" + m.id + "/signal")
})

test("signal resumes the marble and stops the session", async () => {
  const launcher = new FakeLauncher()
  const d = await makeDaemon(launcher)
  const m = await d.submit("agency", {})
  await new Promise((r) => setTimeout(r, 250))
  await d.signal("agency", m.id, { next: "pass", merge: { verdict: "ship it" } })
  await new Promise((r) => setTimeout(r, 250))
  const f = await d.marble("agency", m.id)
  expect(f?.status).toBe("done")
  expect(f?.node).toBe("ok")
  expect(f?.context.verdict).toBe("ship it")
  expect(launcher.stopped).toEqual([launcher.spawned[0].name])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/daemonAgent.test.ts`
Expected: FAIL — daemon does not accept `launcher` / `signal` missing / chart fails to parse (unknown node type: agent).

- [ ] **Step 3: Implement**

In `src/daemon.ts`:

(a) Update imports:

```ts
import { registerBuiltins } from "./nodeTypes"
import { makeAgentNode } from "./nodeTypes/agent"
import { hasNodeType, registerNodeType } from "./registry"
```

and the tinstar import line:

```ts
import type { ArtifactSink, SessionLauncher } from "./tinstar"
```

(b) Extend `DaemonOpts`:

```ts
export interface DaemonOpts {
  charts: string[]
  storeDir: string
  client: ArtifactSink
  concurrency?: number
  // Base URL the canvas page uses to poll this daemon (its own origin).
  baseUrl?: string
  // Spawns/stops agent sessions; defaults to a launcher that errors, so charts
  // without agent nodes work with no launcher configured.
  launcher?: SessionLauncher
}
```

(c) At the top of `start()`, replace

```ts
    if (!hasNodeType("end")) registerBuiltins()
```

with

```ts
    if (!hasNodeType("end")) registerBuiltins()
    const baseUrl = this.opts.baseUrl ?? "http://localhost:5330"
    if (!hasNodeType("agent")) {
      const launcher: SessionLauncher = this.opts.launcher ?? {
        spawnSession: async () => { throw new Error("no session launcher configured (agent nodes need one)") },
        stopSession: async () => {},
      }
      registerNodeType(makeAgentNode(launcher, (m) => `${baseUrl}/api/charts/${m.chart}/marbles/${m.id}/signal`))
    }
```

and change the per-chart `const baseUrl = this.opts.baseUrl ?? "http://localhost:5330"` line inside the loop to reuse the variable (delete the duplicate declaration; keep `const stateUrl = ...`).

(d) Add after `marble()`:

```ts
  // Resume a blocked marble (agent done / external decision). Stops the
  // marble's agent session unless the node opts into keep_session.
  async signal(name: string, id: string, sig: { next?: string; merge?: Record<string, unknown> } = {}): Promise<void> {
    const rt = this.rt(name)
    const before = await rt.store.load(id)
    await rt.engine.signal(id, sig)
    const session = before?.context._session
    if (typeof session === "string" && session && this.opts.launcher) {
      const node = rt.chart.nodes.find((n) => n.id === before!.node)
      const keep = node?.type === "agent" && (node.config as any).keep_session === true
      if (!keep) void this.opts.launcher.stopSession(session)
    }
  }
```

In `src/main.ts`, pass the client as the launcher (TinstarClient implements both):

```ts
  const client = new TinstarClient(tinstarUrl)
  const daemon = new Daemon({
    charts,
    storeDir,
    client,
    launcher: client,
    baseUrl: `http://localhost:${port}`,
  })
```

(replacing the existing `new Daemon({...})` construction).

- [ ] **Step 4: Run tests**

Run: `bun test tests/daemonAgent.test.ts` → PASS (2 pass). Then `bun test` → all green (note: `tests/daemon.test.ts` and `tests/controlApi.test.ts` call `clearRegistry()` + `registerBuiltins()` in their own beforeEach — the daemon's `hasNodeType("agent")` guard re-registers the agent node per fresh registry, so no collisions).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts src/main.ts tests/daemonAgent.test.ts
git commit -m "feat: daemon wires agent node — launcher injection, signal, session teardown"
```

---

## Task 5: Control API signal route + CLI signal command

**Files:**
- Modify: `src/controlApi.ts`
- Modify: `src/cli.ts`
- Test: `tests/controlApiSignal.test.ts`, additions to `tests/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/controlApiSignal.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import type { ArtifactRef, ArtifactPlacement, ArtifactSink, SessionLauncher, SpawnSessionOpts } from "../src/tinstar"
import { clearRegistry } from "../src/registry"

class FakeSink implements ArtifactSink {
  async postArtifact(_h: string, _p?: ArtifactPlacement): Promise<ArtifactRef> { return { artifactId: "a", widgetId: "w" } }
  async putArtifact(): Promise<boolean> { return true }
  async deleteArtifact(): Promise<void> {}
}
class FakeLauncher implements SessionLauncher {
  async spawnSession(o: SpawnSessionOpts) { return { name: o.name } }
  async stopSession(_n: string) {}
}

const CHART = `
name: agency
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: review
    type: agent
    config: { brief: "Review it." }
  - id: ok
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: review }
  - { from: review, to: ok, name: pass }
`

let server: ReturnType<typeof Bun.serve>
let base: string

beforeEach(async () => {
  clearRegistry()
  const dir = await mkdtemp(join(tmpdir(), "wc-sigapi-"))
  const path = join(dir, "agency.yaml")
  await writeFile(path, CHART)
  const daemon = new Daemon({ charts: [path], storeDir: join(dir, "store"), client: new FakeSink(), launcher: new FakeLauncher() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("POST .../signal resumes a blocked marble", async () => {
  const sub = await fetch(`${base}/api/charts/agency/marbles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  const { id } = (await sub.json()) as any
  await new Promise((r) => setTimeout(r, 250)) // let it reach the agent node

  const res = await fetch(`${base}/api/charts/agency/marbles/${id}/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ next: "pass", merge: { verdict: "ok" } }),
  })
  expect(res.status).toBe(200)
  await new Promise((r) => setTimeout(r, 250))
  const m = (await (await fetch(`${base}/api/charts/agency/marbles/${id}`)).json()) as any
  expect(m.status).toBe("done")
  expect(m.context.verdict).toBe("ok")
})

test("signaling a non-blocked marble returns 400", async () => {
  const res = await fetch(`${base}/api/charts/agency/marbles/nope/signal`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })
  expect(res.status).toBe(400)
})
```

Append to `tests/cli.test.ts`:

```ts
test("parses signal command with next and merge", () => {
  const a = parseArgs(["signal", "agency", "m1", "--next", "pass", "--merge", '{"v":1}'])
  expect(a.cmd).toBe("signal")
  expect(a.chart).toBe("agency")
  expect(a.marble).toBe("m1")
  expect(a.next).toBe("pass")
  expect(a.merge).toEqual({ v: 1 })
})
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/controlApiSignal.test.ts tests/cli.test.ts`
Expected: FAIL — signal route 404s; `a.marble`/`a.next`/`a.merge` undefined.

- [ ] **Step 3: Implement**

In `src/controlApi.ts`, inside the `p[3] === "marbles"` block, BEFORE the `GET single marble` branch, add:

```ts
          // POST single-marble signal
          if (req.method === "POST" && p[4] && p[5] === "signal") {
            const body = (await req.json().catch(() => ({}))) as any
            await daemon.signal(name, p[4], { next: body.next, merge: body.merge })
            return json({ ok: true })
          }
```

(Also update the route comment block to list `POST /api/charts/:name/marbles/:id/signal`.)

In `src/cli.ts`:

(a) Extend `CliArgs`:

```ts
export interface CliArgs {
  cmd: string
  chart?: string
  marble?: string
  context?: Record<string, unknown>
  merge?: Record<string, unknown>
  next?: string
  workpiece?: string
  start?: string
  port: number
}
```

(b) In `parseArgs`, after the `if (cmd === "submit" || ...)` line:

```ts
  if (cmd === "submit" || cmd === "marbles") args.chart = positional[1]
  if (cmd === "signal") { args.chart = positional[1]; args.marble = positional[2] }
  if (flags.has("next")) args.next = flags.get("next")
  if (flags.has("merge")) {
    try {
      args.merge = JSON.parse(flags.get("merge")!)
    } catch (err) {
      throw new Error(`invalid --merge JSON: ${err}`)
    }
  }
```

(c) In `main()`, add a branch before the final `else`:

```ts
  } else if (a.cmd === "signal") {
    if (!a.chart || !a.marble) throw new Error("usage: whoachart signal <chart> <marble> --next <edge> [--merge json]")
    const res = await fetch(`${base}/api/charts/${a.chart}/marbles/${a.marble}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next: a.next, merge: a.merge }),
    })
    console.log(JSON.stringify(await res.json(), null, 2))
```

and update the usage line to `"usage: whoachart <charts|submit|marbles|signal> [...]  (--port N)"`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/controlApiSignal.test.ts tests/cli.test.ts` → PASS. Then `bun test` → all green; `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/controlApi.ts src/cli.ts tests/controlApiSignal.test.ts tests/cli.test.ts
git commit -m "feat: signal endpoint and CLI command"
```

---

## Task 6: Agent face on blocked marbles

**Files:**
- Modify: `src/view/render.ts`
- Test: additions to `tests/render.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/render.test.ts`:

```ts
test("client runtime renders an agent face on blocked marbles", () => {
  const html = renderShell(chart, layoutChart(chart), STATE_URL)
  expect(html).toContain(".marble.agent")   // agent styling exists
  expect(html).toContain("face")             // face glyph creation
  expect(html).toContain("agentpulse")       // pulsing halo animation
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/render.test.ts`
Expected: FAIL on the new test.

- [ ] **Step 3: Implement**

In `src/view/render.ts`:

(a) In `CSS`, replace

```ts
.mlabel{font:700 7px monospace;fill:#06090d;pointer-events:none}
.marble{cursor:default}
```

with

```ts
.mlabel{font:700 7px monospace;fill:#06090d;pointer-events:none}
.marble{cursor:default}
.marble .face{display:none}
.marble.agent .face{display:block}
.marble.agent .mlabel{display:none}
.marble.agent>circle{animation:agentpulse 1.2s ease-in-out infinite}
@keyframes agentpulse{0%,100%{stroke-opacity:1}50%{stroke-opacity:.3}}
```

(b) In `CLIENT_JS`'s `upsert`, after the label `t` is appended (the `g.appendChild(t)` line for the label), add the face glyph creation:

```js
    const f=document.createElementNS(NS,"g"); f.setAttribute("class","face");
    const e1=document.createElementNS(NS,"circle"); e1.setAttribute("cx","-2.4"); e1.setAttribute("cy","-1"); e1.setAttribute("r","1"); e1.setAttribute("fill","#06090d"); f.appendChild(e1);
    const e2=document.createElementNS(NS,"circle"); e2.setAttribute("cx","2.4"); e2.setAttribute("cy","-1"); e2.setAttribute("r","1"); e2.setAttribute("fill","#06090d"); f.appendChild(e2);
    const sm=document.createElementNS(NS,"path"); sm.setAttribute("d","M-2.6,2 q2.6,2.4 5.2,0"); sm.setAttribute("stroke","#06090d"); sm.setAttribute("stroke-width","1"); sm.setAttribute("fill","none"); sm.setAttribute("stroke-linecap","round"); f.appendChild(sm);
    g.appendChild(f);
```

(c) Still in `upsert`, replace the class-setting line

```js
  const r=ring(status); g._c.setAttribute("stroke",r[0]); g._c.setAttribute("stroke-width",String(r[1]));
```

with

```js
  const r=ring(status); g._c.setAttribute("stroke",r[0]); g._c.setAttribute("stroke-width",String(r[1]));
  g.setAttribute("class","marble"+(status==="blocked"?" agent":""));
```

(Note `upsert` already sets `class` at creation; this line keeps it in sync per status.)

- [ ] **Step 4: Run tests**

Run: `bun test tests/render.test.ts` → PASS. Then `bun test` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/view/render.ts tests/render.test.ts
git commit -m "feat: pulsing agent face on blocked marbles"
```

---

## Task 7: Worked example + e2e

**Files:**
- Create: `examples/agent-review.yaml`
- Test: `tests/e2eAgent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/e2eAgent.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import type { ArtifactRef, ArtifactPlacement, ArtifactSink, SessionLauncher, SpawnSessionOpts } from "../src/tinstar"
import { clearRegistry } from "../src/registry"

class FakeSink implements ArtifactSink {
  async postArtifact(_h: string, _p?: ArtifactPlacement): Promise<ArtifactRef> { return { artifactId: "a", widgetId: "w" } }
  async putArtifact(): Promise<boolean> { return true }
  async deleteArtifact(): Promise<void> {}
}

// A launcher that behaves like a real agent: reads the signal URL out of its
// brief and (after a beat) signals 'approve' through the control API — the
// full round trip a Tinstar session would make.
class AutoAgent implements SessionLauncher {
  stopped: string[] = []
  async spawnSession(o: SpawnSessionOpts) {
    const url = o.prompt.match(/curl -X POST (\S+)/)?.[1]
    if (url) {
      setTimeout(() => {
        void fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ next: "approve", merge: { reviewed_by: o.name } }),
        })
      }, 150)
    }
    return { name: o.name }
  }
  async stopSession(n: string) { this.stopped.push(n) }
}

beforeEach(() => clearRegistry())

test("agent-review example: marble blocks, fake agent signals, marble ships, session stopped", async () => {
  const launcher = new AutoAgent()
  const storeDir = join(tmpdir(), "wc-e2ea-" + crypto.randomUUID().slice(0, 8))
  const daemon = new Daemon({
    charts: ["examples/agent-review.yaml"],
    storeDir,
    client: new FakeSink(),
    launcher,
    baseUrl: "PLACEHOLDER", // patched below once we know the port
  })
  // We need the control API port inside the brief — bind it first.
  // Start on port 0 via a two-phase boot: create server after daemon.start()
  // would bake the wrong URL, so instead pick a fixed ephemeral-range port.
  const port = 40000 + Math.floor(Math.random() * 1000)
  ;(daemon as any).opts.baseUrl = `http://localhost:${port}`
  await daemon.start()
  const server = createControlApi(daemon, port)
  try {
    const m = await daemon.submit("agent-review", { context: { title: "Q3 post" } })
    // wait for: reach agent node → block → auto-signal → resume → done
    let final = null as any
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100))
      final = await daemon.marble("agent-review", m.id)
      if (final?.status === "done" || final?.status === "failed") break
    }
    expect(final?.status).toBe("done")
    expect(final?.node).toBe("published")
    expect(final?.context.reviewed_by).toContain("wc-agent-review-")
    expect(launcher.stopped).toHaveLength(1)
  } finally {
    server.stop(true)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/e2eAgent.test.ts`
Expected: FAIL — `examples/agent-review.yaml` does not exist.

- [ ] **Step 3: Write the example chart**

```yaml
# examples/agent-review.yaml
# A marble carries a piece of content to a REAL agent session for review.
# The agent gets a narrow brief + the signal URL; the marble blocks (pulsing
# agent face on the canvas) until the agent signals approve/reject.
name: agent-review
nodes:
  - id: ingest
    type: source
    name: New draft
    config:
      trigger: api

  - id: prep
    type: shell
    name: Prep
    config:
      on_enter: |
        echo '{"merge":{"prepped":true}}'

  - id: review
    type: agent
    name: Expert review
    color: "#a78bfa"
    config:
      brief: >
        Review the draft described in the context. Check it for factual
        errors and tone. If acceptable, signal next=approve with a short
        merge note; otherwise signal next=reject explaining why.

  - id: published
    type: end
    name: Published
    config:
      outcome: success

  - id: rejected
    type: end
    name: Rejected
    config:
      outcome: fail

edges:
  - { from: ingest, to: prep }
  - { from: prep, to: review }
  - { from: review, to: published, name: approve }
  - { from: review, to: rejected, name: reject }
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/e2eAgent.test.ts` → PASS (1 pass). Then full `bun test` → all green; `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add examples/agent-review.yaml tests/e2eAgent.test.ts
git commit -m "feat: agent-review example and full agent round-trip e2e"
```

---

## Manual live demo (AFTER all tasks — REQUIRES USER GO-AHEAD)

Spawning a real Tinstar agent session costs tokens and creates a visible session on the canvas. Do NOT run this without the user's explicit OK. When approved:

```bash
WHOACHART_CHARTS=examples/agent-review.yaml WHOACHART_STORE=/tmp/wc-agent WHOACHART_PORT=5331 bun run src/main.ts &
bun run src/cli.ts submit agent-review --port 5331 --context '{"title":"hello world post","draft":"..."}'
# watch: marble blocks at "Expert review" with a pulsing agent face;
# a session named wc-agent-review-<id> appears on the Tinstar canvas in the node's color;
# when the agent signals, the marble resumes and the session stops.
```

---

## Self-Review

**Spec coverage (spec §9 + deferred list from Plan 2a):**
- `agent` node type spawning a real Tinstar session with a generated narrow brief → Tasks 2, 3. ✅
- Engine external-signal/resume for blocked marbles → Task 1. ✅
- Control-API signal endpoint (+ CLI) → Task 5. ✅
- Session→node visual association: session spawned with the node's `color` (Task 3); blocked marble wears a pulsing agent face (Task 6); session named `wc-<chart>-<marble>` for identification. Constellation/slot snapping of the session next to the chart widget is best-effort via color in MVP — full snap requires the session's run-node id, deferred with the native-plugin track. ⚠ partial, by design
- Session teardown on completion (`keep_session` opt-out) → Task 4. ✅
- Worked example + full round-trip e2e with a launcher that signals through the real control API → Task 7. ✅

**Placeholder scan:** the `baseUrl: "PLACEHOLDER"` string in Task 7 is immediately patched two lines later (port chosen before `daemon.start()`); it is explained inline, not an unfinished stub. No other placeholders.

**Type consistency:** `SessionLauncher`/`SpawnSessionOpts` (Task 2) consumed by `makeAgentNode` (Task 3), `Daemon` (Task 4), and tests. `engine.signal` signature `{next?, merge?}` matches `daemon.signal` and the control API body. `_session` context key written by the agent node (Task 3) is what `daemon.signal` reads (Task 4). `CliArgs.marble/next/merge` (Task 5) used by the CLI main. Existing types (`Marble`, `NodeResult`, `RunCtx`, `NodeType`) unchanged.
