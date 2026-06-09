import { test, expect } from "bun:test"
import { ViewBridge } from "../src/view/bridge"
import type { ArtifactRef, ArtifactPlacement, ArtifactSink } from "../src/tinstar"
import type { Chart, Marble } from "../src/types"

class FakeSink implements ArtifactSink {
  posts: string[] = []
  puts: { id: string; html: string }[] = []
  async postArtifact(html: string, _p?: ArtifactPlacement): Promise<ArtifactRef> {
    this.posts.push(html)
    return { artifactId: "eph-x", widgetId: "browser-x" }
  }
  async putArtifact(id: string, html: string): Promise<boolean> {
    this.puts.push({ id, html })
    return true
  }
  async deleteArtifact(): Promise<void> {}
}

const STATE_URL = "http://localhost:5330/api/charts/demo/state"
const chart: Chart = {
  name: "demo",
  nodes: [
    { id: "w", type: "shell", name: "Work", config: {} },
    { id: "done", type: "end", name: "Done", config: {} },
  ],
  edges: [{ from: "w", to: "done" }],
}
function marble(id: string, node: string, status: Marble["status"]): Marble {
  return { id, chart: "demo", node, context: {}, history: [node], status, createdAt: "t", updatedAt: "t" }
}

test("start() posts the stable shell exactly once (with the state url, never PUTs)", async () => {
  const sink = new FakeSink()
  const b = new ViewBridge(sink, chart, STATE_URL)
  await b.start()
  expect(sink.posts).toHaveLength(1)
  expect(sink.posts[0]).toContain("Work")
  expect(sink.posts[0]).toContain(STATE_URL)
  expect(sink.puts).toHaveLength(0) // no flashing — the page polls instead
})

test("update() reflects live marbles in the snapshot", () => {
  const b = new ViewBridge(new FakeSink(), chart, STATE_URL)
  b.update(marble("m1", "w", "running"))
  const s = b.snapshot()
  expect(s.live.map((m) => m.id)).toEqual(["m1"])
})

test("a finished marble leaves live and tallies at its end node", () => {
  const b = new ViewBridge(new FakeSink(), chart, STATE_URL)
  b.update(marble("m1", "w", "running"))
  b.update(marble("m1", "done", "done"))
  const s = b.snapshot()
  expect(s.live).toHaveLength(0)
  expect(s.ends["done"].total).toBe(1)
})

test("seed() pre-loads marbles into the snapshot", () => {
  const b = new ViewBridge(new FakeSink(), chart, STATE_URL)
  b.seed([marble("m1", "done", "done"), marble("m2", "w", "running")])
  const s = b.snapshot()
  expect(s.live).toHaveLength(1)
  expect(s.ends["done"].total).toBe(1)
})
