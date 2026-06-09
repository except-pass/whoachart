import { test, expect } from "bun:test"
import { renderShell } from "../src/view/render"
import { layoutChart } from "../src/view/layout"
import type { Chart } from "../src/types"

const chart: Chart = {
  name: "demo",
  nodes: [
    { id: "s", type: "source", name: "Start", config: {} },
    { id: "w", type: "shell", name: "Work", config: {} },
    { id: "e", type: "end", name: "Done", config: {} },
  ],
  edges: [ { from: "s", to: "w", name: "go" }, { from: "w", to: "e" } ],
}

const STATE_URL = "http://localhost:5330/api/charts/demo/state"

test("renders a self-contained html doc with one svg", () => {
  const html = renderShell(chart, layoutChart(chart), STATE_URL)
  expect(html).toContain("<!DOCTYPE html>")
  expect(html).toContain("<svg")
  expect(html).toContain("viewBox")
  expect(html).toContain("preserveAspectRatio")
})

test("includes node names, the chart name, and edge labels", () => {
  const html = renderShell(chart, layoutChart(chart), STATE_URL)
  expect(html).toContain("Start")
  expect(html).toContain("Work")
  expect(html).toContain("demo")
  expect(html).toContain("go")
})

test("embeds the live marble layer, layout, and state url for the client", () => {
  const html = renderShell(chart, layoutChart(chart), STATE_URL)
  expect(html).toContain('id="marbles"')
  expect(html).toContain('id="counts"')
  expect(html).toContain("LAYOUT=")
  expect(html).toContain(STATE_URL)
  expect(html).toContain("setInterval") // the polling loop
})

test("escapes html-special characters in names", () => {
  const c: Chart = { ...chart, nodes: [{ id: "x", type: "shell", name: "a<b>&c", config: {} }], edges: [] }
  const html = renderShell(c, layoutChart(c), STATE_URL)
  expect(html).toContain("a&lt;b&gt;&amp;c")
})

test("client runtime renders an agent face on blocked marbles", () => {
  const html = renderShell(chart, layoutChart(chart), STATE_URL)
  expect(html).toContain(".marble.agent")   // agent styling exists
  expect(html).toContain("face")             // face glyph creation
  expect(html).toContain("agentpulse")       // pulsing halo animation
})
