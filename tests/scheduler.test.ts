import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { Scheduler } from "../src/scheduler"
import { nextRun } from "../src/cron"
import { Daemon } from "../src/daemon"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas, FakeClock } from "./fakes"
import { waitFor } from "./poll"

test("Scheduler fires an interval trigger each period and stops on disarm", () => {
  const clock = new FakeClock()
  const sched = new Scheduler(clock)
  let fired = 0
  sched.arm("c", [{ every: "10m", start: "scan" }], () => { fired++ })
  expect(fired).toBe(0)
  clock.advance(10 * 60_000); expect(fired).toBe(1)
  clock.advance(10 * 60_000); expect(fired).toBe(2)
  sched.disarm("c")
  clock.advance(10 * 60_000); expect(fired).toBe(2)
})

test("Scheduler fires a cron trigger at its computed next-run delay", () => {
  const clock = new FakeClock()
  const sched = new Scheduler(clock)
  let fired = 0
  // Compute the delay the scheduler will use (TZ-robust: derived from nextRun
  // against the clock's epoch start), then prove it fires exactly at that point.
  const delay = nextRun("*/15 * * * *", new Date(0)).getTime()
  sched.arm("c", [{ cron: "*/15 * * * *", start: "scan" }], () => { fired++ })
  clock.advance(delay - 1); expect(fired).toBe(0)
  clock.advance(1); expect(fired).toBe(1)
})

test("a throwing fire callback does not kill the schedule; onError is notified", () => {
  const clock = new FakeClock()
  const errors: unknown[] = []
  const sched = new Scheduler(clock, (_c, e) => errors.push(e))
  let calls = 0
  sched.arm("c", [{ every: "1m", start: "scan" }], () => { calls++; throw new Error("boom") })
  clock.advance(60_000); expect(calls).toBe(1)
  clock.advance(60_000); expect(calls).toBe(2) // rescheduled despite the throw
  expect(errors.length).toBe(2)
})

const CRON_CHART = `
name: ticktock
triggers:
  - { every: 1m, start: scan, context: { hello: "world" } }
nodes:
  - id: scan
    type: source
    config: { trigger: api, form: [ { key: hello, type: text } ] }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: done }
`

let daemon: Daemon, clock: FakeClock
beforeEach(async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-sch-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "ticktock.yaml"), CRON_CHART)
  clock = new FakeClock()
  daemon = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas(), clock })
  await daemon.start()
})

test("an interval trigger submits a marble with its static context when time advances", async () => {
  expect((await daemon.marbles("ticktock")).length).toBe(0)
  clock.advance(60_000)
  const m = await waitFor(async () => {
    const all = await daemon.marbles("ticktock")
    return all.length ? all[0] : null
  })
  expect(m.context.hello).toBe("world")
})

test("deleting a chart disarms its schedule", async () => {
  await daemon.deleteChart("ticktock", { force: true })
  clock.advance(60_000 * 5)
  expect(daemon.charts()).not.toContain("ticktock")
})

test("a hot-reload re-arms with the new schedule (old one disarmed)", async () => {
  // first tick on the original every:1m
  clock.advance(60_000)
  await waitFor(async () => ((await daemon.marbles("ticktock")).length >= 1 ? true : null))
  expect((await daemon.marbles("ticktock")).length).toBe(1)
  // slow the schedule to every 5m via hot-reload
  await daemon.updateChart("ticktock", CRON_CHART.replace("every: 1m", "every: 5m"))
  clock.advance(60_000) // 1m later — the OLD schedule would have fired; the new one must not
  await new Promise((r) => setTimeout(r, 20))
  expect((await daemon.marbles("ticktock")).length).toBe(1)
  clock.advance(4 * 60_000) // reach 5m on the new schedule
  await waitFor(async () => ((await daemon.marbles("ticktock")).length >= 2 ? true : null))
  expect((await daemon.marbles("ticktock")).length).toBe(2)
})
