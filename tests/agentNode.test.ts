import { test, expect } from "bun:test"
import { makeAgentNode, buildBrief } from "../src/nodeTypes/agent"
import type { SessionLauncher, SpawnSessionOpts } from "../src/tinstar"
import type { RunCtx, Marble, ChartNode } from "../src/types"

class FakeLauncher implements SessionLauncher {
  spawned: SpawnSessionOpts[] = []
  stopped: string[] = []
  deleted: string[] = []
  async spawnSession(opts: SpawnSessionOpts) { this.spawned.push(opts); return { name: opts.name } }
  async stopSession(name: string) { this.stopped.push(name) }
  async deleteSession(name: string) { this.deleted.push(name) }
}

const node: ChartNode = {
  id: "review", type: "agent", name: "Review", color: "#a78bfa",
  config: { brief: "Review the draft for factual errors." },
}

function ctx(): RunCtx {
  const marble: Marble = {
    id: "m1", chart: "content", node: "review", context: { stage: "drafted" },
    workpiece: "/tmp/post.md", history: ["review"], status: "running", createdAt: "t", updatedAt: "t",
  }
  return {
    chart: { name: "content", nodes: [node], edges: [] },
    marble, node,
    outgoing: [
      { from: "review", to: "edit", name: "pass" },
      { from: "review", to: "revise", name: "revise" },
    ],
  }
}

test("agent node spawns a session and blocks the marble", async () => {
  const launcher = new FakeLauncher()
  const agent = makeAgentNode(launcher, (m) => `http://x/api/charts/${m.chart}/marbles/${m.id}/signal`)
  const r = await agent.run(ctx())
  expect(r.block).toBe(true)
  expect(launcher.spawned).toHaveLength(1)
  expect(launcher.spawned[0].name).toBe("wc-content-m1")
  expect(launcher.spawned[0].color).toBe("#a78bfa") // node color rides along
  expect((r.merge as any)._session).toBe("wc-content-m1")
})

test("the brief tells the agent its job, the edges, and how to signal", async () => {
  const launcher = new FakeLauncher()
  const agent = makeAgentNode(launcher, (m) => `http://x/api/charts/${m.chart}/marbles/${m.id}/signal`)
  await agent.run(ctx())
  const brief = launcher.spawned[0].prompt
  expect(brief).toContain("Review the draft for factual errors.")
  expect(brief).toContain("/tmp/post.md")          // workpiece
  expect(brief).toContain("pass")                   // edge names
  expect(brief).toContain("revise")
  expect(brief).toContain("http://x/api/charts/content/marbles/m1/signal")
  expect(brief).toContain('"stage":"drafted"')     // context rides along
})

test("buildBrief lists edges and signal curl", () => {
  const m: Marble = { id: "m2", chart: "c", node: "n", context: {}, history: ["n"], status: "running", createdAt: "t", updatedAt: "t" }
  const b = buildBrief(m, node, "Do X.", ["a", "b"], "http://sig")
  expect(b).toContain("Do X.")
  expect(b).toContain("a, b")
  expect(b).toContain("curl -X POST http://sig")
})
