// tests/daemonSpace.test.ts — WHOACHART_SPACE confinement (U3): widgets placed
// in the resolved space, tracked for teardown, graceful fallback when the space
// can't be resolved, and unchanged behavior when no space is configured.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"

const CHART = `
name: spacey
nodes:
  - id: ingest
    type: source
    config: { trigger: api, form: [ { key: title, type: text } ] }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: done }
`

beforeEach(() => clearRegistry())
afterEach(() => {
  delete process.env.WHOACHART_TINSTAR_SPACE
})

async function makeDaemon(opts: { space?: string; canvas?: FakeCanvas } = {}) {
  const canvas = opts.canvas ?? new FakeCanvas()
  const dir = await mkdtemp(join(tmpdir(), "wc-sp-"))
  await writeFile(join(dir, "spacey.yaml"), CHART)
  const d = new Daemon({
    charts: [join(dir, "spacey.yaml")],
    storeDir: join(dir, "store"),
    client: canvas,
    launcher: new FakeLauncher(),
    baseUrl: "http://localhost:5330",
    publicUrl: "http://tailnet:5331",
    space: opts.space,
  })
  await d.start()
  return { d, canvas }
}

test("with a space configured, the widget is placed in the resolved space", async () => {
  const canvas = new FakeCanvas()
  canvas.spaceResult = "sp-test"
  const { d } = await makeDaemon({ space: "_testing", canvas })
  expect(canvas.spaceRequests).toEqual(["_testing"])
  expect(canvas.ensured[0].spaceId).toBe("sp-test")
  // resolved id is exposed to shell nodes
  expect(process.env.WHOACHART_TINSTAR_SPACE).toBe("sp-test")
  // tracked for teardown
  expect((d as any).createdWidgets).toHaveLength(1)
})

test("teardownWidgets deletes exactly the widgets this run created", async () => {
  const canvas = new FakeCanvas()
  canvas.spaceResult = "sp-test"
  const { d } = await makeDaemon({ space: "_testing", canvas })
  const tracked = (d as any).createdWidgets.map((w: any) => w.widgetId)
  await d.teardownWidgets()
  expect(canvas.deleted).toEqual(tracked)
  // idempotent: a second call removes nothing more
  await d.teardownWidgets()
  expect(canvas.deleted).toEqual(tracked)
})

test("falls back to active-space placement when the space cannot be resolved", async () => {
  const canvas = new FakeCanvas()
  canvas.spaceResult = null // resolve/create failed
  const { d } = await makeDaemon({ space: "_testing", canvas })
  expect(canvas.ensured[0].spaceId).toBeUndefined()
  expect((d as any).createdWidgets).toHaveLength(0) // nothing tracked → nothing torn down
  expect(process.env.WHOACHART_TINSTAR_SPACE).toBeUndefined()
})

test("with no space configured, behavior is unchanged (no spaceId, no tracking)", async () => {
  const { d, canvas } = await makeDaemon({})
  expect(canvas.spaceRequests).toEqual([])
  expect(canvas.ensured[0].spaceId).toBeUndefined()
  expect((d as any).createdWidgets).toHaveLength(0)
})
