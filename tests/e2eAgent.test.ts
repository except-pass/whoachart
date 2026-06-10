import { test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import type { SessionLauncher, SpawnSessionOpts } from "../src/tinstar"
import { clearRegistry } from "../src/registry"
import { FakeCanvas } from "./fakes"
import { waitForStatus } from "./poll"

// A launcher that behaves like a real agent: reads the signal URL out of its
// brief and (after a beat) signals 'approve' through the control API — the
// full round trip a Tinstar session would make.
class AutoAgent implements SessionLauncher {
  stopped: string[] = []
  async spawnSession(o: SpawnSessionOpts) {
    const url = o.prompt.match(/curl -X POST (\S+)/)?.[1]
    if (url) {
      setTimeout(() => {
        void fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ next: "approve", merge: { reviewed_by: o.name } }),
        })
      }, 150)
    }
    return { name: o.name }
  }
  async stopSession(n: string) { this.stopped.push(n) }
}

beforeEach(() => clearRegistry())

test("agent-review example: marble blocks, fake agent signals, marble ships, session stopped", async () => {
  const launcher = new AutoAgent()
  const storeDir = join(tmpdir(), "wc-e2ea-" + crypto.randomUUID().slice(0, 8))
  const daemon = new Daemon({
    charts: ["examples/agent-review.yaml"],
    storeDir,
    client: new FakeCanvas(),
    launcher,
    baseUrl: "http://localhost:0", // patched below once the server binds
  })
  const server = createControlApi(daemon, 0)
  ;(daemon as any).opts.baseUrl = `http://localhost:${server.port}`
  await daemon.start()
  try {
    const m = await daemon.submit("agent-review", { context: { title: "Q3 post" } })
    // wait for: reach agent node → block → auto-signal → resume → done
    const final = await waitForStatus(
      () => daemon.marble("agent-review", m.id),
      ["done", "failed"],
      "agent round-trip completes",
    )
    expect(final.status).toBe("done")
    expect(final.node).toBe("published")
    expect(final.context.reviewed_by).toContain("wc-agent-review-")
    expect(launcher.stopped).toHaveLength(1)
  } finally {
    server.stop(true)
  }
})
