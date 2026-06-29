import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { Scheduler } from "../src/scheduler"
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
