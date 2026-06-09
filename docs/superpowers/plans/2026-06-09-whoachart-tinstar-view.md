# whoachart Tinstar Live View (Plan 2a) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make whoachart Tinstar-native: a long-lived daemon that loads charts, runs the marble engine, and renders each chart as ONE live, self-refreshing HTML artifact on the Tinstar canvas — with marbles shown on their nodes, updating as they flow — plus an HTTP control API and CLI to submit marbles.

**Architecture:** Build on the Plan 1 headless engine. A pure **layout** function assigns node positions; a pure **render** function turns (chart, marbles, layout) into one self-contained SVG/HTML document (nodes, edges, and marbles all in ONE SVG coordinate system, so resize scales uniformly — no drift). A **view bridge** subscribes to the engine's `onChange` snapshots, debounces, and POST/PUTs the artifact via a thin **Tinstar client**. A **daemon** wires per-chart engine+store+bridge and exposes a **control API** (Bun.serve); a thin **CLI** drives that API.

**Tech Stack:** TypeScript on Bun 1.3. `bun test`, `Bun.serve`, global `fetch`. No new dependencies (no frontend framework — server-rendered SVG).

This is **Plan 2a of the Tinstar integration**. The `agent` node type, engine external-signal/resume, and session-on-canvas linking are **Plan 2b** (explicitly out of scope here). After 2a you can run the daemon, submit marbles, and watch them flow live on the canvas using shell/decision/api nodes.

**Depends on:** Plan 1 (merged): `src/types.ts`, `src/schema.ts`, `src/registry.ts`, `src/nodeTypes/*`, `src/store.ts`, `src/engine.ts` (`Engine` accepts `onChange?: (m: Marble) => void` and delivers `structuredClone` snapshots), `src/run.ts`.

**Spec:** `docs/superpowers/specs/2026-06-08-whoachart-tinstar-overhaul-design.md` (§9 Tinstar integration).

---

## Tinstar facts the implementer needs (verified)

- Artifacts API: `POST /api/artifacts` with body `{ path, name?, sessionId?, spaceId?, color?, position?, size?, nearNodeId?, slot?, snapToSession? }` → `{ ok, data: { artifactId, widgetId } }`. The server reads the HTML from `path` (a file on disk) and opens a browser-widget. `PUT /api/artifacts/:id` with `{ path }` refreshes in place. `DELETE /api/artifacts/:id` removes it. An artifact can 404 on PUT if it was closed — then re-POST.
- Tinstar runs at `http://localhost:5273` by default. The whoachart daemon runs its OWN control API on a different port (default 5330) so the two never collide.
- There is no line/arrow API — that's why the whole chart is one artifact with edges drawn inside our SVG.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tinstar.ts` | `TinstarClient` (implements `ArtifactSink`): write HTML to a temp file and POST/PUT/DELETE artifacts. |
| `src/view/layout.ts` | `layoutChart(chart) -> Layout` — pure: assign each node a box `{x,y,w,h}` by BFS rank. |
| `src/view/render.ts` | `renderChart(chart, marbles, layout) -> string` — pure: one self-contained SVG/HTML doc. |
| `src/view/bridge.ts` | `ViewBridge` — holds current marbles, debounced render, POST/PUT via the sink, re-POST on 404. |
| `src/daemon.ts` | `Daemon` — per-chart engine+store+bridge; `start/charts/submit/marbles/marble`. |
| `src/controlApi.ts` | `createControlApi(daemon, port)` — `Bun.serve` HTTP routes for intake + queries. |
| `src/cli.ts` | Thin CLI over the control API (`submit`, `charts`, `marbles`) + `parseArgs` helper. |
| `src/main.ts` | Daemon entry point (reads env/args, starts `Daemon` + control API). |
| `tests/*.test.ts` | One test file per module. |

---

## Task 1: Tinstar client

**Files:**
- Create: `src/tinstar.ts`
- Test: `tests/tinstar.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tinstar.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { readFile } from "node:fs/promises"
import { TinstarClient } from "../src/tinstar"

let server: ReturnType<typeof Bun.serve>
let base: string
let lastBody: any = null

beforeEach(() => {
  lastBody = null
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname === "/api/artifacts") {
        lastBody = await req.json()
        return Response.json({ ok: true, data: { artifactId: "eph-1", widgetId: "browser-1" } })
      }
      if (req.method === "PUT" && url.pathname === "/api/artifacts/eph-1") {
        lastBody = await req.json()
        return Response.json({ ok: true, data: { artifactId: "eph-1", rev: 2 } })
      }
      if (req.method === "PUT" && url.pathname === "/api/artifacts/gone") {
        return Response.json({ ok: false, error: { code: "NOT_FOUND" } }, { status: 404 })
      }
      if (req.method === "DELETE") return Response.json({ ok: true })
      return new Response("nope", { status: 404 })
    },
  })
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("postArtifact writes html to a file and returns ids", async () => {
  const c = new TinstarClient(base)
  const ref = await c.postArtifact("<h1>hello</h1>", { name: "x" })
  expect(ref.artifactId).toBe("eph-1")
  expect(ref.widgetId).toBe("browser-1")
  // server received a path; the file at that path holds our html
  expect(lastBody.name).toBe("x")
  expect(await readFile(lastBody.path, "utf8")).toContain("hello")
})

test("putArtifact returns true on success", async () => {
  const c = new TinstarClient(base)
  expect(await c.putArtifact("eph-1", "<p>upd</p>")).toBe(true)
})

test("putArtifact returns false on 404 (artifact gone)", async () => {
  const c = new TinstarClient(base)
  expect(await c.putArtifact("gone", "<p>x</p>")).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tinstar.test.ts`
