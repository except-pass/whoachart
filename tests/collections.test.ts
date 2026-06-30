import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas } from "./fakes"
import { waitForStatus } from "./poll"

// Two tiny charts: one with a blocking gate (so a marble can park "blocked"),
// one straight-through (so a marble can reach an end).
const GATE_CHART = `
name: alpha
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: gate
    type: human
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: gate }
  - { from: gate, to: done, name: approve }
`

const FLOW_CHART = `
name: bravo
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

const MANIFEST = `
name: srena
title: Serena's loop
description: alpha then bravo
members:
  - alpha
  - bravo
`

let daemon: Daemon, server: ReturnType<typeof Bun.serve>, base: string
let chartsDir: string, collectionsDir: string, storeDir: string, root: string

beforeEach(async () => {
  clearRegistry(); registerBuiltins()
  root = await mkdtemp(join(tmpdir(), "wc-coll-"))
  chartsDir = join(root, "charts"); collectionsDir = join(root, "collections"); storeDir = join(root, "store")
  await mkdir(chartsDir, { recursive: true }); await mkdir(collectionsDir, { recursive: true })
  await writeFile(join(chartsDir, "alpha.yaml"), GATE_CHART)
  await writeFile(join(chartsDir, "bravo.yaml"), FLOW_CHART)
  await writeFile(join(collectionsDir, "srena.yaml"), MANIFEST)
  daemon = new Daemon({ chartsDir, collectionsDir, storeDir, client: new FakeCanvas() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

// ---- U3: daemon composition ----

test("a collection with all members loaded composes each member's status", async () => {
  const view = daemon.collection("srena")
  expect(view.title).toBe("Serena's loop")
  expect(view.members.map((m) => m.name)).toEqual(["alpha", "bravo"]) // R5 order preserved
  expect(view.members.every((m) => m.missing === false)).toBe(true) // R14
})

test("a member naming an unloaded chart is missing, not an error (AE1/R4/R8)", async () => {
  await writeFile(join(collectionsDir, "ghosty.yaml"), `
name: ghosty
title: t
description: d
members:
  - alpha
  - nope-not-loaded
  - bravo
`)
  await daemon.loadNewCollections()
  const view = daemon.collection("ghosty")
  expect(view.members.map((m) => m.missing)).toEqual([false, true, false])
  // The loaded members still compose normally.
  expect(view.members[0].name).toBe("alpha")
  expect(view.members[1].name).toBe("nope-not-loaded")
})

test("member status reflects live marble state (AE2/R7)", async () => {
  // Park a marble blocked on alpha's gate, and run one through bravo.
  const blocked = await daemon.submit("alpha", {})
  await waitForStatus(() => daemon.marble("alpha", blocked.id), "blocked")
  const flowed = await daemon.submit("bravo", {})
  await waitForStatus(() => daemon.marble("bravo", flowed.id), "done")

  const view = daemon.collection("srena")
  const alpha = view.members.find((m) => m.name === "alpha")!
  const bravo = view.members.find((m) => m.name === "bravo")!
  expect(alpha.inFlight).toBe(1)
  expect(alpha.blocked).toBe(1)
  expect(bravo.ended).toBe(1)
  expect(bravo.lastOutcome).toBe("done")
})

test("collection() throws 404 for an unknown collection name", () => {
  expect(() => daemon.collection("nope")).toThrow(/unknown collection/)
})

test("a malformed manifest at boot is isolated, not fatal", async () => {
  await writeFile(join(collectionsDir, "broken.yaml"), "name: broken\ntitle: t") // no members
  clearRegistry(); registerBuiltins()
  const d2 = new Daemon({ chartsDir, collectionsDir, storeDir, client: new FakeCanvas() })
  await d2.start()
  expect(d2.collections()).toContain("srena") // good one still loaded
  expect(d2.collections()).not.toContain("broken")
  expect(d2.bootErrors.some((e) => e.name === "collection:broken")).toBe(true)
})

test("a registered-by-reference collection survives a restart (R15)", async () => {
  clearRegistry(); registerBuiltins()
  const d2 = new Daemon({ chartsDir, collectionsDir, storeDir, client: new FakeCanvas() })
  await d2.start()
  expect(d2.collections()).toContain("srena")
})

test("collections are disabled (501) when no collections dir is configured", async () => {
  clearRegistry(); registerBuiltins()
  const d2 = new Daemon({ chartsDir, storeDir, client: new FakeCanvas() })
  await d2.start()
  expect(d2.collections()).toEqual([])
  await expect(d2.registerCollection(MANIFEST)).rejects.toThrow(/not configured/)
})

// ---- U4: control API ----

test("GET /api/collections lists registered collections", async () => {
  const res = await fetch(`${base}/api/collections`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ collections: ["srena"] })
})

test("GET /api/collections/:name returns composed status; unknown → 404", async () => {
  const ok = await fetch(`${base}/api/collections/srena`)
  expect(ok.status).toBe(200)
  const view = (await ok.json()) as { members: unknown[] }
  expect(view.members).toHaveLength(2)

  const missing = await fetch(`${base}/api/collections/nope`)
  expect(missing.status).toBe(404)
})

test("GET /ui/collections/:name serves HTML; unknown → 404; trailing slash → 301 (R6)", async () => {
  const ok = await fetch(`${base}/ui/collections/srena`)
  expect(ok.status).toBe(200)
  expect(ok.headers.get("content-type")).toContain("text/html")
  expect(await ok.text()).toContain("../collection.js")

  const unknown = await fetch(`${base}/ui/collections/nope`)
  expect(unknown.status).toBe(404)

  const slashed = await fetch(`${base}/ui/collections/srena/`, { redirect: "manual" })
  expect(slashed.status).toBe(301)
})

test("GET /ui/collection.js serves the client asset", async () => {
  const res = await fetch(`${base}/ui/collection.js`)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("javascript")
})

test("POST /api/collections from a non-loopback peer is rejected (writeGate); loopback registers (R14/R15)", async () => {
  // Simulate a trusted-but-non-loopback (tailnet CGNAT) peer: passes the base
  // trust gate, fails the loopback-only write gate.
  const tailnet = createControlApi(daemon, 0, { resolveAddr: () => "100.108.201.76" })
  const tbase = `http://localhost:${tailnet.port}`
  const forbidden = await fetch(`${tbase}/api/collections`, {
    method: "POST", body: `
name: remote
title: t
description: d
members: [alpha]
`,
  })
  expect(forbidden.status).toBe(403)
  tailnet.stop(true)

  // Loopback (the default fetch) registers a new collection.
  const ok = await fetch(`${base}/api/collections`, {
    method: "POST", body: `
name: another
title: t
description: d
members: [bravo]
`,
  })
  expect(ok.status).toBe(201)
  expect(await ok.json()).toEqual({ name: "another" })
  expect(daemon.collections()).toContain("another")
})

test("POST /api/collections {path} registers by reference; reload picks up a dropped manifest", async () => {
  const ext = join(root, "elsewhere.yaml")
  await writeFile(ext, `
name: byref
title: t
description: d
members: [alpha]
`)
  const res = await fetch(`${base}/api/collections`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: ext }),
  })
  expect(res.status).toBe(201)
  expect(daemon.collections()).toContain("byref")

  // Drop a manifest straight into the dir, then reload (R15).
  await writeFile(join(collectionsDir, "dropped.yaml"), `
name: dropped
title: t
description: d
members: [bravo]
`)
  const reload = await fetch(`${base}/api/collections/reload`, { method: "POST" })
  expect(reload.status).toBe(200)
  expect(((await reload.json()) as { loaded: string[] }).loaded).toContain("dropped")
})
