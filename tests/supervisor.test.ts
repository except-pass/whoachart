import { test, expect } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas, FakeLauncher } from "./fakes"
import { waitFor } from "./poll"

const SUP_CHART = `
name: oversee
supervisor:
  brief: "Resolve routing gates; leave approvals to a human."
  project: whoachart
nodes:
  - id: scan
    type: source
    config: { trigger: api }
  - id: route
    type: human
    decider: agent
    config: {}
  - id: approve
    type: human
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: scan, to: route }
  - { from: route, to: approve, name: ok }
  - { from: approve, to: done, name: post }
`

let daemon: Daemon, launcher: FakeLauncher
async function boot(agentSpace?: string) {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-sup-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "oversee.yaml"), SUP_CHART)
  launcher = new FakeLauncher()
  daemon = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas(), launcher, agentSpace })
  await daemon.start()
}

test("a chart with a supervisor block spawns one session, briefed on its agent gates", async () => {
  await boot("whoachart-agents")
  const sup = await waitFor(async () => launcher.spawned.find((s) => s.name.startsWith("wc-sup-")) ?? null)
  expect(sup.name).toBe("wc-sup-oversee")
  expect(sup.prompt).toContain("Resolve routing gates")
  expect(sup.prompt).toContain('decider:"agent"')
  expect(sup.prompt).toContain("route")
  expect(sup.project).toBe("whoachart")
  expect(sup.spaceId).toBe("sp-fake")
})

test("deleting the chart stops the supervisor session", async () => {
  await boot()
  const sup = await waitFor(async () => launcher.spawned.find((s) => s.name === "wc-sup-oversee") ?? null)
  await daemon.deleteChart("oversee", { force: true })
  expect(launcher.stopped).toContain(sup.name)
})

test("a chart without a supervisor block spawns no supervisor", async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-nosup-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "plain.yaml"), `
name: plain
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
  const l = new FakeLauncher()
  const d = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas(), launcher: l })
  await d.start()
  expect(l.spawned.filter((s) => s.name.startsWith("wc-sup-"))).toHaveLength(0)
})
