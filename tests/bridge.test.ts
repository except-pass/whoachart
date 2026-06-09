import { test, expect } from "bun:test"
import { ViewBridge } from "../src/view/bridge"
import type { ArtifactRef, ArtifactPlacement, ArtifactSink } from "../src/tinstar"
import type { Chart, Marble } from "../src/types"

class FakeSink implements ArtifactSink {
  posts: string[] = []
  puts: { id: string; html: string }[] = []
  putReturn = true
  async postArtifact(html: string, _p?: ArtifactPlacement): Promise<ArtifactRef> {
    this.posts.push(html)
    return { artifactId: "eph-x", widgetId: "browser-x" }
  }
  async putArtifact(id: string, html: string): Promise<boolean> {
    this.puts.push({ id, html })
    return this.putReturn
  }
  async deleteArtifact(): Promise<void> {}
}

const chart: Chart = {
  name: "demo",
  nodes: [{ id: "w", type: "shell", name: "Work", config: {} }],
  edges: [],
}
function marble(id: string, status: Marble["status"]): Marble {
  return { id, chart: "demo", node: "w", context: {}, history: ["w"], status, createdAt: "t", updatedAt: "t" }
}

test("start() posts the initial artifact", async () => {
  const sink = new FakeSink()
  const b = new ViewBridge(sink, chart)
  await b.start()
  expect(sink.posts).toHaveLength(1)
  expect(sink.posts[0]).toContain("Work")
})

test("flush() PUTs current marbles after start", async () => {
  const sink = new FakeSink()
  const b = new ViewBridge(sink, chart)
  await b.start()
  b.update(marble("m1", "running"))
  await b.flush()
  expect(sink.puts.length).toBeGreaterThanOrEqual(1)
  expect(sink.puts.at(-1)!.html).toContain('class="marble running"')
})

test("flush() re-POSTs when PUT reports the artifact is gone", async () => {
  const sink = new FakeSink()
  const b = new ViewBridge(sink, chart)
  await b.start()
  sink.putReturn = false
  b.update(marble("m1", "queued"))
  await b.flush()
  expect(sink.posts.length).toBe(2)
})

test("seed() loads existing marbles into the first render", async () => {
  const sink = new FakeSink()
  const b = new ViewBridge(sink, chart)
  b.seed([marble("m1", "done")])
  await b.start()
  expect(sink.posts[0]).toContain('class="marble done"')
})
