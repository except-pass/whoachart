import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { registerBuiltins } from "../src/nodeTypes"
import { FakeCanvas } from "./fakes"
import { waitForStatus } from "./poll"

// A two-node chart with a blocking gate, so a marble can be parked "blocked" on
// a known node and used to exercise the hot-reload conflict gate.
const GATE_CHART = `
name: storey
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: gate
    type: human
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: gate }
  - { from: gate, to: done, name: approve }
`

// Same chart name, but the "gate" node (where a live marble parks) is renamed —
// reloading this while a marble sits on `gate` would orphan it.
const GATE_CHART_DROPS_GATE = `
name: storey
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: review
    type: human
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: review }
  - { from: review, to: done, name: approve }
`

// Same chart, "gate" preserved, only cosmetic change — always a safe reload.
const GATE_CHART_SAFE_EDIT = `
name: storey
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: gate
    type: human
    name: Human review
    config: {}
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: gate }
  - { from: gate, to: done, name: approve }
`

const NEW_CHART = `
name: freshy
nodes:
  - id: ingest
    type: source
    config: { trigger: api }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: done }
`

let daemon: Daemon
let server: ReturnType<typeof Bun.serve>
let base: string
let chartsDir: string
let storeDir: string

beforeEach(async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-store-"))
  chartsDir = join(root, "charts")
  storeDir = join(root, "store")
  await writeFile(join(await ensureDir(chartsDir), "storey.yaml"), GATE_CHART)
  daemon = new Daemon({ chartsDir, storeDir, client: new FakeCanvas() })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

async function ensureDir(d: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(d, { recursive: true })
  return d
}

// Park a marble on the `gate` node (status "blocked") so reload/delete have a
// live marble to contend with.
async function parkMarbleOnGate(): Promise<string> {
  const m = await daemon.submit("storey", {})
  const parked = await waitForStatus(() => daemon.marble("storey", m.id), "blocked")
  expect(parked.node).toBe("gate")
  return m.id
}

test("boot-loads charts from the store directory", () => {
  expect(daemon.charts()).toEqual(["storey"])
})

test("POST /api/charts registers a new chart and brings it live (hot)", async () => {
  const res = await fetch(`${base}/api/charts`, { method: "POST", body: NEW_CHART })
  expect(res.status).toBe(201)
  expect(await res.json()).toEqual({ name: "freshy", warnings: [] })
  expect(daemon.charts()).toContain("freshy")
  // persisted to the store dir
  expect(await readFile(join(chartsDir, "freshy.yaml"), "utf8")).toBe(NEW_CHART)
  // and runnable immediately, no restart
  const m = await daemon.submit("freshy", {})
  const final = await waitForStatus(() => daemon.marble("freshy", m.id), "done")
  expect(final.status).toBe("done")
})

test("POST a duplicate chart name is refused 409", async () => {
  const res = await fetch(`${base}/api/charts`, { method: "POST", body: GATE_CHART })
  expect(res.status).toBe(409)
  expect(((await res.json()) as any).error).toMatch(/already exists/)
})

test("POST with a path-traversal chart name is rejected 400 and writes nothing", async () => {
  const evil = NEW_CHART.replace("name: freshy", 'name: "../escape"')
  const res = await fetch(`${base}/api/charts`, { method: "POST", body: evil })
  expect(res.status).toBe(400)
  expect(((await res.json()) as any).error).toMatch(/invalid chart name/)
  // no file escaped the store dir
  const root = join(chartsDir, "..")
  expect((await readdir(root))).not.toContain("escape.yaml")
})

test("PUT hot-reloads a chart and preserves live marbles when their node survives", async () => {
  const id = await parkMarbleOnGate()
  const res = await fetch(`${base}/api/charts/storey`, { method: "PUT", body: GATE_CHART_SAFE_EDIT })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ name: "storey", warnings: [] })
  // the new definition is live (node renamed-for-display)
  expect(daemon.def("storey").nodes.find((n) => n.id === "gate")?.name).toBe("Human review")
  // the parked marble survived and is still blocked on gate, resumable
  const still = await daemon.marble("storey", id)
  expect(still?.status).toBe("blocked")
  expect(still?.node).toBe("gate")
  await daemon.signal("storey", id, { next: "approve" })
  const done = await waitForStatus(() => daemon.marble("storey", id), "done")
  expect(done.status).toBe("done")
})

test("PUT is refused 409 (listing the marble) when reload would drop an occupied node", async () => {
  const id = await parkMarbleOnGate()
  const res = await fetch(`${base}/api/charts/storey`, { method: "PUT", body: GATE_CHART_DROPS_GATE })
  expect(res.status).toBe(409)
  const body = (await res.json()) as any
  expect(body.conflict).toBe("live_marbles")
  expect(body.marbles).toEqual([{ id, node: "gate", status: "blocked" }])
  // chart is UNCHANGED and still live — the old topology with `gate` is intact
  expect(daemon.def("storey").nodes.map((n) => n.id)).toContain("gate")
  // and the marble is still resumable on the surviving old chart
  await daemon.signal("storey", id, { next: "approve" })
  const done = await waitForStatus(() => daemon.marble("storey", id), "done")
  expect(done.status).toBe("done")
})

