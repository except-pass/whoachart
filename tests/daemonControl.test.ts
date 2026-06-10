// tests/daemonControl.test.ts
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { FormError } from "../src/forms"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"
import { waitFor, waitForStatus } from "./poll"

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

// The node inspector needs each node's run code + config + lifecycle hooks.
const CODECHART = `
name: codey
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: build
    type: shell
    on_leave: "echo left build"
    timeout: 5000
    retry: { max: 2 }
    config:
      on_enter: "echo building $WC_MARBLE"
  - id: review
    type: agent
    config:
      brief: "Review the workpiece and decide."
      keep_session: true
  - id: ship
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: build }
  - { from: build, to: review }
  - { from: review, to: ship, name: approve }
`

test("def exposes node config, lifecycle hooks, and the agent brief", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wc-dc-code-"))
  await writeFile(join(dir, "codey.yaml"), CODECHART)
  const d = new Daemon({
    charts: [join(dir, "codey.yaml")],
    storeDir: join(dir, "store"),
    client: new FakeCanvas(),
    launcher: new FakeLauncher(),
  })
  await d.start()
  const def = d.def("codey")

  const build = def.nodes.find((n) => n.id === "build")!
  expect((build.config as any).on_enter).toBe("echo building $WC_MARBLE")
  expect(build.on_leave).toBe("echo left build")
  expect(build.timeout).toBe(5000)
  expect(build.retry).toEqual({ max: 2 })

  const review = def.nodes.find((n) => n.id === "review")!
  expect((review.config as any).brief).toBe("Review the workpiece and decide.")
  expect((review.config as any).keep_session).toBe(true)

  // end + source config surfaces too (generic, not just code-bearing nodes)
  expect((def.nodes.find((n) => n.id === "ship")!.config as any).outcome).toBe("success")
})

const SECRETCHART = `
name: secrety
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: call
    type: api
    config:
      request:
        url: "https://api.example.com/x"
        method: POST
        headers:
          Authorization: "Bearer sk-super-secret"
          X-Trace: "ok-to-show"
      next_on_ok: done
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: call }
  - { from: call, to: done, name: next_on_ok }
`

test("def redacts secret-bearing config values but keeps the structure visible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wc-dc-secret-"))
  await writeFile(join(dir, "secrety.yaml"), SECRETCHART)
  const d = new Daemon({
    charts: [join(dir, "secrety.yaml")],
    storeDir: join(dir, "store"),
    client: new FakeCanvas(),
    launcher: new FakeLauncher(),
  })
  await d.start()
  const cfg = d.def("secrety").nodes.find((n) => n.id === "call")!.config as any

  // every header value is masked (auth rides there), keys stay visible
  expect(cfg.request.headers.Authorization).toBe("***redacted***")
  expect(cfg.request.headers["X-Trace"]).toBe("***redacted***")
  expect(Object.keys(cfg.request.headers)).toEqual(["Authorization", "X-Trace"])
  // non-secret structure still shown — the inspector must reveal what the node does
  expect(cfg.request.url).toBe("https://api.example.com/x")
  expect(cfg.request.method).toBe("POST")
  expect(cfg.next_on_ok).toBe("done")

  // redaction is view-only: a second def() still masks (the real config wasn't mutated)
  const cfg2 = d.def("secrety").nodes.find((n) => n.id === "call")!.config as any
  expect(cfg2.request.headers.Authorization).toBe("***redacted***")
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
  await waitForStatus(() => d.marble("gatey", m.id), "blocked") // reach the gate
  await expect(d.signal("gatey", m.id, { next: "decline", merge: {} })).rejects.toThrow(FormError)
  await d.signal("gatey", m.id, { next: "decline", merge: { reason: "nope" } })
  const f = await waitFor(async () => {
    const m2 = await d.marble("gatey", m.id)
    return m2?.node === "no" ? m2 : null
  }, { label: "marble reaches the 'no' end node" })
  expect(f.node).toBe("no")
  expect(f.context.reason).toBe("nope")
})

test("retry passes through and focusSession reports status", async () => {
  const { d, canvas } = await makeDaemon()
  const m = await d.submit("gatey", { context: { title: "hi" } })
  await waitForStatus(() => d.marble("gatey", m.id), "blocked")
  expect(await d.focusSession("gatey", m.id)).toBe("no-session")
  await expect(d.retry("gatey", m.id)).rejects.toThrow(/not failed/)
  // focusSession with a session present pans
  const m2 = await d.submit("gatey", { context: { title: "x" } })
  const rec = await waitForStatus(() => d.marble("gatey", m2.id), "blocked")
  rec.context._session = "wc-fake"
  const { MarbleStore } = await import("../src/store")
  // write the session into the store so focusSession sees it
  const store = new MarbleStore(join((d as any).opts.storeDir, "gatey"))
  await store.save(rec)
  expect(await d.focusSession("gatey", m2.id)).toBe("ok")
  expect(canvas.panned).toEqual(["wc-fake"])
})
