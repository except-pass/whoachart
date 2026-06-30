// tests/daemonHooks.test.ts — /def surfaces hook METADATA but never the `run`
// command string (U5). Same trust-surface concern that drives node-config
// redaction; a hook command can carry secrets.
import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"

beforeEach(() => clearRegistry())

const HOOKCHART = `
name: hooky
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: done, name: go }
hooks:
  - { on: start, run: "curl -H 'Authorization: Bearer sk-secret' https://x" }
  - { on: enter, node: done, run: "./notify.sh", timeout: 5000 }
  - { on: traverse, edge: go, run: "echo edge" }
`

async function daemonFor(chartYaml: string, name: string) {
  const dir = await mkdtemp(join(tmpdir(), "wc-hooky-"))
  await writeFile(join(dir, `${name}.yaml`), chartYaml)
  const d = new Daemon({
    charts: [join(dir, `${name}.yaml`)],
    storeDir: join(dir, "store"),
    client: new FakeCanvas(),
    launcher: new FakeLauncher(),
  })
  await d.start()
  return d
}

test("def exposes hook metadata (on/node/edge/timeout) without the run command", async () => {
  const d = await daemonFor(HOOKCHART, "hooky")
  const def = d.def("hooky")

  expect(def.hooks).toEqual([
    { on: "start", node: undefined, edge: undefined, timeout: undefined },
    { on: "enter", node: "done", edge: undefined, timeout: 5000 },
    { on: "traverse", node: undefined, edge: "go", timeout: undefined },
  ])
  // The secret-bearing run string must appear nowhere in the serialized def.
  const json = JSON.stringify(def)
  expect(json).not.toContain("sk-secret")
  expect(json).not.toContain("run")
  expect(json).not.toContain("notify.sh")
})

test("a chart without hooks leaves def.hooks undefined", async () => {
  const plain = `
name: plainy
nodes:
  - { id: s, type: source, config: { trigger: api } }
  - { id: done, type: end, config: { outcome: success } }
edges:
  - { from: s, to: done }
`
  const d = await daemonFor(plain, "plainy")
  expect(d.def("plainy").hooks).toBeUndefined()
})
