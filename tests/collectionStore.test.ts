import { test, expect } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, writeFile } from "node:fs/promises"
import { CollectionStore } from "../src/collectionStore"

const MANIFEST = `
name: srena
title: Serena's loop
description: grouped charts
members:
  - prod-health-sweep
  - pdca-pull
`

async function freshStore(): Promise<CollectionStore> {
  const dir = await mkdtemp(join(tmpdir(), "wc-coll-"))
  return new CollectionStore(dir)
}

test("write then read round-trips a manifest, and listNames reports it", async () => {
  const store = await freshStore()
  await store.write("srena", MANIFEST)
  expect(await store.read("srena")).toBe(MANIFEST)
  expect(await store.listNames()).toEqual(["srena"])
})

test("exists is false for an unknown name, true after write", async () => {
  const store = await freshStore()
  expect(await store.exists("srena")).toBe(false)
  await store.write("srena", MANIFEST)
  expect(await store.exists("srena")).toBe(true)
})

test("link registers an external manifest by reference (discoverable via listNames/read)", async () => {
  const store = await freshStore()
  const ext = join(await mkdtemp(join(tmpdir(), "wc-ext-")), "mine.yaml")
  await writeFile(ext, MANIFEST)
  await store.link("srena", ext)
  expect(await store.listNames()).toEqual(["srena"])
  expect(await store.read("srena")).toBe(MANIFEST) // symlink followed
})

test("a traversal name is rejected before any fs op", async () => {
  const store = await freshStore()
  expect(() => store.path("../evil")).toThrow(/invalid chart name/)
  await expect(store.exists("../evil")).rejects.toThrow(/invalid chart name/)
})

test("a legacy .yml manifest resolves on read", async () => {
  const store = await freshStore()
  await store.init()
  await writeFile(join(store.dir, "legacy.yml"), MANIFEST)
  expect(await store.listNames()).toEqual(["legacy"])
  expect(await store.read("legacy")).toBe(MANIFEST)
})
