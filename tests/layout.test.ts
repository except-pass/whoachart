import { test, expect } from "bun:test"
import { layoutChart } from "../src/view/layout"
import type { Chart } from "../src/types"

const chart: Chart = {
  name: "lin",
  nodes: [
    { id: "s", type: "source", config: {} },
    { id: "w", type: "shell", config: {} },
    { id: "e", type: "end", config: {} },
  ],
  edges: [ { from: "s", to: "w" }, { from: "w", to: "e" } ],
}

test("assigns a box to every node", () => {
  const l = layoutChart(chart)
  for (const id of ["s", "w", "e"]) expect(l.boxes.has(id)).toBe(true)
})

test("ranks flow downward (source above work above end)", () => {
  const l = layoutChart(chart)
  const s = l.boxes.get("s")!, w = l.boxes.get("w")!, e = l.boxes.get("e")!
  expect(s.y).toBeLessThan(w.y)
  expect(w.y).toBeLessThan(e.y)
})

test("canvas dimensions are positive and bound the nodes", () => {
  const l = layoutChart(chart)
  expect(l.width).toBeGreaterThan(0)
  expect(l.height).toBeGreaterThan(0)
  const e = l.boxes.get("e")!
  expect(e.y + e.h).toBeLessThanOrEqual(l.height)
})

test("honors an explicit position override", () => {
  const c: Chart = { ...chart, nodes: chart.nodes.map((n) => n.id === "w" ? { ...n, position: { x: 999, y: 888 } } : n) }
  const l = layoutChart(c)
  expect(l.boxes.get("w")).toMatchObject({ x: 999, y: 888 })
})