test("PUT ?on_conflict=fail force-fails the orphaned marble then reloads", async () => {
  const id = await parkMarbleOnGate()
  const res = await fetch(`${base}/api/charts/storey?on_conflict=fail`, { method: "PUT", body: GATE_CHART_DROPS_GATE })
  expect(res.status).toBe(200)
  // reload happened: new topology has `review`, not `gate`
  const ids = daemon.def("storey").nodes.map((n) => n.id)
  expect(ids).toContain("review")
  expect(ids).not.toContain("gate")
  // the orphaned marble was failed in place with an explanatory error
  const failed = await daemon.marble("storey", id)
  expect(failed?.status).toBe("failed")
  expect(failed?.error).toMatch(/node "gate" no longer exists/)
})

test("PUT with a body whose name mismatches the URL is rejected 400", async () => {
  const res = await fetch(`${base}/api/charts/storey`, { method: "PUT", body: NEW_CHART })
  expect(res.status).toBe(400)
  expect(((await res.json()) as any).error).toMatch(/does not match/)
})

test("PUT on an unknown chart is 404", async () => {
  const res = await fetch(`${base}/api/charts/nope`, { method: "PUT", body: GATE_CHART_SAFE_EDIT.replace("storey", "nope") })
  expect(res.status).toBe(404)
})

test("DELETE is refused 409 when live marbles exist (without force)", async () => {
  const id = await parkMarbleOnGate()
  const res = await fetch(`${base}/api/charts/storey`, { method: "DELETE" })
  expect(res.status).toBe(409)
  const body = (await res.json()) as any
  expect(body.marbles).toEqual([{ id, node: "gate", status: "blocked" }])
  expect(daemon.charts()).toContain("storey") // still present
})

test("DELETE ?force=true removes the chart but KEEPS marble run-state files", async () => {
  await parkMarbleOnGate()
  const res = await fetch(`${base}/api/charts/storey?force=true`, { method: "DELETE" })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ name: "storey", purged: false })
  expect(daemon.charts()).not.toContain("storey")
  // chart definition file gone…
  expect(await readdir(chartsDir)).not.toContain("storey.yaml")
  // …but the marble files survive for audit
  const marbleFiles = await readdir(join(storeDir, "storey"))
  expect(marbleFiles.some((f) => f.endsWith(".json"))).toBe(true)
})

test("DELETE ?force=true&purge=true also deletes the marble run-state", async () => {
  await parkMarbleOnGate()
  const res = await fetch(`${base}/api/charts/storey?force=true&purge=true`, { method: "DELETE" })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ name: "storey", purged: true })
  // run-state directory wiped
  await expect(readdir(join(storeDir, "storey"))).rejects.toThrow()
})

test("chart writes are loopback-only: a tailnet peer gets 403 on POST/PUT/DELETE but reads/triggers still work", async () => {
  // A separate server that reports a TAILNET peer (trusted by isTrustedAddr,
  // so reads/triggers pass, but NOT loopback, so chart writes are forbidden).
  const tailnet = createControlApi(daemon, 0, { resolveAddr: () => "100.108.201.76" })
  const tbase = `http://localhost:${tailnet.port}`
  try {
    // reads + triggers are allowed from the tailnet
    expect((await fetch(`${tbase}/api/charts`)).status).toBe(200)
    const sub = await fetch(`${tbase}/api/charts/storey/marbles`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: {} }),
    })
    expect(sub.status).toBe(201) // submitting a marble (trigger) is NOT a chart write

    // but every chart-definition write is refused with 403
    expect((await fetch(`${tbase}/api/charts`, { method: "POST", body: NEW_CHART })).status).toBe(403)
    expect((await fetch(`${tbase}/api/charts/storey`, { method: "PUT", body: GATE_CHART_SAFE_EDIT })).status).toBe(403)
    expect((await fetch(`${tbase}/api/charts/storey?force=true`, { method: "DELETE" })).status).toBe(403)
    // …and nothing mutated: the chart is untouched
    expect(daemon.charts()).toContain("storey")
    expect(daemon.charts()).not.toContain("freshy")
  } finally {
    tailnet.stop(true)
  }
})

test("WHOACHART_TRUST_ALL cannot re-open chart writes: tailnet peer still gets 403 on POST/PUT/DELETE", async () => {
  // TRUST_ALL opens the base read/trigger gate, but writes are loopback-ABSOLUTE.
  const prev = process.env.WHOACHART_TRUST_ALL
  process.env.WHOACHART_TRUST_ALL = "1"
  const srv = createControlApi(daemon, 0, { resolveAddr: () => "100.108.201.76" }) // tailnet, non-loopback
  const b = `http://localhost:${srv.port}`
  try {
    // TRUST_ALL opens reads + triggers even from this peer
    expect((await fetch(`${b}/api/charts`)).status).toBe(200)
    const sub = await fetch(`${b}/api/charts/storey/marbles`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: {} }),
    })
    expect(sub.status).toBe(201)
    // …but chart writes stay forbidden — TRUST_ALL does NOT override the write gate
    expect((await fetch(`${b}/api/charts`, { method: "POST", body: NEW_CHART })).status).toBe(403)
    expect((await fetch(`${b}/api/charts/storey`, { method: "PUT", body: GATE_CHART_SAFE_EDIT })).status).toBe(403)
    expect((await fetch(`${b}/api/charts/storey?force=true`, { method: "DELETE" })).status).toBe(403)
    expect(daemon.charts()).toContain("storey")
    expect(daemon.charts()).not.toContain("freshy")
  } finally {
    srv.stop(true)
    if (prev === undefined) delete process.env.WHOACHART_TRUST_ALL
    else process.env.WHOACHART_TRUST_ALL = prev
  }
})

