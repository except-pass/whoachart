import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import type { ArtifactRef, ArtifactPlacement, ArtifactSink } from "../src/tinstar"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"

class FakeSink implements ArtifactSink {
  async postArtifact(_h: string, _p?: ArtifactPlacement): Promise<ArtifactRef> { return { artifactId: "a", widgetId: "w" } }
  async putArtifact(): Promise<boolean> { return true }
  async deleteArtifact(): Promise<void> {}
}

const CHART = `
name: demo
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: work
    type: shell
    config: { on_enter: "echo '{\\"merge\\":{\\"ran\\":true}}'" }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: work }
  - { from: work, to: done }
`

beforeEach(() => { clearRegistry(); registerBuiltins() })

async function chartFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wc-daemon-"))
  const path = join(dir, "demo.yaml")
  await writeFile(path, CHART)
  return path
}

test("loads charts and lists them", async () => {
  const d = new Daemon({ charts: [await chartFile()], storeDir: join(tmpdir(), "wc-st-" + crypto.randomUUID().slice(0, 8)), client: new FakeSink() })
  await d.start()
  expect(d.charts()).toEqual(["demo"])
})

test("submit runs a marble to completion (default start = source node)", async () => {
  const d = new Daemon({ charts: [await chartFile()], storeDir: join(tmpdir(), "wc-st-" + crypto.randomUUID().slice(0, 8)), client: new FakeSink() })
  await d.start()
  const m = await d.submit("demo", { context: { hi: 1 } })
  await new Promise((r) => setTimeout(r, 200))
  const final = await d.marble("demo", m.id)
  expect(final?.status).toBe("done")
  expect(final?.context.ran).toBe(true)
})

test("submit on an unknown chart throws", async () => {
  const d = new Daemon({ charts: [await chartFile()], storeDir: join(tmpdir(), "wc-st-" + crypto.randomUUID().slice(0, 8)), client: new FakeSink() })
  await d.start()
  await expect(d.submit("nope", {})).rejects.toThrow(/unknown chart/)
})
