// tests/uiRoutes.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"
import { waitFor } from "./poll"

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
  // RELATIVE src — must survive Tinstar's widget proxy (see src/ui/page.ts)
  expect(html).toContain('src="../app.js"')
  expect(html).not.toContain('src="/ui/app.js"')
  // The relative src must resolve to a route the daemon actually serves.
  const src = html.match(/<script type="module" src="([^"]+)"/)![1]
  const resolved = new URL(src, `${base}/ui/charts/gatey`)
  expect(resolved.pathname).toBe("/ui/app.js")
  const js = await fetch(resolved.href)
  expect(js.status).toBe(200)
  expect(js.headers.get("content-type")).toContain("javascript")
})

test("GET /ui/charts/:name/ (trailing slash) redirects to the slashless form", async () => {
  const res = await fetch(`${base}/ui/charts/gatey/?foo=bar`, { redirect: "manual" })
  expect(res.status).toBe(301)
  const location = new URL(res.headers.get("location")!)
  expect(location.pathname).toBe("/ui/charts/gatey")
  expect(location.search).toBe("?foo=bar")
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

test("all client modules serve and the shell has the control-surface containers", async () => {
  for (const mod of ["app.js", "helpers.js", "forms.js", "drawer.js", "nodeDrawer.js"]) {
    const res = await fetch(`${base}/ui/${mod}`)
    expect(res.status).toBe(200)
  }
  const html = await (await fetch(`${base}/ui/charts/gatey`)).text()
  for (const id of ['id="svg"', 'id="drawer"', 'id="drawerBody"', 'id="tray"', 'id="modal"', 'id="hovercard"', 'id="overlay"']) {
    expect(html).toContain(id)
  }
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
  // let the marble settle at the gate (blocked) before exercising the routes
  await waitFor(async () => {
    const m = (await (await fetch(`${base}/api/charts/gatey/marbles/${id}`)).json()) as any
    return m?.status === "blocked"
  }, { label: "marble blocks at the gate" })
  expect((await fetch(`${base}/api/charts/gatey/marbles/${id}/retry`, { method: "POST" })).status).toBe(400)
  expect((await fetch(`${base}/api/charts/gatey/marbles/${id}/focus-session`, { method: "POST" })).status).toBe(404)
})
