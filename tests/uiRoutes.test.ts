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
