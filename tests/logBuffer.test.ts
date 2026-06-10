import { test, expect } from "bun:test"
import { LogBuffer } from "../src/view/logBuffer"

function add(b: LogBuffer, node: string, line: string, marble = "m1", stream: "stdout" | "stderr" | "event" = "stdout") {
  return b.append({ node, marble, stream, line, ts: "2026-06-10T00:00:00.000Z" })
}

test("since returns only lines after the cursor and advances nextSeq", () => {
  const b = new LogBuffer()
  add(b, "n", "a")
  add(b, "n", "b")
  const first = b.since("n", 0)
  expect(first.lines.map((l) => l.line)).toEqual(["a", "b"])
  expect(first.nextSeq).toBe(2)

  add(b, "n", "c")
  const delta = b.since("n", first.nextSeq)
  expect(delta.lines.map((l) => l.line)).toEqual(["c"])
  expect(delta.nextSeq).toBe(3)
})

test("since with no new lines leaves the cursor unchanged", () => {
  const b = new LogBuffer()
  add(b, "n", "a")
  const d = b.since("n", 1)
  expect(d.lines).toEqual([])
  expect(d.nextSeq).toBe(1)
})

test("unknown node yields an empty delta, not an error", () => {
  const b = new LogBuffer()
  expect(b.since("ghost", 0)).toEqual({ lines: [], nextSeq: 0 })
})

test("ring evicts oldest; since=0 returns at most the ring, never a full replay", () => {
  const b = new LogBuffer(3) // tiny ring
  for (let i = 1; i <= 10; i++) add(b, "n", `line${i}`)
  const d = b.since("n", 0)
  expect(d.lines).toHaveLength(3) // bounded, not 10
  expect(d.lines.map((l) => l.line)).toEqual(["line8", "line9", "line10"]) // oldest evicted
  expect(d.nextSeq).toBe(10) // seq is still monotonic across evictions
})

test("a cursor behind the evicted window resumes from the ring's tail (no error, no dup)", () => {
  const b = new LogBuffer(3)
  for (let i = 1; i <= 10; i++) add(b, "n", `line${i}`)
  // client last saw seq 4, but 4 has been evicted (ring holds 8,9,10)
  const d = b.since("n", 4)
  expect(d.lines.map((l) => l.line)).toEqual(["line8", "line9", "line10"])
})

test("per-node isolation: a node only sees its own lines", () => {
  const b = new LogBuffer()
  add(b, "a", "for-a")
  add(b, "b", "for-b")
  expect(b.since("a", 0).lines.map((l) => l.line)).toEqual(["for-a"])
  expect(b.since("b", 0).lines.map((l) => l.line)).toEqual(["for-b"])
})

test("marble filter narrows to one marble's lines", () => {
  const b = new LogBuffer()
  add(b, "n", "from-m1", "m1")
  add(b, "n", "from-m2", "m2")
  add(b, "n", "more-m1", "m1")
  const d = b.since("n", 0, "m1")
  expect(d.lines.map((l) => l.line)).toEqual(["from-m1", "more-m1"])
})
