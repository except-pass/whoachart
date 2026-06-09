import { test, expect } from "bun:test"
import { ViewState } from "../src/view/viewState"
import type { Marble } from "../src/types"

function marble(id: string, node: string, status: Marble["status"]): Marble {
  return { id, chart: "c", node, context: {}, history: [node], status, createdAt: "t", updatedAt: "t" }
}

test("live marble shows in live, not ends", () => {
  const v = new ViewState()
  v.apply(marble("m1", "work", "running"))
  const s = v.snapshot()
  expect(s.live.map((m) => m.id)).toEqual(["m1"])
  expect(Object.keys(s.ends)).toHaveLength(0)
})

test("a marble moving then finishing leaves live and tallies at the end node", () => {
  const v = new ViewState()
  v.apply(marble("m1", "work", "running"))
  v.apply(marble("m1", "done", "done")) // same id, now terminal at node 'done'
  const s = v.snapshot()
  expect(s.live).toHaveLength(0)
  expect(s.ends["done"].total).toBe(1)
  expect(s.ends["done"].recent[0]).toEqual({ id: "m1", status: "done" })
})

test("failed marbles tally with their status", () => {
  const v = new ViewState()
  v.apply(marble("m1", "halt", "failed"))
  expect(v.snapshot().ends["halt"].recent[0].status).toBe("failed")
})

test("only the last N completed are kept as dots, but total keeps counting", () => {
  const v = new ViewState(3) // N=3
  for (let i = 0; i < 10; i++) v.apply(marble(`m${i}`, "done", "done"))
  const tally = v.snapshot().ends["done"]
  expect(tally.total).toBe(10)
  expect(tally.recent).toHaveLength(3)
  expect(tally.recent.map((r) => r.id)).toEqual(["m7", "m8", "m9"]) // most recent
})

test("seed aggregates a batch of marbles", () => {
  const v = new ViewState()
  v.seed([marble("a", "work", "running"), marble("b", "done", "done"), marble("c", "done", "done")])
  const s = v.snapshot()
  expect(s.live).toHaveLength(1)
  expect(s.ends["done"].total).toBe(2)
})
