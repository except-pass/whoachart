import { test, expect, beforeEach } from "bun:test"
import { z } from "zod"
import { registerNodeType, getNodeType, hasNodeType, clearRegistry } from "../src/registry"

const dummy = {
  type: "dummy",
  configSchema: z.object({}).passthrough(),
  run: async () => ({}),
}

beforeEach(() => clearRegistry())

test("register then get a node type", () => {
  registerNodeType(dummy)
  expect(hasNodeType("dummy")).toBe(true)
  expect(getNodeType("dummy").type).toBe("dummy")
})

test("getting an unknown type throws", () => {
  expect(() => getNodeType("nope")).toThrow(/unknown node type/)
})

test("double registration throws", () => {
  registerNodeType(dummy)
  expect(() => registerNodeType(dummy)).toThrow(/already registered/)
})
