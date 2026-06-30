import { test, expect, beforeEach } from "bun:test"
import { Window } from "happy-dom"
import { renderMiniChart, clearMiniChart, type MiniDef } from "../src/ui/public/miniChart.js"

const NS = "http://www.w3.org/2000/svg"

function svg() {
  const window = new Window()
  ;(globalThis as any).document = window.document
  return window.document.createElementNS(NS, "svg") as any
}

// 3 nodes (source -> decision -> end), 2 edges.
const DEF: MiniDef = {
  nodes: [
    { id: "a", type: "source" },
    { id: "b", type: "decision", name: "branch" },
    { id: "c", type: "end" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ],
  layout: { width: 400, height: 300, boxes: {
    a: { x: 10, y: 10, w: 150, h: 60 },
    b: { x: 10, y: 120, w: 150, h: 60 },
    c: { x: 10, y: 230, w: 150, h: 60 },
  } },
}

test("renders one node shape per node and one edge path per edge, sized to layout", () => {
  const s = svg()
  renderMiniChart(s, DEF, { live: [] })
  expect(s.getAttribute("viewBox")).toBe("0 0 400 300")
  // source + end are stadium (rect with full rounding), decision is a polygon.
  expect(s.querySelectorAll(".mc-nodes .node").length).toBe(3)
  expect(s.querySelectorAll(".mc-nodes polygon").length).toBe(1) // the decision diamond
  expect(s.querySelectorAll(".mc-edges .mc-edge").length).toBe(2)
})

test("renders zero iframes (SVG only)", () => {
  const s = svg()
  renderMiniChart(s, DEF, { live: [] })
  expect(s.querySelectorAll("iframe").length).toBe(0)
})

test("places two marbles on the same node at distinct offsets", () => {
  const s = svg()
  renderMiniChart(s, DEF, { live: [
    { id: "m1", node: "b", status: "running" },
    { id: "m2", node: "b", status: "running" },
  ] })
  const marbles = [...s.querySelectorAll(".mc-marbles .mc-marble")]
  expect(marbles).toHaveLength(2)
  const xs = marbles.map((m: any) => m.getAttribute("cx"))
  expect(xs[0]).not.toBe(xs[1]) // slotPos spreads them, not overlapping
})

test("marble ring color reflects status (failed = red)", () => {
  const s = svg()
  renderMiniChart(s, DEF, { live: [{ id: "x", node: "c", status: "failed" }] })
  const m = s.querySelector(".mc-marbles .mc-marble") as any
  expect(m.getAttribute("stroke")).toBe("#ef4444")
})

test("node stroke resolves color: explicit n.color > TYPE_COLOR map > fallback", () => {
  const s = svg()
  renderMiniChart(s, {
    nodes: [
      { id: "a", type: "source" }, // TYPE_COLOR.source
      { id: "b", type: "weirdtype" }, // unmapped -> fallback #2a3340
      { id: "c", type: "end", color: "#ff00ff" }, // explicit override wins
    ],
    edges: [],
    layout: { width: 200, height: 200, boxes: {
      a: { x: 0, y: 0, w: 80, h: 40 }, b: { x: 0, y: 60, w: 80, h: 40 }, c: { x: 0, y: 120, w: 80, h: 40 },
    } },
  } as any, { live: [] })
  const shapes = [...s.querySelectorAll(".mc-nodes .node")] as any[]
  expect(shapes[0].getAttribute("stroke")).toBe("#3a5566") // TYPE_COLOR.source
  expect(shapes[1].getAttribute("stroke")).toBe("#2a3340") // fallback
  expect(shapes[2].getAttribute("stroke")).toBe("#ff00ff") // explicit override
})

test("a marble on an unknown node is skipped, not an error", () => {
  const s = svg()
  expect(() => renderMiniChart(s, DEF, { live: [{ id: "g", node: "ghost", status: "running" }] })).not.toThrow()
  expect(s.querySelectorAll(".mc-marble").length).toBe(0)
})

test("re-render replaces prior content (idempotent); clear empties the svg", () => {
  const s = svg()
  renderMiniChart(s, DEF, { live: [{ id: "m1", node: "a", status: "running" }] })
  expect(s.querySelectorAll(".mc-marble").length).toBe(1)
  renderMiniChart(s, DEF, { live: [] }) // marble gone now
  expect(s.querySelectorAll(".mc-marble").length).toBe(0)
  expect(s.querySelectorAll(".node").length).toBe(3) // not duplicated
  clearMiniChart(s)
  expect(s.childNodes.length).toBe(0)
})

test("tolerates a def with no layout (renders nothing, no throw)", () => {
  const s = svg()
  expect(() => renderMiniChart(s, { nodes: [], edges: [] } as any, { live: [] })).not.toThrow()
})
