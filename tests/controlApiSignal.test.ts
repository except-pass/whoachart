import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
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
    config: { brief: "Review it." }
  - id: ok
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: review }
  - { from: review, to: ok, name: pass }
`

let server: ReturnType<typeof Bun.serve>
let base: string

beforeEach(async () => {
  clearRegistry()
  const dir = await mkdtemp(join(tmpdir(), "wc-sigapi-"))
  const path = join(dir, "agency.yaml")
  await writeFile(path, CHART)
  const daemon = new Daemon({ charts: [path], storeDir: join(dir, "store"), client: new FakeCanvas(), launcher: new FakeLauncher() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("POST .../signal resumes a blocked marble", async () => {
  const sub = await fetch(`${base}/api/charts/agency/marbles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  const { id } = (await sub.json()) as any
  await new Promise((r) => setTimeout(r, 250)) // let it reach the agent node

  const res = await fetch(`${base}/api/charts/agency/marbles/${id}/signal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ next: "pass", merge: { verdict: "ok" } }),
  })
  expect(res.status).toBe(200)
  await new Promise((r) => setTimeout(r, 250))
  const m = (await (await fetch(`${base}/api/charts/agency/marbles/${id}`)).json()) as any
  expect(m.status).toBe("done")
  expect(m.context.verdict).toBe("ok")
})

test("signaling a non-blocked marble returns 400", async () => {
  const res = await fetch(`${base}/api/charts/agency/marbles/nope/signal`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })
  expect(res.status).toBe(400)
})
