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

test("parses signal command with next and merge", () => {
  const a = parseArgs(["signal", "agency", "m1", "--next", "pass", "--merge", '{"v":1}'])
  expect(a.cmd).toBe("signal")
  expect(a.chart).toBe("agency")
  expect(a.marble).toBe("m1")
  expect(a.next).toBe("pass")
  expect(a.merge).toEqual({ v: 1 })
})
