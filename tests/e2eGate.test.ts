// tests/e2eGate.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Daemon } from "../src/daemon"
import { createControlApi } from "../src/controlApi"
import { clearRegistry } from "../src/registry"
import { FakeCanvas, FakeLauncher } from "./fakes"
import { waitFor } from "./poll"

let server: ReturnType<typeof Bun.serve>
let base: string
let daemon: Daemon

beforeEach(async () => {
  clearRegistry()
  daemon = new Daemon({
    charts: ["examples/gate-demo.yaml"],
    storeDir: join(tmpdir(), "wc-e2eg-" + crypto.randomUUID().slice(0, 8)),
    client: new FakeCanvas(),
    launcher: new FakeLauncher(),
  })
  await daemon.start()
  server = createControlApi(daemon, 0)
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
}

test("full human-gate flow: validated intake, gate info, validated decline, approve", async () => {
  // 1. intake form enforced
  expect((await post("/api/charts/gate-demo/marbles", { context: {} })).status).toBe(400)

  // 2. valid submission flows to the gate and blocks with gate info
  const sub = await post("/api/charts/gate-demo/marbles", { context: { title: "first", priority: "high" } })
  expect(sub.status).toBe(201)
  const { id } = (await sub.json()) as any
  const lm = await waitFor(async () => {
    const state = (await (await fetch(`${base}/api/charts/gate-demo/state`)).json()) as any
    const m = state.live.find((x: any) => x.id === id)
    return m?.status === "blocked" ? m : null
  }, { label: "marble blocks at the gate" })
  expect(lm.status).toBe("blocked")
  expect(lm.gate.agent).toBe(false)
  expect(lm.gate.edges.map((e: any) => e.name).sort()).toEqual(["approve", "decline"])
  expect(lm.gate.present[0].key).toBe("title")

  // 3. declining without the required reason is rejected — same rule for agents
  const bad = await post(`/api/charts/gate-demo/marbles/${id}/signal`, { next: "decline", merge: {} })
  expect(bad.status).toBe(400)
  expect(((await bad.json()) as any).fields.reason).toBe("required")

  // 4. declining with a reason lands at the declined end with reason merged
  await post(`/api/charts/gate-demo/marbles/${id}/signal`, { next: "decline", merge: { reason: "not ready" } })
  const m1 = await waitFor(async () => {
    const m = (await (await fetch(`${base}/api/charts/gate-demo/marbles/${id}`)).json()) as any
    return m.node === "declined" ? m : null
  }, { label: "marble lands at declined" })
  expect(m1.node).toBe("declined")
  expect(m1.context.reason).toBe("not ready")
  expect(m1.trail.map((h: any) => h.node)).toEqual(["ingest", "prep", "approve", "declined"])

  // 5. a second marble approved goes to shipped
  const sub2 = await post("/api/charts/gate-demo/marbles", { context: { title: "second" } })
  const { id: id2 } = (await sub2.json()) as any
  await waitFor(async () => {
    const m = (await (await fetch(`${base}/api/charts/gate-demo/marbles/${id2}`)).json()) as any
    return m.status === "blocked" ? m : null
  }, { label: "second marble blocks at the gate" })
  await post(`/api/charts/gate-demo/marbles/${id2}/signal`, { next: "approve" })
  const m2 = await waitFor(async () => {
    const m = (await (await fetch(`${base}/api/charts/gate-demo/marbles/${id2}`)).json()) as any
    return m.node === "shipped" ? m : null
  }, { label: "second marble ships" })
  expect(m2.node).toBe("shipped")
  expect(m2.context.priority).toBe("med") // form default applied
})

test("dead letter + retry round-trip via the API", async () => {
  const sub = await post("/api/charts/gate-demo/marbles", { context: { title: "boomer" }, start: "breaker" })
  const { id } = (await sub.json()) as any
  const landed = await waitFor(async () => {
    const state = (await (await fetch(`${base}/api/charts/gate-demo/state`)).json()) as any
    return state.deadLetter.some((d: any) => d.id === id) ? state : null
  }, { label: "marble lands in the dead-letter tray" })
  expect(landed.deadLetter.map((d: any) => d.id)).toContain(id)
  const failedAt = (await (await fetch(`${base}/api/charts/gate-demo/marbles/${id}`)).json() as any).updatedAt

  const res = await fetch(`${base}/api/charts/gate-demo/marbles/${id}/retry`, { method: "POST" })
  expect(res.status).toBe(200)
  // breaker always fails: wait for the retry to re-process (updatedAt advances)
  // and confirm it lands back in the tray exactly once (same id).
  const state = await waitFor(async () => {
    const m = (await (await fetch(`${base}/api/charts/gate-demo/marbles/${id}`)).json()) as any
    if (m.status !== "failed" || m.updatedAt === failedAt) return null
    return (await (await fetch(`${base}/api/charts/gate-demo/state`)).json()) as any
  }, { label: "marble re-fails after retry" })
  expect(state.deadLetter.filter((d: any) => d.id === id)).toHaveLength(1)
})