Expected: FAIL — cannot find `../src/tinstar`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tinstar.ts
import { writeFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface ArtifactPlacement {
  name?: string
  sessionId?: string
  spaceId?: string
  color?: string
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  nearNodeId?: string
  slot?: number | string
  snapToSession?: boolean
}

export interface ArtifactRef {
  artifactId: string
  widgetId: string
}

// The minimal surface the view bridge needs — lets tests inject a fake.
export interface ArtifactSink {
  postArtifact(html: string, placement?: ArtifactPlacement): Promise<ArtifactRef>
  putArtifact(artifactId: string, html: string): Promise<boolean>
  deleteArtifact(artifactId: string): Promise<void>
}

export class TinstarClient implements ArtifactSink {
  constructor(private baseUrl = "http://localhost:5273") {}

  private async writeTemp(html: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "whoachart-art-"))
    const path = join(dir, "view.html")
    await writeFile(path, html)
    return path
  }

  async postArtifact(html: string, placement: ArtifactPlacement = {}): Promise<ArtifactRef> {
    const path = await this.writeTemp(html)
    const res = await fetch(`${this.baseUrl}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...placement }),
    })
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !body?.ok) {
      throw new Error(`postArtifact failed: ${res.status} ${JSON.stringify(body)}`)
    }
    return { artifactId: body.data.artifactId, widgetId: body.data.widgetId }
  }

  async putArtifact(artifactId: string, html: string): Promise<boolean> {
    const path = await this.writeTemp(html)
    const res = await fetch(`${this.baseUrl}/api/artifacts/${artifactId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) return false
    const body = (await res.json().catch(() => ({}))) as any
    return body?.ok !== false
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/artifacts/${artifactId}`, { method: "DELETE" }).catch(() => {})
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tinstar.test.ts`
Expected: PASS (3 pass).

- [ ] **Step 5: Commit**

```bash
git add src/tinstar.ts tests/tinstar.test.ts
git commit -m "feat: tinstar artifact client"
```

---

## Task 2: Chart layout

**Files:**
- Create: `src/view/layout.ts`
- Test: `tests/layout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/layout.test.ts
import { test, expect } from "bun:test"
import { layoutChart } from "../src/view/layout"
import type { Chart } from "../src/types"

const chart: Chart = {
  name: "lin",
  nodes: [
    { id: "s", type: "source", config: {} },
    { id: "w", type: "shell", config: {} },
    { id: "e", type: "end", config: {} },
  ],
  edges: [ { from: "s", to: "w" }, { from: "w", to: "e" } ],
}

test("assigns a box to every node", () => {
  const l = layoutChart(chart)
  for (const id of ["s", "w", "e"]) expect(l.boxes.has(id)).toBe(true)
})

test("ranks flow downward (source above work above end)", () => {
  const l = layoutChart(chart)
  const s = l.boxes.get("s")!, w = l.boxes.get("w")!, e = l.boxes.get("e")!
  expect(s.y).toBeLessThan(w.y)
  expect(w.y).toBeLessThan(e.y)
})

test("canvas dimensions are positive and bound the nodes", () => {
  const l = layoutChart(chart)
  expect(l.width).toBeGreaterThan(0)
  expect(l.height).toBeGreaterThan(0)
  const e = l.boxes.get("e")!
  expect(e.y + e.h).toBeLessThanOrEqual(l.height)
})

test("honors an explicit position override", () => {
  const c: Chart = { ...chart, nodes: chart.nodes.map((n) => n.id === "w" ? { ...n, position: { x: 999, y: 888 } } : n) }
  const l = layoutChart(c)
  expect(l.boxes.get("w")).toMatchObject({ x: 999, y: 888 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/layout.test.ts`
Expected: FAIL — cannot find `../src/view/layout`.

- [ ] **Step 3: Write the implementation**

```ts
// src/view/layout.ts
import type { Chart } from "../types"

export interface NodeBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  boxes: Map<string, NodeBox>
  width: number
  height: number
  nodeW: number
  nodeH: number
}

const NODE_W = 150
const NODE_H = 60
const H_GAP = 60
const V_GAP = 70
const PAD = 40

function pushTo(map: Map<number, string[]>, key: number, val: string): void {
  const arr = map.get(key)
  if (arr) arr.push(val)
  else map.set(key, [val])
}

// Assign each node a rank = BFS distance from a source (a node with no incoming
// edges). Cycles are safe: a node keeps the first (smallest) rank it is given.
function rankNodes(chart: Chart): Map<string, number> {
  const incoming = new Map<string, number>()
  for (const n of chart.nodes) incoming.set(n.id, 0)
  for (const e of chart.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)

  const adj = new Map<string, string[]>()
  for (const e of chart.edges) {
    const a = adj.get(e.from)
    if (a) a.push(e.to)
    else adj.set(e.from, [e.to])
  }

  const rank = new Map<string, number>()
  const queue: string[] = []
  for (const n of chart.nodes) {
    if ((incoming.get(n.id) ?? 0) === 0) { rank.set(n.id, 0); queue.push(n.id) }
  }
  // all-in-a-cycle fallback: seed first node
  if (queue.length === 0 && chart.nodes.length > 0) {
    rank.set(chart.nodes[0].id, 0); queue.push(chart.nodes[0].id)
  }

  while (queue.length > 0) {
    const id = queue.shift()!
    const r = rank.get(id)!
    for (const to of adj.get(id) ?? []) {
      if (!rank.has(to)) { rank.set(to, r + 1); queue.push(to) }
    }
  }
  // unreachable nodes → rank 0
  for (const n of chart.nodes) if (!rank.has(n.id)) rank.set(n.id, 0)
  return rank
}

export function layoutChart(chart: Chart): Layout {
  const rank = rankNodes(chart)

  const rows = new Map<number, string[]>()
  for (const n of chart.nodes) pushTo(rows, rank.get(n.id)!, n.id)

  const maxRank = Math.max(0, ...rank.values())
  const boxes = new Map<string, NodeBox>()
  let maxRowWidth = 0

  for (let r = 0; r <= maxRank; r++) {
    const ids = rows.get(r) ?? []
    const rowWidth = ids.length * NODE_W + Math.max(0, ids.length - 1) * H_GAP
    maxRowWidth = Math.max(maxRowWidth, rowWidth)
    ids.forEach((id, i) => {
      const node = chart.nodes.find((n) => n.id === id)!
      const autoX = PAD + i * (NODE_W + H_GAP)
      const autoY = PAD + r * (NODE_H + V_GAP)
      boxes.set(id, {
        id,
        x: node.position?.x ?? autoX,
        y: node.position?.y ?? autoY,
        w: NODE_W,
        h: NODE_H,
      })
    })
  }

  const width = PAD * 2 + Math.max(NODE_W, maxRowWidth)
  const height = PAD * 2 + (maxRank + 1) * NODE_H + maxRank * V_GAP
  return { boxes, width, height, nodeW: NODE_W, nodeH: NODE_H }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/layout.test.ts`
Expected: PASS (4 pass).

- [ ] **Step 5: Commit**

```bash
git add src/view/layout.ts tests/layout.test.ts
git commit -m "feat: chart layout (BFS rank positioning)"
```

---

## Task 3: Chart render (server-side SVG)

**Files:**
- Create: `src/view/render.ts`
- Test: `tests/render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/render.test.ts
import { test, expect } from "bun:test"
import { renderChart } from "../src/view/render"
import { layoutChart } from "../src/view/layout"
import type { Chart, Marble } from "../src/types"

const chart: Chart = {
  name: "demo",
  nodes: [
    { id: "s", type: "source", name: "Start", config: {} },
    { id: "w", type: "shell", name: "Work", config: {} },
    { id: "e", type: "end", name: "Done", config: {} },
  ],
  edges: [ { from: "s", to: "w", name: "go" }, { from: "w", to: "e" } ],
}

function marble(id: string, node: string, status: Marble["status"]): Marble {
  return { id, chart: "demo", node, context: {}, history: [node], status, createdAt: "t", updatedAt: "t" }
}

test("renders a self-contained html doc with one svg", () => {
  const html = renderChart(chart, [], layoutChart(chart))
  expect(html).toContain("<!DOCTYPE html>")
  expect(html).toContain("<svg")
  expect(html).toContain("viewBox")
  expect(html).toContain("preserveAspectRatio")
})

test("includes node names, the chart name, and edge labels", () => {
  const html = renderChart(chart, [], layoutChart(chart))
  expect(html).toContain("Start")
  expect(html).toContain("Work")
  expect(html).toContain("demo")
  expect(html).toContain("go")
})

test("draws marbles on their current node with status class", () => {
  const ms = [marble("m1", "w", "running"), marble("m2", "w", "queued")]
  const html = renderChart(chart, ms, layoutChart(chart))
  expect(html).toContain('class="marble running"')
  expect(html).toContain('class="marble queued"')
  // a count chip showing 2 at node w
  expect(html).toContain(">2<")
})

test("escapes html-special characters in names", () => {
  const c: Chart = { ...chart, nodes: [{ id: "x", type: "shell", name: "a<b>&c", config: {} }], edges: [] }
  const html = renderChart(c, [], layoutChart(c))
  expect(html).toContain("a&lt;b&gt;&amp;c")
  expect(html).not.toContain("a<b>&c")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/render.test.ts`
Expected: FAIL — cannot find `../src/view/render`.

- [ ] **Step 3: Write the implementation**

```ts
// src/view/render.ts
import type { Chart, Marble } from "../types"
import type { Layout, NodeBox } from "./layout"

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const TYPE_COLOR: Record<string, string> = {
  source: "#3a5566",
  shell: "#2a3340",
  api: "#2a3340",
  decision: "#5a4a86",
  agent: "#a78bfa",
  end: "#2f6f63",
}

const CSS = `
:root{--bg:#0a0e14;--node:#0d141c;--ink:#c9d6e3;--dim:#5d6b7a;--cyan:#00f0ff}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif}
.bar{padding:8px 14px;border-bottom:1px solid #1c2531;font-size:13px;color:var(--cyan);font-weight:600}
.wrap{height:calc(100% - 35px)}
svg{width:100%;height:100%;display:block}
.edge{fill:none;stroke:#3a4a5a;stroke-width:2;marker-end:url(#arr)}
.elabel{fill:#6c7c8b;font:10px monospace}
.node{fill:var(--node);stroke-width:1.5}
.nname{fill:var(--ink);font:600 13px system-ui;text-anchor:middle}
.nsub{fill:var(--dim);font:10px monospace;text-anchor:middle}
.chip circle{fill:#0b1118;stroke:var(--cyan);stroke-width:1}
.chip text{fill:var(--cyan);font:10px monospace;text-anchor:middle}
.marble{stroke-width:1.5}
.marble.queued{fill:#3aa;stroke:#0a6b6b}
.marble.running,.marble.blocked{fill:#a78bfa;stroke:#7c6cf0}
.marble.done{fill:#3ad98a;stroke:#0a6b3b}
.marble.failed{fill:#ef4444;stroke:#7f1d1d}
`

function center(b: NodeBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

export function renderChart(chart: Chart, marbles: Marble[], layout: Layout): string {
  const byNode = new Map<string, Marble[]>()
  for (const m of marbles) {
    const a = byNode.get(m.node)
    if (a) a.push(m)
    else byNode.set(m.node, [m])
  }

  let edgeSvg = ""
  for (const e of chart.edges) {
    const a = layout.boxes.get(e.from)
    const b = layout.boxes.get(e.to)
    if (!a || !b) continue
    const ca = center(a)
    const cb = center(b)
    const x1 = ca.x, y1 = a.y + a.h
    const x2 = cb.x, y2 = b.y
    edgeSvg += `<path class="edge" d="M${x1},${y1} C${x1},${y1 + 40} ${x2},${y2 - 40} ${x2},${y2}"/>`
    if (e.name) {
      edgeSvg += `<text class="elabel" x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2}">${esc(e.name)}</text>`
    }
  }

  let nodeSvg = ""
  for (const n of chart.nodes) {
    const b = layout.boxes.get(n.id)
    if (!b) continue
    const color = n.color ?? TYPE_COLOR[n.type] ?? "#2a3340"
    const cx = b.x + b.w / 2
    nodeSvg += `<g>`
    nodeSvg += `<rect class="node" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="11" stroke="${color}"/>`
    nodeSvg += `<text class="nname" x="${cx}" y="${b.y + b.h / 2 - 1}">${esc(n.name ?? n.id)}</text>`
    nodeSvg += `<text class="nsub" x="${cx}" y="${b.y + b.h / 2 + 14}">${esc(n.type)}</text>`

    const ms = byNode.get(n.id) ?? []
    if (ms.length > 0) {
      nodeSvg += `<g class="chip"><circle cx="${b.x + 11}" cy="${b.y + 11}" r="9"/><text x="${b.x + 11}" y="${b.y + 14}">${ms.length}</text></g>`
      const shown = Math.min(ms.length, 6)
      ms.slice(0, 6).forEach((m, i) => {
        const mx = cx - (shown - 1) * 9 + i * 18
        const my = b.y + b.h + 13
        const r = m.status === "running" || m.status === "blocked" ? 9 : 7
        nodeSvg += `<circle class="marble ${m.status}" cx="${mx}" cy="${my}" r="${r}"/>`
      })
    }
    nodeSvg += `</g>`
  }

  const live = marbles.filter((m) => m.status === "queued" || m.status === "running" || m.status === "blocked").length
  const done = marbles.filter((m) => m.status === "done").length

  return `<!DOCTYPE html>
<html class="dark"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><style>${CSS}</style></head>
<body>
<div class="bar">whoachart ▸ ${esc(chart.name)} · ${live} live · ${done} done</div>
<div class="wrap">
<svg viewBox="0 0 ${layout.width} ${layout.height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#3a4a5a"/></marker></defs>
${edgeSvg}
${nodeSvg}
</svg>
</div>
</body></html>`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/render.test.ts`
Expected: PASS (4 pass).

- [ ] **Step 5: Commit**

```bash
git add src/view/render.ts tests/render.test.ts
git commit -m "feat: server-side SVG chart render"
```

---

## Task 4: View bridge

**Files:**
- Create: `src/view/bridge.ts`
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bridge.test.ts
import { test, expect } from "bun:test"
import { ViewBridge } from "../src/view/bridge"
import type { ArtifactRef, ArtifactPlacement, ArtifactSink } from "../src/tinstar"
import type { Chart, Marble } from "../src/types"

class FakeSink implements ArtifactSink {
  posts: string[] = []
  puts: { id: string; html: string }[] = []
  putReturn = true
  async postArtifact(html: string, _p?: ArtifactPlacement): Promise<ArtifactRef> {
    this.posts.push(html)
    return { artifactId: "eph-x", widgetId: "browser-x" }
  }
  async putArtifact(id: string, html: string): Promise<boolean> {
    this.puts.push({ id, html })
    return this.putReturn
  }
  async deleteArtifact(): Promise<void> {}
}

const chart: Chart = {
  name: "demo",
  nodes: [{ id: "w", type: "shell", name: "Work", config: {} }],
  edges: [],
}
function marble(id: string, status: Marble["status"]): Marble {
  return { id, chart: "demo", node: "w", context: {}, history: ["w"], status, createdAt: "t", updatedAt: "t" }
}

test("start() posts the initial artifact", async () => {
  const sink = new FakeSink()
  const b = new ViewBridge(sink, chart)
  await b.start()
  expect(sink.posts).toHaveLength(1)
  expect(sink.posts[0]).toContain("Work")
})

test("flush() PUTs current marbles after start", async () => {
  const sink = new FakeSink()
  const b = new ViewBridge(sink, chart)
  await b.start()
  b.update(marble("m1", "running"))
  await b.flush()
  expect(sink.puts.length).toBeGreaterThanOrEqual(1)
  expect(sink.puts.at(-1)!.html).toContain('class="marble running"')
})

test("flush() re-POSTs when PUT reports the artifact is gone", async () => {
  const sink = new FakeSink()
  const b = new ViewBridge(sink, chart)
  await b.start()
  sink.putReturn = false // artifact closed
  b.update(marble("m1", "queued"))
  await b.flush()
  expect(sink.posts.length).toBe(2) // initial + re-post
})

test("seed() loads existing marbles into the first render", async () => {
  const sink = new FakeSink()
  const b = new ViewBridge(sink, chart)
  b.seed([marble("m1", "done")])
  await b.start()
  expect(sink.posts[0]).toContain('class="marble done"')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/bridge.test.ts`
Expected: FAIL — cannot find `../src/view/bridge`.

- [ ] **Step 3: Write the implementation**

```ts
// src/view/bridge.ts
import type { Chart, Marble } from "../types"
import type { ArtifactSink, ArtifactPlacement } from "../tinstar"
import { layoutChart, type Layout } from "./layout"
import { renderChart } from "./render"

// Subscribes to engine marble snapshots and keeps one Tinstar artifact in sync.
export class ViewBridge {
  private marbles = new Map<string, Marble>()
  private layout: Layout
  private artifactId?: string
  private timer?: ReturnType<typeof setTimeout>
  private dirty = false

  constructor(
    private sink: ArtifactSink,
    private chart: Chart,
    private placement: ArtifactPlacement = {},
    private debounceMs = 120,
  ) {
    this.layout = layoutChart(chart)
  }

  // Pre-load marbles (e.g. from the store on boot) before the first render.
  seed(marbles: Marble[]): void {
    for (const m of marbles) this.marbles.set(m.id, m)
  }

  // Called for every engine onChange snapshot; coalesced via debounce.
  update(m: Marble): void {
    this.marbles.set(m.id, m)
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.dirty) void this.flush()
    }, this.debounceMs)
  }

  private html(): string {
    return renderChart(this.chart, [...this.marbles.values()], this.layout)
  }

  async start(): Promise<void> {
    const ref = await this.sink.postArtifact(this.html(), {
      name: `whoachart-${this.chart.name}`,
      size: { width: this.layout.width + 40, height: this.layout.height + 90 },
      ...this.placement,
    })
    this.artifactId = ref.artifactId
  }

  async flush(): Promise<void> {
    this.dirty = false
    if (!this.artifactId) {
      await this.start()
      return
    }
    const ok = await this.sink.putArtifact(this.artifactId, this.html())
    if (!ok) {
      // artifact was closed/removed — re-create it
      const ref = await this.sink.postArtifact(this.html(), {
        name: `whoachart-${this.chart.name}`,
        ...this.placement,
      })
      this.artifactId = ref.artifactId
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/bridge.test.ts`
Expected: PASS (4 pass).

- [ ] **Step 5: Commit**

```bash
git add src/view/bridge.ts tests/bridge.test.ts
git commit -m "feat: view bridge — engine onChange to live artifact"
```

---

## Task 5: Daemon

**Files:**
- Create: `src/daemon.ts`
- Test: `tests/daemon.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/daemon.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import type { ArtifactRef, ArtifactPlacement, ArtifactSink } from "../src/tinstar"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"

class FakeSink implements ArtifactSink {
  async postArtifact(_h: string, _p?: ArtifactPlacement): Promise<ArtifactRef> { return { artifactId: "a", widgetId: "w" } }
  async putArtifact(): Promise<boolean> { return true }
  async deleteArtifact(): Promise<void> {}
}

const CHART = `
name: demo
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: work
    type: shell
    config: { on_enter: "echo '{\\"merge\\":{\\"ran\\":true}}'" }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: work }
  - { from: work, to: done }
`

beforeEach(() => { clearRegistry(); registerBuiltins() })

async function chartFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wc-daemon-"))
  const path = join(dir, "demo.yaml")
  await writeFile(path, CHART)
  return path
}

test("loads charts and lists them", async () => {
  const d = new Daemon({ charts: [await chartFile()], storeDir: join(tmpdir(), "wc-st-" + crypto.randomUUID().slice(0, 8)), client: new FakeSink() })
  await d.start()
  expect(d.charts()).toEqual(["demo"])
})

test("submit runs a marble to completion (default start = source node)", async () => {
  const d = new Daemon({ charts: [await chartFile()], storeDir: join(tmpdir(), "wc-st-" + crypto.randomUUID().slice(0, 8)), client: new FakeSink() })
  await d.start()
  const m = await d.submit("demo", { context: { hi: 1 } })
  // give the engine a moment to finish
  await new Promise((r) => setTimeout(r, 200))
  const final = await d.marble("demo", m.id)
  expect(final?.status).toBe("done")
  expect(final?.context.ran).toBe(true)
})

test("submit on an unknown chart throws", async () => {
  const d = new Daemon({ charts: [await chartFile()], storeDir: join(tmpdir(), "wc-st-" + crypto.randomUUID().slice(0, 8)), client: new FakeSink() })
  await d.start()
  await expect(d.submit("nope", {})).rejects.toThrow(/unknown chart/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/daemon.test.ts`
Expected: FAIL — cannot find `../src/daemon`.

- [ ] **Step 3: Write the implementation**

```ts
// src/daemon.ts
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseChart } from "./schema"
import { registerBuiltins } from "./nodeTypes"
import { hasNodeType } from "./registry"
import { MarbleStore } from "./store"
import { Engine, newMarble } from "./engine"
import { ViewBridge } from "./view/bridge"
import type { ArtifactSink } from "./tinstar"
import type { Chart, Marble } from "./types"

export interface DaemonOpts {
  charts: string[] // chart YAML file paths
  storeDir: string
  client: ArtifactSink
  concurrency?: number
}

interface ChartRuntime {
  chart: Chart
  engine: Engine
  store: MarbleStore
  bridge: ViewBridge
  start: string
}

export interface SubmitOpts {
  context?: Record<string, unknown>
  workpiece?: string
  start?: string
}

// Default entry node: the first `source` node, else a node with no incoming
// edges, else the first node.
function findStart(chart: Chart): string {
  const source = chart.nodes.find((n) => n.type === "source")
  if (source) return source.id
  const hasIncoming = new Set(chart.edges.map((e) => e.to))
  const root = chart.nodes.find((n) => !hasIncoming.has(n.id))
  return (root ?? chart.nodes[0]).id
}

export class Daemon {
  private runtimes = new Map<string, ChartRuntime>()

  constructor(private opts: DaemonOpts) {}

  async start(): Promise<void> {
    if (!hasNodeType("end")) registerBuiltins()
    for (const path of this.opts.charts) {
      const chart = parseChart(await readFile(path, "utf8"))
      const store = new MarbleStore(join(this.opts.storeDir, chart.name))
      await store.init()
      const bridge = new ViewBridge(this.opts.client, chart)
      const engine = new Engine({
        chart,
        store,
        concurrency: this.opts.concurrency,
        onChange: (m) => bridge.update(m),
      })
      bridge.seed(await store.all())
      await bridge.start()
      await engine.resume()
      this.runtimes.set(chart.name, { chart, engine, store, bridge, start: findStart(chart) })
    }
  }

  charts(): string[] {
    return [...this.runtimes.keys()]
  }

  private rt(name: string): ChartRuntime {
    const rt = this.runtimes.get(name)
    if (!rt) throw new Error(`unknown chart: ${name}`)
    return rt
  }

  async submit(name: string, opts: SubmitOpts = {}): Promise<Marble> {
    const rt = this.rt(name)
    const m = newMarble(name, opts.start ?? rt.start, opts.context ?? {}, opts.workpiece)
    await rt.engine.submit(m)
    return m
  }

  async marbles(name: string): Promise<Marble[]> {
    return this.rt(name).store.all()
  }

  async marble(name: string, id: string): Promise<Marble | null> {
    return this.rt(name).store.load(id)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/daemon.test.ts`
Expected: PASS (3 pass).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "feat: daemon — per-chart engine + store + view bridge"
```

---

## Task 6: Control API

**Files:**
- Create: `src/controlApi.ts`
- Test: `tests/controlApi.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/controlApi.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import type { ArtifactRef, ArtifactPlacement, ArtifactSink } from "../src/tinstar"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"

class FakeSink implements ArtifactSink {
  async postArtifact(_h: string, _p?: ArtifactPlacement): Promise<ArtifactRef> { return { artifactId: "a", widgetId: "w" } }
  async putArtifact(): Promise<boolean> { return true }
  async deleteArtifact(): Promise<void> {}
}

const CHART = `
name: demo
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

let daemon: Daemon
let server: ReturnType<typeof Bun.serve>
let base: string

beforeEach(async () => {
  clearRegistry(); registerBuiltins()
  const dir = await mkdtemp(join(tmpdir(), "wc-api-"))
  const path = join(dir, "demo.yaml")
  await writeFile(path, CHART)
  daemon = new Daemon({ charts: [path], storeDir: join(dir, "store"), client: new FakeSink() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("GET /api/charts lists charts", async () => {
  const res = await fetch(`${base}/api/charts`)
  expect(await res.json()).toEqual({ charts: ["demo"] })
})

test("POST /api/charts/:name/marbles submits a marble", async () => {
  const res = await fetch(`${base}/api/charts/demo/marbles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: { x: 1 } }),
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.id).toBeTruthy()
})

test("GET /api/charts/:name/marbles lists submitted marbles", async () => {
  await fetch(`${base}/api/charts/demo/marbles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  await new Promise((r) => setTimeout(r, 150))
  const res = await fetch(`${base}/api/charts/demo/marbles`)
  const body = await res.json()
  expect(Array.isArray(body.marbles)).toBe(true)
  expect(body.marbles.length).toBeGreaterThanOrEqual(1)
})

test("unknown chart returns 400", async () => {
  const res = await fetch(`${base}/api/charts/nope/marbles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  expect(res.status).toBe(400)
})

test("unknown route returns 404", async () => {
  const res = await fetch(`${base}/api/whatever`)
  expect(res.status).toBe(404)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/controlApi.test.ts`
Expected: FAIL — cannot find `../src/controlApi`.

- [ ] **Step 3: Write the implementation**

```ts
// src/controlApi.ts
import type { Daemon } from "./daemon"

// Minimal HTTP control plane for the daemon. Routes:
//   GET  /api/charts
//   POST /api/charts/:name/marbles        { context?, workpiece?, start? }
//   GET  /api/charts/:name/marbles
//   GET  /api/charts/:name/marbles/:id
export function createControlApi(daemon: Daemon, port: number) {
  const json = (data: unknown, status = 200) => Response.json(data, { status })

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const p = url.pathname.split("/").filter(Boolean) // ["api","charts","demo","marbles","id?"]

      try {
        if (req.method === "GET" && url.pathname === "/api/charts") {
          return json({ charts: daemon.charts() })
        }

        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "marbles") {
          const name = p[2]
          // GET single marble
          if (req.method === "GET" && p[4]) {
            const m = await daemon.marble(name, p[4])
            return m ? json(m) : json({ error: "marble not found" }, 404)
          }
          // GET list
          if (req.method === "GET") {
            return json({ marbles: await daemon.marbles(name) })
          }
          // POST submit
          if (req.method === "POST") {
            const body = (await req.json().catch(() => ({}))) as any
            const m = await daemon.submit(name, {
              context: body.context,
              workpiece: body.workpiece,
              start: body.start,
            })
            return json({ id: m.id, status: m.status }, 201)
          }
        }

        return json({ error: "not found" }, 404)
      } catch (err) {
        return json({ error: String(err) }, 400)
      }
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/controlApi.test.ts`
Expected: PASS (5 pass).

- [ ] **Step 5: Commit**

```bash
git add src/controlApi.ts tests/controlApi.test.ts
git commit -m "feat: control API — marble intake + queries"
```

---

## Task 7: CLI + daemon entry point

**Files:**
- Create: `src/cli.ts`
- Create: `src/main.ts`
- Modify: `package.json` (add `bin` + `scripts.start`)
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli.test.ts
import { test, expect } from "bun:test"
import { parseArgs, DEFAULT_PORT } from "../src/cli"

test("parses submit with context and workpiece", () => {
  const a = parseArgs(["submit", "demo", "--context", '{"x":1}', "--workpiece", "/tmp/wp"])
  expect(a.cmd).toBe("submit")
  expect(a.chart).toBe("demo")
  expect(a.context).toEqual({ x: 1 })
  expect(a.workpiece).toBe("/tmp/wp")
})

test("parses charts command", () => {
  expect(parseArgs(["charts"]).cmd).toBe("charts")
})

test("parses marbles command with chart", () => {
  const a = parseArgs(["marbles", "demo"])
  expect(a.cmd).toBe("marbles")
  expect(a.chart).toBe("demo")
})

test("defaults port and reads --port override", () => {
  expect(parseArgs(["charts"]).port).toBe(DEFAULT_PORT)
  expect(parseArgs(["charts", "--port", "9999"]).port).toBe(9999)
})

test("invalid context json throws a clear error", () => {
  expect(() => parseArgs(["submit", "demo", "--context", "{bad"])).toThrow(/context/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli.test.ts`
Expected: FAIL — cannot find `../src/cli`.

- [ ] **Step 3: Write the implementation**

```ts
// src/cli.ts
export const DEFAULT_PORT = 5330

export interface CliArgs {
  cmd: string
  chart?: string
  context?: Record<string, unknown>
  workpiece?: string
  start?: string
  port: number
}

export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      flags.set(a.slice(2), argv[++i] ?? "")
    } else {
      positional.push(a)
    }
  }
  const cmd = positional[0] ?? "help"
  const args: CliArgs = { cmd, port: flags.has("port") ? Number(flags.get("port")) : DEFAULT_PORT }

  if (cmd === "submit" || cmd === "marbles") args.chart = positional[1]
  if (flags.has("workpiece")) args.workpiece = flags.get("workpiece")
  if (flags.has("start")) args.start = flags.get("start")
  if (flags.has("context")) {
    try {
      args.context = JSON.parse(flags.get("context")!)
    } catch (err) {
      throw new Error(`invalid --context JSON: ${err}`)
    }
  }
  return args
}

async function main(argv: string[]): Promise<void> {
  const a = parseArgs(argv)
  const base = `http://localhost:${a.port}`
  if (a.cmd === "charts") {
    const res = await fetch(`${base}/api/charts`)
    console.log(JSON.stringify(await res.json(), null, 2))
  } else if (a.cmd === "submit") {
    if (!a.chart) throw new Error("usage: whoachart submit <chart> [--context json] [--workpiece path]")
    const res = await fetch(`${base}/api/charts/${a.chart}/marbles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: a.context, workpiece: a.workpiece, start: a.start }),
    })
    console.log(JSON.stringify(await res.json(), null, 2))
  } else if (a.cmd === "marbles") {
    if (!a.chart) throw new Error("usage: whoachart marbles <chart>")
    const res = await fetch(`${base}/api/charts/${a.chart}/marbles`)
    console.log(JSON.stringify(await res.json(), null, 2))
  } else {
    console.log("usage: whoachart <charts|submit|marbles> [...]  (--port N)")
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((err) => {
    console.error(String(err))
    process.exit(1)
  })
}
```

```ts
// src/main.ts
import { readdir } from "node:fs/promises"
import { join, isAbsolute } from "node:path"
import { Daemon } from "./daemon"
import { createControlApi } from "./controlApi"
import { TinstarClient } from "./tinstar"
import { DEFAULT_PORT } from "./cli"

// Entry point: WHOACHART_CHARTS (comma-separated files or a dir), WHOACHART_STORE,
// WHOACHART_PORT, TINSTAR_URL.
async function resolveCharts(spec: string): Promise<string[]> {
  const entries = spec.split(",").map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const e of entries) {
    if (e.endsWith(".yaml") || e.endsWith(".yml")) {
      out.push(isAbsolute(e) ? e : join(process.cwd(), e))
    } else {
      // treat as a directory of charts
      const dir = isAbsolute(e) ? e : join(process.cwd(), e)
      for (const f of await readdir(dir)) {
        if (f.endsWith(".yaml") || f.endsWith(".yml")) out.push(join(dir, f))
      }
    }
  }
  return out
}

async function main(): Promise<void> {
  const chartsSpec = process.env.WHOACHART_CHARTS ?? "examples"
  const storeDir = process.env.WHOACHART_STORE ?? join(process.cwd(), ".whoachart")
  const port = process.env.WHOACHART_PORT ? Number(process.env.WHOACHART_PORT) : DEFAULT_PORT
  const tinstarUrl = process.env.TINSTAR_URL ?? "http://localhost:5273"

  const charts = await resolveCharts(chartsSpec)
  const daemon = new Daemon({ charts, storeDir, client: new TinstarClient(tinstarUrl) })
  await daemon.start()
  createControlApi(daemon, port)
  console.log(`[whoachart] daemon up on :${port} — charts: ${daemon.charts().join(", ") || "(none)"}`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[whoachart] failed to start: ${err}`)
    process.exit(1)
  })
}
```

Modify `package.json` — add a `bin` entry and a `start` script (merge into the existing JSON; keep existing fields):

```json
  "scripts": {
    "test": "bun test",
    "start": "bun run src/main.ts"
  },
  "bin": {
    "whoachart": "src/cli.ts"
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli.test.ts`
Expected: PASS (5 pass).

- [ ] **Step 5: Run full suite + commit**

Run: `bun test`
Expected: PASS — all suites green (Plan 1's 37 + Plan 2a's new tests).

Also confirm the type check: `bunx tsc --noEmit` → no errors.

```bash
git add src/cli.ts src/main.ts package.json tests/cli.test.ts
git commit -m "feat: CLI and daemon entry point"
```

---

## Manual smoke test (after Task 7, optional but recommended)

With Tinstar running on :5273:

```bash
# terminal 1 — start the daemon (renders examples/build-pipeline.yaml live)
WHOACHART_CHARTS=examples/build-pipeline.yaml bun run src/main.ts
# terminal 2 — submit marbles and watch them flow on the canvas
bun run src/cli.ts submit build-pipeline --context '{"tests_pass":"yes"}'
bun run src/cli.ts submit build-pipeline --context '{"tests_pass":"no"}'
bun run src/cli.ts marbles build-pipeline
```

A `whoachart-build-pipeline` artifact should appear on the Tinstar canvas with marbles ending at `shipped` (green) and `halted` (red). Resize the widget — nodes, edges, and marbles scale together (no drift).

---

## Self-Review

**Spec coverage (against spec §9 + the Plan-1 "deferred to Plan 2" list):**
- Live chromed view as one self-refreshing artifact → Tasks 3, 4 (render + bridge). ✅
- Layout so edges+nodes share one coordinate system (fixes mockup drift) → Task 2, and render puts everything in one `<svg viewBox>`. ✅
- Marbles shown on nodes with counts + status colors → Task 3. ✅
- Tinstar artifact POST/PUT/DELETE + re-POST on 404 → Tasks 1, 4. ✅
- Control API marble intake + queries; CLI as a thin client → Tasks 6, 7. ✅
- Daemon wiring per-chart engine+store+bridge, resume on boot → Task 5. ✅
- **Deferred to Plan 2b (explicitly):** `agent` node type, engine external-signal/resume for blocked marbles, session spawn + constellation/color/avatar linking, SSE stream of marble events. Not in this plan.

**Placeholder scan:** none — every step has complete code and concrete commands.

**Type consistency:** `ArtifactSink`/`ArtifactPlacement`/`ArtifactRef` (Task 1) are consumed by `ViewBridge` (Task 4) and `Daemon` (Task 5). `Layout`/`NodeBox` (Task 2) flow into `renderChart` (Task 3) and `ViewBridge`. `Daemon`'s `charts()/submit()/marbles()/marble()` (Task 5) are exactly what `createControlApi` (Task 6) calls. `DEFAULT_PORT`/`parseArgs` (Task 7) shared by `cli.ts` and `main.ts`. The engine's `onChange` snapshot contract (Plan 1) is what `ViewBridge.update` consumes. Reuses `Marble`, `Chart`, `Engine`, `newMarble`, `MarbleStore`, `parseChart`, `registerBuiltins`, `hasNodeType` from Plan 1 unchanged.
