import { test, expect } from "bun:test"
import { legendEntries, swatchSvg, legendHtml } from "../src/ui/public/legend.js"

const def = {
  nodes: [
    { id: "in", type: "source" },
    { id: "work", type: "shell" },
    { id: "call", type: "api" },
    { id: "branch", type: "decision" },
    { id: "done", type: "end" },
  ],
}

test("legendEntries lists only shapes present, in render order, with their types", () => {
  const e = legendEntries(def)
  expect(e.map((x) => x.shape)).toEqual(["stadium", "diamond", "rect"])
  // stadium groups source+end; rect groups the steps (api, shell)
  expect(e[0]).toEqual({ shape: "stadium", label: "terminal", types: ["end", "source"] })
  expect(e[1]).toEqual({ shape: "diamond", label: "decision", types: ["decision"] })
  expect(e[2].types).toEqual(["api", "shell"])
})

test("legendEntries omits shapes that don't occur (no decisions → no diamond)", () => {
  const e = legendEntries({ nodes: [{ id: "a", type: "source" }, { id: "b", type: "shell" }] })
  expect(e.map((x) => x.shape)).toEqual(["stadium", "rect"])
})

test("legendEntries handles empty / missing nodes", () => {
  expect(legendEntries({})).toEqual([])
  expect(legendEntries({ nodes: [] })).toEqual([])
})

test("swatchSvg uses the same geometry the canvas uses (stadium pill vs step rx vs diamond polygon)", () => {
  // stadium: rx == h/2 of the 150x60 model box (h = 52 here) → full capsule
  expect(swatchSvg("stadium")).toContain('rx="26"')
  // step: the canvas's fixed rx = 11
  expect(swatchSvg("rect")).toContain('rx="11"')
  // decision: a polygon, not a rect
  expect(swatchSvg("diamond")).toContain("<polygon")
  expect(swatchSvg("diamond")).not.toContain("<rect")
})

test("legendHtml is empty when nothing to explain, populated otherwise", () => {
  expect(legendHtml({ nodes: [] })).toBe("")
  const html = legendHtml(def)
  expect(html).toContain("shapes")
  expect(html).toContain("decision")
  expect(html).toContain("terminal")
})
