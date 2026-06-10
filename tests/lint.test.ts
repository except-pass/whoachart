// tests/lint.test.ts — static-analysis checks in src/lint.ts. lintChart operates
// on a parsed Chart object (no YAML, no registry), so these build charts inline.
import { test, expect } from "bun:test"
import { lintChart } from "../src/lint"
import type { Chart, ChartNode, ChartEdge } from "../src/types"

function node(id: string, type: string): ChartNode {
  return { id, type, config: {} }
}
function chart(nodes: ChartNode[], edges: ChartEdge[] = []): Chart {
  return { name: "t", nodes, edges }
}
function codes(c: Chart): string[] {
  return lintChart(c).warnings.map((w) => w.code).sort()
}

test("a clean source → … → end chart has no findings", () => {
  const c = chart(
    [node("in", "source"), node("work", "shell"), node("out", "end")],
    [{ from: "in", to: "work" }, { from: "work", to: "out" }],
  )
  const res = lintChart(c)
  expect(res.warnings).toEqual([])
  expect(res.errors).toEqual([])
})

test("flags a node unreachable from any source/entry", () => {
  // island = lonely → orphan, but nothing routes into `lonely` from the source
  // chain, and `lonely` HAS an incoming edge so it isn't an entry point itself.
  const c = chart(
    [node("in", "source"), node("out", "end"), node("orphan", "shell"), node("lonely", "shell")],
    [{ from: "in", to: "out" }, { from: "lonely", to: "orphan" }, { from: "orphan", to: "lonely" }],
  )
  const w = lintChart(c).warnings.filter((x) => x.code === "unreachable-node")
  // lonely+orphan form a closed cycle with no entry → both unreachable
  expect(w.map((x) => x.node).sort()).toEqual(["lonely", "orphan"])
  expect(w.every((x) => x.level === "warn")).toBe(true)
})

test("flags a decision node with no outgoing edges", () => {
  const c = chart(
    [node("in", "source"), node("d", "decision")],
    [{ from: "in", to: "d" }],
  )
  const w = lintChart(c).warnings.find((x) => x.code === "decision-no-outgoing")
  expect(w).toBeDefined()
  expect(w!.node).toBe("d")
  expect(w!.level).toBe("warn")
})

test("flags a non-end leaf node as a dead end (not as a decision)", () => {
  const c = chart(
    [node("in", "source"), node("work", "shell")],
    [{ from: "in", to: "work" }],
  )
  const codeset = codes(c)
  expect(codeset).toContain("dead-end")
  expect(codeset).not.toContain("decision-no-outgoing")
})

test("end nodes are not flagged as dead ends", () => {
  const c = chart([node("in", "source"), node("out", "end")], [{ from: "in", to: "out" }])
  expect(codes(c)).not.toContain("dead-end")
})

test("flags a source that is routed into (has an incoming edge)", () => {
  const c = chart(
    [node("in", "source"), node("work", "shell"), node("out", "end")],
    [{ from: "in", to: "work" }, { from: "work", to: "in" }, { from: "work", to: "out" }],
  )
  const w = lintChart(c).warnings.find((x) => x.code === "source-with-incoming")
  expect(w).toBeDefined()
  expect(w!.node).toBe("in")
  expect(w!.level).toBe("warn")
})

test("flags an end node with an outgoing edge as info (not warn)", () => {
  const c = chart(
    [node("in", "source"), node("out", "end"), node("after", "shell")],
    [{ from: "in", to: "out" }, { from: "out", to: "after" }, { from: "after", to: "out" }],
  )
  const w = lintChart(c).warnings.find((x) => x.code === "end-with-outgoing")
  expect(w).toBeDefined()
  expect(w!.node).toBe("out")
  expect(w!.level).toBe("info")
})

test("defensively flags dangling edge endpoints (parseChart hard-fails these first)", () => {
  const c = chart([node("in", "source"), node("out", "end")], [
    { from: "in", to: "ghost" },
    { from: "phantom", to: "out" },
  ])
  const w = lintChart(c).warnings.filter((x) => x.code === "dangling-edge")
  expect(w).toHaveLength(2)
  expect(w[0].edge).toEqual({ from: "in", to: "ghost" })
})

test("defensively flags duplicate node ids (parseChart hard-fails these first)", () => {
  const c = chart([node("dup", "source"), node("dup", "end")], [])
  const w = lintChart(c).warnings.find((x) => x.code === "duplicate-id")
  expect(w).toBeDefined()
  expect(w!.node).toBe("dup")
})

// --- pinning tests: behaviors verified by hand in review, locked in here ---

test("a source-less chart treats no-incoming nodes as entry points (nothing unreachable)", () => {
  // No `source` node at all. `head` has no incoming → it's the entry point, so
  // the whole chain is reachable; only the missing terminal is a dead end.
  const c = chart(
    [node("head", "shell"), node("mid", "shell"), node("tail", "end")],
    [{ from: "head", to: "mid" }, { from: "mid", to: "tail" }],
  )
  expect(codes(c)).not.toContain("unreachable-node")
})

test("an isolated island node is a dead end, NOT unreachable", () => {
  // A lone node with no edges has no incoming → it's an entry point (reachable),
  // but no outgoing and isn't an end → dead end. It must not be double-flagged.
  const c = chart(
    [node("in", "source"), node("out", "end"), node("island", "shell")],
    [{ from: "in", to: "out" }],
  )
  const found = lintChart(c).warnings.filter((w) => w.node === "island").map((w) => w.code)
  expect(found).toContain("dead-end")
  expect(found).not.toContain("unreachable-node")
})

test("a decision with one outgoing edge raises no false dead-end/decision warning", () => {
  const c = chart(
    [node("in", "source"), node("d", "decision"), node("out", "end")],
    [{ from: "in", to: "d" }, { from: "d", to: "out", name: "go" }],
  )
  const codeset = codes(c)
  expect(codeset).not.toContain("decision-no-outgoing")
  expect(codeset).not.toContain("dead-end")
})
