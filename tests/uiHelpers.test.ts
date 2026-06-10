import { test, expect } from "bun:test"
// helpers.js is plain ESM — bun imports it directly
import {
  hue, ringFor, fmtAge, fmtMs, ageSeconds, slotPos, counterPos, enumWidget, escHtml, isDangerEdge,
  oldestBlockedPerNode,
} from "../src/ui/public/helpers.js"

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
