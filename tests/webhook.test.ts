import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas } from "./fakes"
import { waitFor } from "./poll"

const HOOK_CHART = `
name: hooky
triggers:
  - { webhook: jira-updated, start: scan }
nodes:
  - id: scan
    type: source
    config:
      trigger: api
      form:
        - { key: key, type: text, required: true }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: done }
`

let daemon: Daemon, server: ReturnType<typeof Bun.serve>, base: string
beforeEach(async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-hook-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "hooky.yaml"), HOOK_CHART)
  daemon = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("POST /api/hooks/:chart/:hook creates a marble from the JSON body", async () => {
  const res = await fetch(`${base}/api/hooks/hooky/jira-updated`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "PROJ-7" }),
  })
  expect(res.status).toBe(202)
  const { id } = (await res.json()) as any
  const m = await waitFor(async () => (await daemon.marble("hooky", id)))
  expect(m.context.key).toBe("PROJ-7")
})

test("a webhook body that fails form validation is 400", async () => {
  const res = await fetch(`${base}/api/hooks/hooky/jira-updated`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  })
  expect(res.status).toBe(400)
  expect(((await res.json()) as any).fields.key).toBe("required")
})

test("an unknown hook id is 404", async () => {
  const res = await fetch(`${base}/api/hooks/hooky/nope`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })
  expect(res.status).toBe(404)
})

test("a webhook from a tailnet peer is accepted (trigger, not a chart write)", async () => {
  const tailnet = createControlApi(daemon, 0, { resolveAddr: () => "100.108.201.76" })
  try {
    const res = await fetch(`http://localhost:${tailnet.port}/api/hooks/hooky/jira-updated`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "PROJ-9" }),
    })
    expect(res.status).toBe(202)
  } finally { tailnet.stop(true) }
})
