// tests/jiraChart.test.ts — guards the jira-morning rewrite: cheap shell triage,
// no agent/Jira-write nodes, spawn-workon present, and lint stays clean.
import { test, expect, beforeAll } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseChart } from "../src/schema"
import { lintChart } from "../src/lint"
import { registerBuiltins } from "../src/nodeTypes"

beforeAll(() => {
  registerBuiltins()
})

function chart() {
  const yaml = readFileSync(join(import.meta.dir, "../examples/jira-morning.yaml"), "utf8")
  return parseChart(yaml)
}

test("jira-morning: triage is a cheap shell node, no agent or Jira-write nodes", () => {
  const c = chart()
  const triage = c.nodes.find((n) => n.id === "triage")
  expect(triage?.type).toBe("shell")
  expect(c.nodes.some((n) => n.type === "agent")).toBe(false)
  expect(c.nodes.some((n) => n.id === "post-comment")).toBe(false)
  expect(c.nodes.some((n) => n.id === "run-claude")).toBe(false)
  expect(c.nodes.some((n) => n.id === "spawn-workon")).toBe(true)
  expect(c.nodes.some((n) => n.id === "in-session")).toBe(true)
})

test("jira-morning: review routes to spawn-workon and skip only", () => {
  const c = chart()
  const fromReview = c.edges.filter((e) => e.from === "review").map((e) => e.name).sort()
  expect(fromReview).toEqual(["skip", "workon"])
})

test("jira-morning parses and lints clean", () => {
  expect(lintChart(chart()).warnings).toEqual([])
})
