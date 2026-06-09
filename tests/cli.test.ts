import { test, expect } from "bun:test"
import { parseArgs, DEFAULT_PORT } from "../src/cli"

test("parses submit with context and workpiece", () => {
  const a = parseArgs(["submit", "demo", "--context", '{"x":1}', "--workpiece", "/tmp/wp"])
  expect(a.cmd).toBe("submit")
  expect(a.chart).toBe("demo")
  expect(a.context).toEqual({ x: 1 })
  expect(a.workpiece).toBe("/tmp/wp")
})

test("parses charts command", () => {
  expect(parseArgs(["charts"]).cmd).toBe("charts")
})

test("parses marbles command with chart", () => {
  const a = parseArgs(["marbles", "demo"])
  expect(a.cmd).toBe("marbles")
  expect(a.chart).toBe("demo")
})

test("defaults port and reads --port override", () => {
  expect(parseArgs(["charts"]).port).toBe(DEFAULT_PORT)
  expect(parseArgs(["charts", "--port", "9999"]).port).toBe(9999)
})

test("invalid context json throws a clear error", () => {
  expect(() => parseArgs(["submit", "demo", "--context", "{bad"])).toThrow(/context/)
})
