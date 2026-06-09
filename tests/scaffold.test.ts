import { test, expect } from "bun:test"

test("toolchain runs typescript", () => {
  const sum = (a: number, b: number): number => a + b
  expect(sum(2, 3)).toBe(5)
})
