// tests/integration/spaceWidget.it.test.ts — OPT-IN integration test (U5).
//
// Proves the real daemon → Tinstar widget flow + by-space teardown end to end,
// against a LIVE Tinstar. Self-contained: the sandbox chart is source → end
// only — no agent/shell nodes — so nothing reaches Jira, Claude, or any
// external system. The whole suite is gated behind WHOACHART_IT=1 and SKIPPED
// otherwise, so `bun test` stays offline-safe and never touches :5273.
//
//   WHOACHART_IT=1 bun test tests/integration/spaceWidget.it.test.ts
//   (optionally TINSTAR_URL=... ; defaults to http://localhost:5273)
import { test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFile, mkdtemp } from "node:fs/promises"
import { Daemon } from "../../src/daemon"
import { TinstarClient } from "../../src/tinstar"
import { teardownSpace } from "../../src/teardown"

const IT = process.env.WHOACHART_IT === "1"
const SPACE = "_testing"
const base = process.env.TINSTAR_URL ?? "http://localhost:5273"

const CHART = `
name: _it-sandbox
nodes:
  - id: ingest
    type: source
    config: { trigger: api, form: [ { key: x, type: text } ] }
  - id: done
    type: end
    config: { outcome: success }
edges:
  - { from: ingest, to: done }
`

const client = new TinstarClient(base)

// Always clean the sandbox after the run, even on mid-test failure.
afterAll(async () => {
  if (IT) await teardownSpace(client, SPACE)
})

beforeAll(() => {
  if (IT && !process.env.TINSTAR_URL) {
    // surfaced in the test body's reachability assertion if Tinstar is down
  }
})

const itTest = IT ? test : test.skip

itTest("daemon places its widget in the sandbox space; teardown removes it", async () => {
  // Reachability gate with a clear message — IT is meant to run only against a
  // live Tinstar.
  const reachable = await client.getState()
  expect(reachable, `Tinstar not reachable at ${base} — start it or set TINSTAR_URL (WHOACHART_IT runs need a live Tinstar)`).not.toBeNull()

  const dir = await mkdtemp(join(tmpdir(), "wc-it-"))
  await writeFile(join(dir, "_it-sandbox.yaml"), CHART)
  const daemon = new Daemon({
    charts: [join(dir, "_it-sandbox.yaml")],
    storeDir: join(dir, "store"),
    client,
    baseUrl: "http://localhost:5330",
    publicUrl: "http://localhost:5330",
    space: SPACE,
  })
  await daemon.start()

  const spaceId = await client.ensureSpace(SPACE, false)
  expect(spaceId, "sandbox space should exist after daemon start").toBeTruthy()

  // Poll for the widget — ensureWidgetLoop is fire-and-forget.
  let widget: any = null
  for (let i = 0; i < 50 && !widget; i++) {
    const state = await client.getState()
    widget = (state?.browserWidgets ?? []).find(
      (w: any) => w?.title === "whoachart-_it-sandbox" && w?.spaceId === spaceId,
    )
    if (!widget) await new Promise((r) => setTimeout(r, 100))
  }
  expect(widget, `widget should land in space ${SPACE} (${spaceId})`).toBeTruthy()

  // Teardown empties the space of whoachart widgets.
  const res = await teardownSpace(client, SPACE)
  expect(res.widgets).toBeGreaterThanOrEqual(1)
  const after = await client.getState()
  const still = (after?.browserWidgets ?? []).filter(
    (w: any) => w?.spaceId === spaceId && String(w?.title ?? "").startsWith("whoachart-"),
  )
  expect(still).toHaveLength(0)
})
