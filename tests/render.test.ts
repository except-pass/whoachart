import { test, expect } from "bun:test"
import { renderChart } from "../src/view/render"
import { layoutChart } from "../src/view/layout"
import type { Chart, Marble } from "../src/types"

const chart: Chart = {
  name: "demo",
  nodes: [
    { id: "s", type: "source", name: "Start", config: {} },
    { id: "w", type: "shell", name: "Work", config: {} },
    { id: "e", type: "end", name: "Done", config: {} },
  ],
  edges: [ { from: "s", to: "w", name: "go" }, { from: "w", to: "e" } ],
}

function marble(id: string, node: string, status: Marble["status"]): Marble {
  return { id, chart: "demo", node, context: {}, history: [node], status, createdAt: "t", updatedAt: "t" }
}

test("renders a self-contained html doc with one svg", () => {
  const html = renderChart(chart, [], layoutChart(chart))
  expect(html).toContain("<!DOCTYPE html>")
  expect(html).toContain("<svg")
  expect(html).toContain("viewBox")
  expect(html).toContain("preserveAspectRatio")
})

test("includes node names, the chart name, and edge labels", () => {
  const html = renderChart(chart, [], layoutChart(chart))
  expect(html).toContain("Start")
  expect(html).toContain("Work")
  expect(html).toContain("demo")
  expect(html).toContain("go")
})

test("draws marbles on their current node with status class", () => {
  const ms = [marble("m1", "w", "running"), marble("m2", "w", "queued")]
  const html = renderChart(chart, ms, layoutChart(chart))
  expect(html).toContain('class="marble running"')
  expect(html).toContain('class="marble queued"')
  expect(html).toContain(">2<")
})

test("escapes html-special characters in names", () => {
  const c: Chart = { ...chart, nodes: [{ id: "x", type: "shell", name: "a<b>&c", config: {} }], edges: [] }
  const html = renderChart(c, [], layoutChart(c))
  expect(html).toContain("a&lt;b&gt;&amp;c")
  expect(html).not.toContain("a<b>&c")
})
