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
  const body = (await res.json()) as any
  expect(body.id).toBeTruthy()
})

test("GET /api/charts/:name/marbles lists submitted marbles", async () => {
  await fetch(`${base}/api/charts/demo/marbles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  await new Promise((r) => setTimeout(r, 150))
  const res = await fetch(`${base}/api/charts/demo/marbles`)
  const body = (await res.json()) as any
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
