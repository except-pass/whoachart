// tests/daemonReload.test.ts — hot pickup of newly-dropped chart files without a
// daemon restart. loadNewCharts() rescans the chart-store dir and installs any
// *.yaml not already live; it is additive-only (edits/deletes stay with PUT/DELETE).
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { ChartError } from "../src/chartStore"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"
import { waitFor } from "./poll"

const chart = (name: string) => `
name: ${name}
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

beforeEach(() => clearRegistry())

// A daemon whose chart-store dir IS its boot dir (the common lone-dir default).
async function makeDaemon(canvas = new FakeCanvas()) {
  const dir = await mkdtemp(join(tmpdir(), "wc-reload-"))
  await writeFile(join(dir, "first.yaml"), chart("first"))
  const d = new Daemon({
    charts: [join(dir, "first.yaml")],
    chartsDir: dir,
    storeDir: join(dir, "store"),
    client: canvas,
    launcher: new FakeLauncher(),
    baseUrl: "http://localhost:5330",
    publicUrl: "http://tailnet:5331",
  })
  await d.start()
  return { d, dir, canvas }
}

test("loadNewCharts picks up a chart dropped into the dir after boot", async () => {
  const { d, dir, canvas } = await makeDaemon()
  expect(d.charts()).toEqual(["first"])
  const widgetsBefore = canvas.ensured.length

  await writeFile(join(dir, "second.yaml"), chart("second"))
  const res = await d.loadNewCharts()

  expect(res.loaded).toEqual(["second"])
  expect(res.errors).toEqual([])
  expect(d.charts().sort()).toEqual(["first", "second"])
  // newly-live chart gets its own Tinstar widget, just like a boot-loaded one
  expect(canvas.ensured.length).toBe(widgetsBefore + 1)
  expect(canvas.ensured.at(-1)!.url).toBe("http://tailnet:5331/ui/charts/second")
})

test("loadNewCharts is additive-only and idempotent: a second rescan loads nothing", async () => {
  const { d, dir } = await makeDaemon()
  await writeFile(join(dir, "second.yaml"), chart("second"))
  await d.loadNewCharts()

  const again = await d.loadNewCharts()
  expect(again.loaded).toEqual([])
  expect(again.errors).toEqual([])
  expect(d.charts().sort()).toEqual(["first", "second"])
})

test("loadNewCharts reports a malformed chart without crashing or skipping good ones", async () => {
  const { d, dir } = await makeDaemon()
  await writeFile(join(dir, "broken.yaml"), "name: broken\nnodes: [oops not a node]\n")
  await writeFile(join(dir, "good.yaml"), chart("good"))

  const res = await d.loadNewCharts()

  expect(res.loaded).toEqual(["good"]) // the good chart still came live
  expect(res.errors.map((e) => e.name)).toEqual(["broken"])
  expect(res.errors[0].error).toBeTruthy()
  expect(d.charts().sort()).toEqual(["first", "good"])
})

test("watchCharts auto-loads a chart dropped into the dir, then stops on dispose", async () => {
  const { d, dir } = await makeDaemon()
  const stop = d.watchCharts(20) // short debounce for the test

  await writeFile(join(dir, "watched.yaml"), chart("watched"))
  await waitFor(
    async () => (d.charts().includes("watched") ? true : null),
    { label: "watcher picks up the new chart" },
  )
  expect(d.charts().sort()).toEqual(["first", "watched"])

  // After dispose, a further drop is NOT auto-loaded.
  stop()
  await writeFile(join(dir, "after.yaml"), chart("after"))
  await new Promise((r) => setTimeout(r, 100))
  expect(d.charts().includes("after")).toBe(false)
})

test("boot skips a malformed chart instead of crashing, and records it in bootErrors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wc-boot-bad-"))
  await writeFile(join(dir, "good.yaml"), chart("good"))
  await writeFile(join(dir, "broken.yaml"), "name: broken\nnodes: [oops not a node]\n")
  const d = new Daemon({
    charts: [join(dir, "good.yaml"), join(dir, "broken.yaml")],
    chartsDir: dir,
    storeDir: join(dir, "store"),
    client: new FakeCanvas(),
    launcher: new FakeLauncher(),
  })

  await d.start() // must NOT throw

  expect(d.charts()).toEqual(["good"])
  expect(d.bootErrors.map((e) => e.name)).toContain("broken")
  expect(d.bootErrors.find((e) => e.name === "broken")!.error).toBeTruthy()
})

test("loadNewCharts requires a chart store (501 when none configured)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wc-reload-nostore-"))
  await writeFile(join(dir, "first.yaml"), chart("first"))
  const d = new Daemon({
    charts: [join(dir, "first.yaml")],
    storeDir: join(dir, "store"),
    client: new FakeCanvas(),
    launcher: new FakeLauncher(),
  })
  await d.start()
  await expect(d.loadNewCharts()).rejects.toThrow(ChartError)
})
