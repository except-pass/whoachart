import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { parseChart } from "../src/schema"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { Daemon } from "../src/daemon"
import { FakeCanvas } from "./fakes"

beforeEach(() => { clearRegistry(); registerBuiltins() })

const base = (extra: string) => `
name: trig
triggers:
${extra}
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: done }
`

test("parses a cron trigger bound to a source node", () => {
  const c = parseChart(base(`  - { cron: "0 9 * * 1-5", start: scan, context: { since: "" } }`))
  expect(c.triggers).toEqual([{ cron: "0 9 * * 1-5", start: "scan", context: { since: "" } }])
})

test("parses every + webhook triggers", () => {
  const c = parseChart(base(`  - { every: 15m, start: scan }\n  - { webhook: ping, start: scan }`))
  expect(c.triggers?.[0]).toEqual({ every: "15m", start: "scan" })
  expect(c.triggers?.[1]).toEqual({ webhook: "ping", start: "scan" })
})

test("rejects a trigger with neither cron/every/webhook", () => {
  expect(() => parseChart(base(`  - { start: scan }`))).toThrow(/exactly one of/)
})

test("rejects a trigger with two of cron/every/webhook", () => {
  expect(() => parseChart(base(`  - { cron: "* * * * *", every: 5m, start: scan }`))).toThrow(/exactly one of/)
})

test("rejects a trigger whose start is not a source node", () => {
  expect(() => parseChart(base(`  - { every: 5m, start: done }`))).toThrow(/must name a source node/)
})

test("rejects duplicate webhook ids", () => {
  expect(() => parseChart(base(`  - { webhook: ping, start: scan }\n  - { webhook: ping, start: scan }`))).toThrow(/duplicate webhook/)
})

test("rejects an invalid cron expression at parse time", () => {
  expect(() => parseChart(base(`  - { cron: "99 9 * * *", start: scan }`))).toThrow(/out of range|cron/)
})

test("rejects an invalid every interval at parse time", () => {
  expect(() => parseChart(base(`  - { every: "15", start: scan }`))).toThrow(/interval|expected/)
})

test("parses a supervisor block and node decider", () => {
  const c = parseChart(`
name: trig
supervisor: { brief: "watch it", project: whoachart }
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: gate
    type: human
    decider: agent
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: gate }
  - { from: gate, to: done, name: ok }
`)
  expect(c.supervisor).toEqual({ brief: "watch it", project: "whoachart" })
  expect(c.nodes.find((n) => n.id === "gate")?.decider).toBe("agent")
})

test("def() surfaces a node's decider for the supervisor to read", async () => {
  const root = await mkdtemp(join(tmpdir(), "wc-dec-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "trig.yaml"), `
name: trig
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: gate
    type: human
    decider: agent
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: gate }
  - { from: gate, to: done, name: ok }
`)
  const d = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas() })
  await d.start()
  const node = d.def("trig").nodes.find((n) => n.id === "gate")
  expect(node?.decider).toBe("agent")
})

test("def() surfaces a chart's triggers", async () => {
  const root = await mkdtemp(join(tmpdir(), "wc-deft-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "trig.yaml"), `
name: trig
triggers:
  - { every: 30m, start: scan }
  - { webhook: poke, start: scan }
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: done }
`)
  const d = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas() })
  await d.start()
  expect(d.def("trig").triggers).toEqual([{ every: "30m", start: "scan" }, { webhook: "poke", start: "scan" }])
})
