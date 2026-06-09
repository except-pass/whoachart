import { test, expect } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MarbleStore } from "../src/store"
import type { Marble } from "../src/types"

function tmpDir() {
  return join(tmpdir(), "whoachart-store-" + crypto.randomUUID().slice(0, 8))
}

function marble(id: string): Marble {
  return {
    id, chart: "c", node: "a", context: { k: 1 }, history: ["a"],
    status: "queued", createdAt: "t", updatedAt: "t",
  }
}

test("save then load round-trips", async () => {
  const store = new MarbleStore(tmpDir())
  await store.init()
  await store.save(marble("m1"))
  const loaded = await store.load("m1")
  expect(loaded?.context.k).toBe(1)
})

test("load returns null for missing marble", async () => {
  const store = new MarbleStore(tmpDir())
  await store.init()
  expect(await store.load("nope")).toBeNull()
})

test("all returns every saved marble", async () => {
  const store = new MarbleStore(tmpDir())
  await store.init()
  await store.save(marble("m1"))
  await store.save(marble("m2"))
  const all = await store.all()
  expect(all.map((m) => m.id).sort()).toEqual(["m1", "m2"])
})

test("concurrent saves of the same id do not crash", async () => {
  const s = new MarbleStore(tmpDir())
  await s.init()
  const m = marble("x")
  await Promise.all([s.save(m), s.save(m), s.save(m)])
  expect((await s.load("x"))?.id).toBe("x")
})
