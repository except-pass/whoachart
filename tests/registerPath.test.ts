import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir, readFile, lstat, unlink } from "node:fs/promises"
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
  const link = join(chartsDir, "faraway.yaml")
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
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
  const edited = EXTERNAL.replace("- id: ingest", "- id: ingest\n    name: Edited intake")
  const put = await fetch(`${base}/api/charts/faraway`, { method: "PUT", body: edited })
  expect(put.status).toBe(200)
  expect(await readFile(externalPath, "utf8")).toContain("Edited intake")
  expect((await lstat(join(chartsDir, "faraway.yaml"))).isSymbolicLink()).toBe(true)
})

test("raw YAML with an application/json header still registers by value (backward-compat)", async () => {
  // A client sending raw YAML but defaulting to an application/json header must
  // not regress to a 400 — it falls through to register-by-value.
  const res = await fetch(`${base}/api/charts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: EXTERNAL,
  })
  expect(res.status).toBe(201)
  expect(daemon.charts()).toContain("faraway")
  // and it's a copy, not a symlink (register-by-value)
  expect((await lstat(join(chartsDir, "faraway.yaml"))).isSymbolicLink()).toBe(false)
})

test("a dangling reference symlink is skipped into bootErrors, not a crash", async () => {
  await fetch(`${base}/api/charts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: externalPath }),
  })
  await unlink(externalPath) // target gone -> store symlink now dangles
  clearRegistry(); registerBuiltins()
  const d2 = new Daemon({ chartsDir, storeDir, client: new FakeCanvas() })
  await d2.start()
  expect(d2.charts()).not.toContain("faraway")
  expect(d2.bootErrors.some((e) => e.name === "faraway")).toBe(true)
})

test("registering a chart with an invalid cron is rejected 400 (validated at parse)", async () => {
  const bad = EXTERNAL.replace("name: faraway", "name: faraway\ntriggers:\n  - { cron: \"99 9 * * *\", start: ingest }")
  const res = await fetch(`${base}/api/charts`, { method: "POST", body: bad })
  expect(res.status).toBe(400)
  expect(daemon.charts()).not.toContain("faraway")
})

test("register {path} is loopback-only", async () => {
  const tailnet = createControlApi(daemon, 0, { resolveAddr: () => "100.108.201.76" })
  try {
    const res = await fetch(`http://localhost:${tailnet.port}/api/charts`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: externalPath }),
    })
    expect(res.status).toBe(403)
  } finally { tailnet.stop(true) }
})
