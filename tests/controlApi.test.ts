import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas } from "./fakes"
import { waitFor } from "./poll"

const CHART = `
name: demo
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

let daemon: Daemon
let server: ReturnType<typeof Bun.serve>
let base: string

beforeEach(async () => {
  clearRegistry(); registerBuiltins()
  const dir = await mkdtemp(join(tmpdir(), "wc-api-"))
  const path = join(dir, "demo.yaml")
  await writeFile(path, CHART)
  daemon = new Daemon({ charts: [path], storeDir: join(dir, "store"), client: new FakeCanvas() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("GET /api/charts lists charts", async () => {
  const res = await fetch(`${base}/api/charts`)
  expect(await res.json()).toEqual({ charts: ["demo"] })
})

test("POST /api/charts/:name/marbles submits a marble", async () => {
  const res = await fetch(`${base}/api/charts/demo/marbles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: { x: 1 } }),
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as any
  expect(body.id).toBeTruthy()
})

test("GET /api/charts/:name/marbles lists submitted marbles", async () => {
  await fetch(`${base}/api/charts/demo/marbles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  const body = await waitFor(async () => {
    const res = await fetch(`${base}/api/charts/demo/marbles`)
    const b = (await res.json()) as any
    return b.marbles?.length >= 1 ? b : null
  }, { label: "submitted marble appears in list" })
  expect(Array.isArray(body.marbles)).toBe(true)
  expect(body.marbles.length).toBeGreaterThanOrEqual(1)
})

test("unknown chart returns 400", async () => {
  const res = await fetch(`${base}/api/charts/nope/marbles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  expect(res.status).toBe(400)
})

test("unknown route returns 404", async () => {
  const res = await fetch(`${base}/api/whatever`)
  expect(res.status).toBe(404)
})

test("GET /api/charts/:name/state returns the bounded view aggregate with CORS", async () => {
  await fetch(`${base}/api/charts/demo/marbles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  let res!: Response
  // the marble finished at the 'done' end node → tallied there
  const body = await waitFor(async () => {
    res = await fetch(`${base}/api/charts/demo/state`)
    const b = (await res.json()) as any
    return b.ends?.done?.total >= 1 ? b : null
  }, { label: "marble tallied at the 'done' end node" })
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  expect(Array.isArray(body.live)).toBe(true)
  expect(typeof body.ends).toBe("object")
  expect(body.ends.done?.total).toBeGreaterThanOrEqual(1)
})
