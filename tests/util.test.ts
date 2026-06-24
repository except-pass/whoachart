import { test, expect } from "bun:test"
import { genId, now, deepMerge } from "../src/util"

test("genId returns unique non-empty ids", () => {
  const a = genId(), b = genId()
  expect(a).toBeTruthy()
  expect(a).not.toBe(b)
})

test("now returns an ISO timestamp", () => {
  expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})

test("deepMerge recurses into plain objects, replaces scalars/arrays", () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, arr: [1, 2] }
  const out = deepMerge(base, { a: 9, nested: { y: 3, z: 4 }, arr: [9] })
  expect(out).toEqual({ a: 9, nested: { x: 1, y: 3, z: 4 }, arr: [9] })
  expect(base).toEqual({ a: 1, nested: { x: 1, y: 2 }, arr: [1, 2] }) // base untouched
})

test("deepMerge replaces an object with a scalar (and vice versa)", () => {
  expect(deepMerge({ k: { a: 1 } }, { k: "now-a-string" })).toEqual({ k: "now-a-string" })
  expect(deepMerge({ k: "scalar" }, { k: { a: 1 } })).toEqual({ k: { a: 1 } })
})
