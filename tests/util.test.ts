import { test, expect } from "bun:test"
import { genId, now } from "../src/util"

test("genId returns unique non-empty ids", () => {
  const a = genId(), b = genId()
  expect(a).toBeTruthy()
  expect(a).not.toBe(b)
})

test("now returns an ISO timestamp", () => {
  expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})
