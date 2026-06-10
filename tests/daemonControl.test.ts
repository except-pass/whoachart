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
