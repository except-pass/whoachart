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
  expect(sup.focus).toBe(false) // spawns passively — no viewport pull
})

test("deleting the chart stops the supervisor session", async () => {
  await boot()
  const sup = await waitFor(async () => launcher.spawned.find((s) => s.name === "wc-sup-oversee") ?? null)
  await daemon.deleteChart("oversee", { force: true })
  expect(launcher.stopped).toContain(sup.name)
})

test("a hot-reload leaves the running supervisor untouched (v1: not stopped, not re-spawned)", async () => {
  await boot()
  const sup = await waitFor(async () => launcher.spawned.find((s) => s.name === "wc-sup-oversee") ?? null)
  await daemon.updateChart("oversee", SUP_CHART.replace('brief: "Resolve routing gates; leave approvals to a human."', 'brief: "edited"'))
  expect(launcher.stopped).not.toContain(sup.name)
  expect(launcher.spawned.filter((s) => s.name === "wc-sup-oversee")).toHaveLength(1) // not re-spawned
})

test("a supervisor session that spawns AFTER the chart is deleted is torn down, not leaked", async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-late-"))
  const chartsDir = join(root, "charts"); await mkdir(chartsDir, { recursive: true })
  await writeFile(join(chartsDir, "oversee.yaml"), SUP_CHART)
  // Launcher whose spawnSession resolves only when we release it, so we can
  // delete the chart while the spawn is still in flight.
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const stopped: string[] = []
  const launch = {
    spawned: [] as string[],
    async spawnSession(o: { name: string }) { this.spawned.push(o.name); await gate; return { name: o.name } },
    async stopSession(n: string) { stopped.push(n) },
  }
  const d = new Daemon({ chartsDir, storeDir: join(root, "store"), client: new FakeCanvas(), launcher: launch as any })
  await d.start()
  await waitFor(async () => (launch.spawned.length ? true : null)) // spawn in flight, gated
  await d.deleteChart("oversee", { force: true }) // delete BEFORE the spawn resolves
  release()
  await waitFor(async () => (stopped.includes("wc-sup-oversee") ? true : null))
  expect(stopped).toContain("wc-sup-oversee") // late session torn down, not leaked
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
