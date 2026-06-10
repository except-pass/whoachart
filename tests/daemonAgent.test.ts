import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"

const CHART = `
name: agency
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: review
    type: agent
    name: Review
    config: { brief: "Review it." }
  - id: ok
    type: end
    config: { outcome: success }
  - id: bad
    type: end
    config: { outcome: fail }
edges:
  - { from: ingest, to: review }
  - { from: review, to: ok, name: pass }
  - { from: review, to: bad, name: fail }
`

beforeEach(() => clearRegistry())

async function makeDaemon(launcher: FakeLauncher, baseUrl = "http://localhost:5330") {
  const dir = await mkdtemp(join(tmpdir(), "wc-da-"))
  const path = join(dir, "agency.yaml")
  await writeFile(path, CHART)
  const d = new Daemon({
    charts: [path],
    storeDir: join(dir, "store"),
    client: new FakeCanvas(),
    launcher,
    baseUrl,
  })
  await d.start()
  return d
}

test("marble blocks at the agent node with a spawned session", async () => {
  const launcher = new FakeLauncher()
  const d = await makeDaemon(launcher)
  const m = await d.submit("agency", {})
  await new Promise((r) => setTimeout(r, 250))
  const blocked = await d.marble("agency", m.id)
  expect(blocked?.status).toBe("blocked")
  expect(blocked?.node).toBe("review")
  expect(launcher.spawned).toHaveLength(1)
  expect(launcher.spawned[0].prompt).toContain("http://localhost:5330/api/charts/agency/marbles/" + m.id + "/signal")
})

test("signal resumes the marble and stops the session", async () => {
  const launcher = new FakeLauncher()
  const d = await makeDaemon(launcher)
  const m = await d.submit("agency", {})
  await new Promise((r) => setTimeout(r, 250))
  await d.signal("agency", m.id, { next: "pass", merge: { verdict: "ship it" } })
  await new Promise((r) => setTimeout(r, 250))
  const f = await d.marble("agency", m.id)
  expect(f?.status).toBe("done")
  expect(f?.node).toBe("ok")
  expect(f?.context.verdict).toBe("ship it")
  expect(launcher.stopped).toEqual([launcher.spawned[0].name])
})

test("two daemons in one process keep separate launcher + signal-URL wiring", async () => {
  // The agent node used to be registered into the module-global registry,
  // capturing the FIRST daemon's launcher/baseUrl; a second daemon silently
  // reused it. Instance-scoped wiring must keep them independent.
  const a = new FakeLauncher()
  const b = new FakeLauncher()
  const da = await makeDaemon(a, "http://daemon-a:1111")
  const db = await makeDaemon(b, "http://daemon-b:2222")

  const ma = await da.submit("agency", {})
  const mb = await db.submit("agency", {})
  await new Promise((r) => setTimeout(r, 250))

  expect(a.spawned).toHaveLength(1)
  expect(b.spawned).toHaveLength(1)
  expect(a.spawned[0].prompt).toContain(`http://daemon-a:1111/api/charts/agency/marbles/${ma.id}/signal`)
  expect(b.spawned[0].prompt).toContain(`http://daemon-b:2222/api/charts/agency/marbles/${mb.id}/signal`)
})
