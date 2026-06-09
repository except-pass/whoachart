import { test, expect } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runChartFile } from "../src/run"

test("build-pipeline example: passing marble reaches 'shipped'", async () => {
  const dir = join(tmpdir(), "wc-e2e-" + crypto.randomUUID().slice(0, 8))
  const marble = await runChartFile("examples/build-pipeline.yaml", {
    start: "ingest",
    context: { tests_pass: "yes" },
    storeDir: dir,
  })
  expect(marble.status).toBe("done")
  expect(marble.node).toBe("shipped")
  expect(marble.history).toContain("build")
})

test("build-pipeline example: failing marble reaches 'halted'", async () => {
  const dir = join(tmpdir(), "wc-e2e-" + crypto.randomUUID().slice(0, 8))
  const marble = await runChartFile("examples/build-pipeline.yaml", {
    start: "ingest",
    context: { tests_pass: "no" },
    storeDir: dir,
  })
  expect(marble.status).toBe("failed")
  expect(marble.node).toBe("halted")
})