test("submit is serialized behind a hot-reload — never enqueues on the discarded engine", async () => {
  // Park the reload mid-swap (engine stopped, runtime not yet replaced) by
  // blocking buildRuntime on a barrier, then prove a concurrent submit cannot
  // run until the reload releases the lock. This deterministically reproduces
  // the original lost-marble window: without the shared lock, the submit would
  // enqueue onto the stopped old engine here and be stranded.
  let release!: () => void
  const barrier = new Promise<void>((r) => { release = r })
  const orig = (daemon as any).buildRuntime.bind(daemon)
  ;(daemon as any).buildRuntime = async (c: any, f: any) => { await barrier; return orig(c, f) }

  const reload = daemon.updateChart("storey", GATE_CHART_SAFE_EDIT) // acquires lock, stops engine, parks at barrier
  await new Promise((r) => setTimeout(r, 30)) // let updateChart reach the barrier

  const submitP = daemon.submit("storey", {}) // must queue behind the reload
  await new Promise((r) => setTimeout(r, 30))
  // mutual exclusion proof: while the reload holds the lock, no marble exists yet
  expect((await daemon.marbles("storey")).length).toBe(0)

  release()
  const m = await submitP
  await reload
  ;(daemon as any).buildRuntime = orig
  // the marble landed on the live (new) engine and reached the gate — not lost
  const parked = await waitForStatus(() => daemon.marble("storey", m.id), "blocked")
  expect(parked.node).toBe("gate")
})

test("a reload whose rebuild throws revives the old chart and returns 503", async () => {
  const orig = (daemon as any).buildRuntime.bind(daemon)
  ;(daemon as any).buildRuntime = async () => { throw new Error("boom rebuild") }
  let status = 0
  try {
    await daemon.updateChart("storey", GATE_CHART_SAFE_EDIT)
  } catch (err) {
    status = (err as { status?: number }).status ?? 0
  }
  expect(status).toBe(503)
  ;(daemon as any).buildRuntime = orig
  // the old chart is still alive and serving — a submit still reaches the gate
  const m = await daemon.submit("storey", {})
  const parked = await waitForStatus(() => daemon.marble("storey", m.id), "blocked")
  expect(parked.node).toBe("gate")
})

test("a reload whose engine never quiesces revives the old chart and returns 503", async () => {
  // The OTHER 503 path: engine.stop() rejecting (a node that won't settle) — distinct
  // from the rebuild-throws path above. Both must revive the old runtime, not wedge it.
  const rt = (daemon as any).runtimes.get("storey")
  const origStop = rt.engine.stop.bind(rt.engine)
  rt.engine.stop = async () => { throw new Error("did not quiesce") }
  let status = 0
  try {
    await daemon.updateChart("storey", GATE_CHART_SAFE_EDIT)
  } catch (err) {
    status = (err as { status?: number }).status ?? 0
  }
  expect(status).toBe(503)
  rt.engine.stop = origStop
  // revived via resume() — the old chart still serves and a submit reaches the gate
  const m = await daemon.submit("storey", {})
  const parked = await waitForStatus(() => daemon.marble("storey", m.id), "blocked")
  expect(parked.node).toBe("gate")
})

test("boot-loads a legacy .yml chart without crashing (read/path honor .yml)", async () => {
  clearRegistry(); registerBuiltins()
  const root = await mkdtemp(join(tmpdir(), "wc-yml-"))
  const cdir = await ensureDir(join(root, "charts"))
  await writeFile(join(cdir, "ymly.yml"), NEW_CHART.replace("name: freshy", "name: ymly"))
  const d = new Daemon({ chartsDir: cdir, storeDir: join(root, "store"), client: new FakeCanvas() })
  await d.start()
  expect(d.charts()).toContain("ymly")
  // and it actually runs — proving read() resolved the .yml rather than ENOENT-ing
  const m = await d.submit("ymly", {})
  const final = await waitForStatus(() => d.marble("ymly", m.id), "done")
  expect(final.status).toBe("done")
})

test("a registered chart survives a daemon restart (store dir is authoritative)", async () => {
  await fetch(`${base}/api/charts`, { method: "POST", body: NEW_CHART })
  // simulate restart: fresh daemon over the same dirs
  clearRegistry(); registerBuiltins()
  const d2 = new Daemon({ chartsDir, storeDir, client: new FakeCanvas() })
  await d2.start()
  expect(d2.charts().sort()).toEqual(["freshy", "storey"])
})
