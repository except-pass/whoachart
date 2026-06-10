import { test, expect } from "bun:test"
import { ViewState } from "../src/view/viewState"
import type { Chart, Marble } from "../src/types"

const chart: Chart = {
  name: "c",
  nodes: [
    { id: "work", type: "shell", config: {} },
    { id: "gate", type: "human", stuck_after: 60, present: [{ key: "title", as: "text" }], config: {} },
    { id: "agentstep", type: "agent", config: {} },
    { id: "done", type: "end", config: {} },
  ],
  edges: [
    { from: "work", to: "gate" },
    { from: "gate", to: "done", name: "ok", form: [{ key: "note", type: "textarea", required: true }] },
    { from: "gate", to: "work", name: "redo" },
    { from: "agentstep", to: "done", name: "ship" },
  ],
}

function marble(id: string, node: string, status: Marble["status"], extra: Partial<Marble> = {}): Marble {
  return {
    id, chart: "c", node, context: {}, history: [node],
    trail: [{ node, enteredAt: "2026-06-10T00:00:00.000Z" }],
    status, createdAt: "t", updatedAt: "u", ...extra,
  }
}

test("live marbles carry enteredAt from the trail", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "work", "running"))
  expect(v.snapshot().live[0].enteredAt).toBe("2026-06-10T00:00:00.000Z")
})

test("blocked marble at a human node exposes gate info", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "gate", "blocked"))
  const gate = v.snapshot().live[0].gate!
  expect(gate.agent).toBe(false)
  expect(gate.edges.map((e) => e.name)).toEqual(["ok", "redo"])
  expect(gate.edges[0].form![0].key).toBe("note")
  expect(gate.present![0].key).toBe("title")
})

test("blocked marble at an agent node is flagged agent", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "agentstep", "blocked"))
  expect(v.snapshot().live[0].gate!.agent).toBe(true)
})

test("closed trail hops feed dwell stats exactly once", () => {
  const v = new ViewState(chart)
  const trail = [
    { node: "work", enteredAt: "2026-06-10T00:00:00.000Z", leftAt: "2026-06-10T00:00:01.000Z" },
    { node: "gate", enteredAt: "2026-06-10T00:00:01.000Z" },
  ]
  v.apply(marble("m1", "gate", "blocked", { trail }))
  v.apply(marble("m1", "gate", "blocked", { trail })) // re-apply: no double count
  const s = v.snapshot().stats
  expect(s.work.runs).toBe(1)
  expect(s.work.dwellP50).toBe(1000)
  expect(s.work.dwellP95).toBe(1000)
})

test("errored marbles go to deadLetter (first line), not the end tally", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "work", "failed", { error: "exit 7: boom\nstack stack" }))
  const snap = v.snapshot()
  expect(snap.deadLetter).toEqual([{ id: "m1", node: "work", error: "exit 7: boom", failedAt: "u" }])
  expect(Object.keys(snap.ends)).toHaveLength(0)
  expect(snap.stats.work.fails).toBe(1)
})

test("a retried marble leaves the dead letter tray", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "work", "failed", { error: "boom" }))
  v.apply(marble("m1", "work", "queued"))
  expect(v.snapshot().deadLetter).toHaveLength(0)
})

test("outcome-fail at an end node tallies normally (no error => not a dead letter)", () => {
  const v = new ViewState(chart)
  v.apply(marble("m1", "done", "failed"))
  expect(v.snapshot().ends.done.total).toBe(1)
  expect(v.snapshot().deadLetter).toHaveLength(0)
})

test("dead letter tray is bounded to 20", () => {
  const v = new ViewState(chart)
  for (let i = 0; i < 25; i++) v.apply(marble(`m${i}`, "work", "failed", { error: "x" }))
  expect(v.snapshot().deadLetter).toHaveLength(20)
})

test("recent dots stay bounded while totals keep counting", () => {
  const v = new ViewState(chart, 3)
  for (let i = 0; i < 10; i++) v.apply(marble(`m${i}`, "done", "done"))
  const t = v.snapshot().ends.done
  expect(t.total).toBe(10)
  expect(t.recent.map((r) => r.id)).toEqual(["m7", "m8", "m9"])
})
