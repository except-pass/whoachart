import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { FakeCanvas } from "./fakes"
import { waitFor } from "./poll"

// A chart that parks a marble at a human gate: source -> gate(human) -> end.
// The gate blocks until signaled, so it's the ideal place to test `annotate`
// merging context WITHOUT advancing the marble.
const CHART = `
name: gated
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: gate
    type: human
    present:
      - { key: decision, as: markdown, primary: true }
      - { key: report_path, as: link }
      - { key: brief_file, as: markdown_file }
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: gate }
  - { from: gate, to: done, name: approve }
`

let daemon: Daemon
let server: ReturnType<typeof Bun.serve>
let base: string
let dir: string

async function blockedMarble(): Promise<string> {
  const sub = await fetch(`${base}/api/charts/gated/marbles`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: { report_path: "https://x/report" } }),
  })
  const { id } = (await sub.json()) as any
  await waitFor(async () => {
    const m = (await (await fetch(`${base}/api/charts/gated/marbles/${id}`)).json()) as any
    return m.status === "blocked"
  }, { label: "marble blocks at human gate" })
  return id
}

beforeEach(async () => {
  clearRegistry()
  dir = await mkdtemp(join(tmpdir(), "wc-annotate-"))
  const path = join(dir, "gated.yaml")
  await writeFile(path, CHART)
  daemon = new Daemon({ charts: [path], storeDir: join(dir, "store"), client: new FakeCanvas() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("annotate deep-merges context WITHOUT advancing the marble", async () => {
  const id = await blockedMarble()
  const m = await daemon.annotate("gated", id, { decision: "## Verdict\nApprove.", meta: { a: 1 } })
  expect(m.context.decision).toBe("## Verdict\nApprove.")
  // still parked at the gate — annotate must never trigger a transition
  expect(m.status).toBe("blocked")
  expect(m.node).toBe("gate")

  // deep-merge: a second annotate adds a sibling without clobbering `meta.a`
  const m2 = await daemon.annotate("gated", id, { meta: { b: 2 } })
  expect(m2.context.meta).toEqual({ a: 1, b: 2 })

  // persisted: a fresh load from the store sees the merged context
  const reload = await daemon.marble("gated", id)
  expect(reload?.context.decision).toBe("## Verdict\nApprove.")
  expect(reload?.status).toBe("blocked")
})

test("PATCH /context endpoint annotates and leaves the marble blocked", async () => {
  const id = await blockedMarble()
  const res = await fetch(`${base}/api/charts/gated/marbles/${id}/context`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merge: { decision: "go" } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as any
  expect(body.context.decision).toBe("go")
  const m = (await (await fetch(`${base}/api/charts/gated/marbles/${id}`)).json()) as any
  expect(m.status).toBe("blocked") // the whole point: operator still decides
})

test("PATCH /context with no merge object is a 400", async () => {
  const id = await blockedMarble()
  const res = await fetch(`${base}/api/charts/gated/marbles/${id}/context`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}",
  })
  expect(res.status).toBe(400)
})

test("annotating an unknown marble is a 404", async () => {
  const res = await fetch(`${base}/api/charts/gated/marbles/nope/context`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merge: { x: 1 } }),
  })
  expect(res.status).toBe(404)
})

test("present-file inlines a markdown_file whose path lives in context", async () => {
  const id = await blockedMarble()
  const briefPath = join(dir, "brief.md")
  await writeFile(briefPath, "# Brief\nlooks good")
  // The path arrives the same way a real agent would set it — via annotate.
  await daemon.annotate("gated", id, { brief_file: briefPath })

  const res = await fetch(`${base}/api/charts/gated/marbles/${id}/present-file?key=brief_file`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as any
  expect(body.path).toBe(briefPath)
  expect(body.markdown).toContain("# Brief")
})

test("present-file refuses a key that isn't a markdown_file present spec", async () => {
  const id = await blockedMarble()
  // report_path is `as: link`, not markdown_file — must not be readable as a file
  const res = await fetch(`${base}/api/charts/gated/marbles/${id}/present-file?key=report_path`)
  expect(res.status).toBe(404)
})
