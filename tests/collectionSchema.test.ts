// tests/collectionSchema.test.ts
import { test, expect } from "bun:test"
import { parseCollection } from "../src/collectionSchema"

const good = `
name: srena
title: Serena's operating loop
description: The watch, the standup, and the PDCA brick.
members:
  - prod-health-sweep
  - pdca-pull
  - serena-heartbeat
`

test("parses a valid manifest and preserves member order", () => {
  const c = parseCollection(good)
  expect(c.name).toBe("srena")
  expect(c.title).toBe("Serena's operating loop")
  // R5: declared order is authored intent — never re-sorted.
  expect(c.members).toEqual(["prod-health-sweep", "pdca-pull", "serena-heartbeat"])
})

test("preserves a deliberately unsorted member order verbatim", () => {
  const c = parseCollection(good.replace(
    "  - prod-health-sweep\n  - pdca-pull\n  - serena-heartbeat",
    "  - charlie\n  - alpha\n  - bravo",
  ))
  expect(c.members).toEqual(["charlie", "alpha", "bravo"])
})

test("rejects a missing name", () => {
  expect(() => parseCollection(good.replace("name: srena\n", ""))).toThrow()
})

test("rejects a missing title", () => {
  expect(() => parseCollection(good.replace("title: Serena's operating loop\n", ""))).toThrow()
})

test("rejects a missing description", () => {
  expect(() => parseCollection(good.replace("description: The watch, the standup, and the PDCA brick.\n", ""))).toThrow()
})

test("rejects when members is not an array", () => {
  const bad = `
name: srena
title: t
description: d
members: prod-health-sweep
`
  expect(() => parseCollection(bad)).toThrow()
})

test("rejects an empty member list (a collection is 1+ charts)", () => {
  const bad = `
name: srena
title: t
description: d
members: []
`
  expect(() => parseCollection(bad)).toThrow(/at least one member/)
})

test("rejects a non-string member reference (no embedded definitions)", () => {
  const bad = `
name: srena
title: t
description: d
members:
  - { id: prod-health-sweep, nodes: [] }
`
  expect(() => parseCollection(bad)).toThrow()
})

test("accepts arbitrary description text unchanged", () => {
  const c = parseCollection(good.replace("description: The watch, the standup, and the PDCA brick.", "description: 'a: b — *weird* text'"))
  expect(c.description).toBe("a: b — *weird* text")
})
