import { test, expect } from "bun:test"
import { Window } from "happy-dom"
import { initViewport } from "../src/ui/public/viewport.js"
import { initLegend } from "../src/ui/public/legend.js"

const def = {
  layout: { width: 1000, height: 500, boxes: { a: { x: 10, y: 10, w: 150, h: 60 }, b: { x: 10, y: 200, w: 150, h: 60 } } },
  nodes: [
    { id: "a", type: "source" },
    { id: "b", type: "decision" },
  ],
}

const SVGNS = "http://www.w3.org/2000/svg"

// Mirror tests/uiNodeDrawer.test.ts: install happy-dom's document as the global
// the client modules reach for, then build the #canvas/#svg scaffold.
function mount() {
  const window = new Window()
  ;(globalThis as any).document = window.document
  ;(globalThis as any).Event = window.Event
  const doc = window.document
  const canvas = doc.createElement("div")
  canvas.className = "canvas"
  const svg = doc.createElementNS(SVGNS, "svg")
  svg.setAttribute("viewBox", "0 0 1000 500")
  canvas.appendChild(svg)
  doc.body.appendChild(canvas)
  return { canvas: canvas as any, svg: svg as any }
}

test("initViewport injects minimap + zoom controls and drives the svg viewBox", () => {
  const { canvas, svg } = mount()
  initViewport(svg, canvas, def)

  expect(canvas.querySelector("#minimap")).toBeTruthy()
  expect(canvas.querySelector(".vpzoom .vpin")).toBeTruthy()

  // At fit, the viewBox is the whole chart and the minimap is hidden.
  expect(svg.getAttribute("viewBox")).toBe("0 0 1000 500")
  expect(canvas.querySelector("#minimap").classList.contains("hidden")).toBe(true)

  // Zooming in shrinks the viewBox (window onto user space) and reveals the minimap.
  canvas.querySelector(".vpzoom .vpin").click()
  const vb = svg.getAttribute("viewBox").split(" ").map(Number)
  expect(vb[2]).toBeLessThan(1000) // narrower window == zoomed in
  expect(vb[2] / vb[3]).toBeCloseTo(1000 / 500) // aspect preserved
  expect(canvas.querySelector("#minimap").classList.contains("hidden")).toBe(false)

  // Fit returns to the whole chart.
  canvas.querySelector(".vpzoom .vpfit").click()
  expect(svg.getAttribute("viewBox")).toBe("0 0 1000 500")
})

test("initLegend injects a legend describing only the shapes present", () => {
  const { canvas } = mount()
  initLegend(canvas, def)
  const legend = canvas.querySelector("#legend")
  expect(legend).toBeTruthy()
  expect(legend.textContent).toContain("terminal") // source → stadium
  expect(legend.textContent).toContain("decision") // decision → diamond
  expect(legend.querySelectorAll(".lgrow").length).toBe(2) // no rect-shaped nodes here
})
