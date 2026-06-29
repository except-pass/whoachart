import { test, expect } from "bun:test"
import { nextRun, everyToMs, parseCron } from "../src/cron"

test("nextRun advances to the next matching minute (weekday 9am)", () => {
  // Sun 2026-06-28 10:00 local -> next weekday 09:00 is Mon 2026-06-29 09:00
  const after = new Date(2026, 5, 28, 10, 0, 0)
  const next = nextRun("0 9 * * 1-5", after)
  expect(next.getFullYear()).toBe(2026)
  expect(next.getMonth()).toBe(5)
  expect(next.getDate()).toBe(29)
  expect(next.getHours()).toBe(9)
  expect(next.getMinutes()).toBe(0)
  expect(next.getDay()).toBe(1) // Monday
})

test("nextRun is strictly after — an exact match rolls to the next occurrence", () => {
  const at = new Date(2026, 5, 29, 9, 0, 0) // exactly Mon 09:00
  const next = nextRun("0 9 * * 1-5", at)
  expect(next.getDate()).toBe(30) // Tue 09:00, not the same instant
})

test("nextRun handles step fields (every 15 min)", () => {
  const after = new Date(2026, 5, 29, 9, 7, 0)
  const next = nextRun("*/15 * * * *", after)
  expect(next.getMinutes()).toBe(15)
  expect(next.getHours()).toBe(9)
})

test("parseCron rejects a wrong field count", () => {
  expect(() => parseCron("* * * *")).toThrow(/5 fields/)
})

test("parseCron rejects out-of-range values", () => {
  expect(() => parseCron("99 * * * *")).toThrow(/out of range/)
})

test("everyToMs parses s/m/h", () => {
  expect(everyToMs("30s")).toBe(30_000)
  expect(everyToMs("15m")).toBe(900_000)
  expect(everyToMs("2h")).toBe(7_200_000)
})

test("everyToMs rejects bad forms", () => {
  expect(() => everyToMs("15")).toThrow(/expected/)
  expect(() => everyToMs("0m")).toThrow(/positive/)
})
