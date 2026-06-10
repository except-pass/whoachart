import { test, expect } from "bun:test"
// helpers.js is plain ESM — bun imports it directly
import {
  hue, ringFor, fmtAge, fmtMs, ageSeconds, slotPos, counterPos, enumWidget, escHtml, isDangerEdge,
  oldestBlockedPerNode, shapeForType, diamondHalfWidth, fitLabel,
} from "../src/ui/public/helpers.js"

test("diamondHalfWidth is full at the center and tapers to a point at the vertices", () => {
  expect(diamondHalfWidth(150, 60, 0)).toBe(75) // centerline: full half-width
  expect(diamondHalfWidth(150, 60, 30)).toBe(0) // top/bottom vertex: a point
  expect(diamondHalfWidth(150, 60, 15)).toBe(37.5) // halfway down: half the room
  expect(diamondHalfWidth(150, 60, 999)).toBe(0) // never negative past the vertex
})

test("fitLabel truncates with an ellipsis only when needed, and degrades safely", () => {
  expect(fitLabel("decision", 100, 5.8)).toBe("decision") // fits → unchanged
  const t = fitLabel("a-very-long-subtitle", 40, 5.8) // ~6 chars fit
  expect(t.endsWith("…")).toBe(true)
  expect(t.length).toBeLessThan("a-very-long-subtitle".length)
  expect(fitLabel("anything", 0, 5.8)).toBe("") // no room → empty, not "…"
})

test("shapeForType maps terminals to stadium, decision to diamond, rest to rect", () => {
  expect(shapeForType("source")).toBe("stadium")
  expect(shapeForType("end")).toBe("stadium")
  expect(shapeForType("decision")).toBe("diamond")
  expect(shapeForType("shell")).toBe("rect")
  expect(shapeForType("agent")).toBe("rect")
  expect(shapeForType("api")).toBe("rect")
  expect(shapeForType("human")).toBe("rect")
  expect(shapeForType("anything-unknown")).toBe("rect") // unknown types stay a plain step
})

test("oldestBlockedPerNode picks the FIFO marble per node, skipping agents and non-blocked", () => {
  const gate = { edges: [{ name: "ok" }] }
  const live = [
    { id: "m1", node: "a", status: "blocked", gate, enteredAt: "2026-06-10T00:02:00Z" },
    { id: "m2", node: "a", status: "blocked", gate, enteredAt: "2026-06-10T00:01:00Z" },
    { id: "m3", node: "a", status: "running", gate, enteredAt: "2026-06-10T00:00:00Z" },
    { id: "m4", node: "b", status: "blocked", gate: { ...gate, agent: "bot" }, enteredAt: "2026-06-10T00:00:00Z" },
    { id: "m5", node: "c", status: "blocked", enteredAt: "2026-06-10T00:00:00Z" },
  ]
  const byNode = oldestBlockedPerNode(live)
  expect([...byNode.keys()]).toEqual(["a"])
  expect(byNode.get("a").id).toBe("m2")
})

test("oldestBlockedPerNode keeps one marble per node and breaks ties by first seen", () => {
  const gate = { edges: [{ name: "ok" }] }
  const live = [
    { id: "a1", node: "a", status: "blocked", gate, enteredAt: "2026-06-10T00:00:00Z" },
    { id: "a2", node: "a", status: "blocked", gate, enteredAt: "2026-06-10T00:00:00Z" },
    { id: "b1", node: "b", status: "blocked", gate, enteredAt: "2026-06-10T00:05:00Z" },
  ]
  const byNode = oldestBlockedPerNode(live)
  expect([...byNode.keys()].sort()).toEqual(["a", "b"])
  expect(byNode.get("a").id).toBe("a1") // tie → first seen wins
  expect(byNode.get("b").id).toBe("b1")
})

test("isDangerEdge matches whole words only", () => {
  expect(isDangerEdge("reject")).toBe(true)
  expect(isDangerEdge("decline politely")).toBe(true)
  expect(isDangerEdge("no")).toBe(true)
  expect(isDangerEdge("mark failed")).toBe(true)
  expect(isDangerEdge("Reject")).toBe(true)
  expect(isDangerEdge("FAIL")).toBe(true)
  expect(isDangerEdge("acknowledge")).toBe(false)
  expect(isDangerEdge("snooze")).toBe(false)
  expect(isDangerEdge("normal")).toBe(false)
  expect(isDangerEdge("approve")).toBe(false)
})

test("hue is deterministic and varies by id", () => {
  expect(hue("abc")).toBe(hue("abc"))
  expect(hue("abc")).not.toBe(hue("abd"))
  expect(hue("abc")).toMatch(/^hsl\(\d+ 72% 62%\)$/)
})

test("ringFor encodes status on the ring", () => {
  expect(ringFor("failed")[0]).toBe("#ef4444")
  expect(ringFor("running")[0]).toBe("#eaf7ff")
  expect(ringFor("blocked")[0]).toBe("#eaf7ff")
  expect(ringFor("done")[1]).toBe(1.25)
})

test("fmtAge is quiet under a minute, compact above", () => {
  expect(fmtAge(45)).toBe("")
  expect(fmtAge(125)).toBe("2m")
  expect(fmtAge(7300)).toBe("2h1m")
  expect(fmtAge(7200)).toBe("2h")
})

test("fmtMs scales units", () => {
  expect(fmtMs(840)).toBe("840ms")
  expect(fmtMs(2100)).toBe("2.1s")
  expect(fmtMs(240_000)).toBe("4m")
})

test("ageSeconds clamps to zero", () => {
  const now = Date.parse("2026-06-10T00:01:00Z")
  expect(ageSeconds("2026-06-10T00:00:00.000Z", now)).toBe(60)
  expect(ageSeconds("2026-06-10T00:02:00.000Z", now)).toBe(0)
})

test("slotPos centers a row under the node; counterPos sits to its right", () => {
  const box = { x: 100, y: 50, w: 150, h: 60 }
  expect(slotPos(box, 0, 1)).toEqual({ x: 175, y: 123 })
  const left = slotPos(box, 0, 3)
  const right = slotPos(box, 2, 3)
  expect(right.x - left.x).toBe(36)
  expect(counterPos(box).x).toBeGreaterThan(right.x)
})

test("enumWidget picks radio for short lists, select for long", () => {
  expect(enumWidget(["a", "b"])).toBe("radio")
  expect(enumWidget(["a", "b", "c", "d", "e"])).toBe("select")
})

test("escHtml escapes the dangerous four", () => {
  expect(escHtml(`<a href="x">&`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;")
})

import { trailSteps } from "../src/ui/public/helpers.js"

test("trailSteps: snapshots, dwell, changed keys, live tail", () => {
  const marble = {
    context: { a: 1, b: "edited", review: "note" },
    trail: [
      { node: "ingest", enteredAt: "2026-06-10T00:00:00.000Z", leftAt: "2026-06-10T00:00:01.000Z", context: { a: 1 } },
      { node: "work", enteredAt: "2026-06-10T00:00:01.000Z", leftAt: "2026-06-10T00:00:03.000Z", context: { a: 1, b: "made" } },
      { node: "gate", enteredAt: "2026-06-10T00:00:03.000Z" }, // open hop → live context
    ],
  }
  const steps = trailSteps(marble)
  expect(steps).toHaveLength(3)
  expect(steps[0].changedKeys).toEqual([]) // no previous snapshot
  expect(steps[0].dwellMs).toBe(1000)
  expect(steps[1].changedKeys).toEqual(["b"]) // b added at work
  expect(steps[1].context).toEqual({ a: 1, b: "made" })
  expect(steps[2].live).toBe(true)
  expect(steps[2].context).toEqual(marble.context) // open hop shows current state
  expect(steps[2].changedKeys.sort()).toEqual(["b", "review"]) // b edited + review added
  expect(steps[2].dwellMs).toBeNull()
})

test("trailSteps: legacy hops without snapshots degrade gracefully", () => {
  const steps = trailSteps({
    context: { x: 1 },
    trail: [
      { node: "a", enteredAt: "t", leftAt: "t2" }, // closed, no snapshot (pre-feature record)
      { node: "b", enteredAt: "t2" },
    ],
  })
  expect(steps[0].context).toBeNull()
  expect(steps[0].changedKeys).toEqual([])
  expect(steps[1].context).toEqual({ x: 1 })
  expect(steps[1].changedKeys).toEqual([]) // no baseline to diff against
})

test("trailSteps: no trail at all", () => {
  expect(trailSteps({ context: { x: 1 } })).toEqual([])
})

import { diffContext } from "../src/ui/public/helpers.js"

test("diffContext reports added/removed/changed with values", () => {
  const d = diffContext({ a: 1, b: "x", gone: true }, { a: 1, b: "y", fresh: [1] })
  const by = Object.fromEntries(d.map((c: any) => [c.key, c]))
  expect(by.b).toEqual({ key: "b", kind: "changed", before: "x", after: "y" })
  expect(by.gone).toEqual({ key: "gone", kind: "removed", before: true })
  expect(by.fresh).toEqual({ key: "fresh", kind: "added", after: [1] })
  expect(by.a).toBeUndefined()
})

test("trailSteps carries structured changes", () => {
  const steps = trailSteps({
    context: { a: 2 },
    trail: [
      { node: "x", enteredAt: "t", leftAt: "t2", context: { a: 1 } },
      { node: "y", enteredAt: "t2" },
    ],
  })
  expect(steps[1].changes).toEqual([{ key: "a", kind: "changed", before: 1, after: 2 }])
})
