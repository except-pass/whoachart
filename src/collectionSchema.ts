// src/collectionSchema.ts
import { z } from "zod"
import { parse as parseYaml } from "yaml"
import type { Collection } from "./types"

// A collection manifest is deliberately tiny: identity (name/title/description)
// plus an ordered list of member chart NAMES. Members are references, so the
// schema validates them as plain strings — whether each names a real, loaded
// chart is NOT checked here (a collection tolerates a missing member by design;
// see daemon.collection). `.min(1)` encodes "a collection is 1 or more charts":
// an empty member list is a meaningless grouping and is rejected at parse time.
const collectionSchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  members: z.array(z.string()).min(1, "a collection must list at least one member chart"),
})

// Validate-at-parse-time (AGENTS.md invariant): a malformed manifest must be
// rejected BEFORE any runtime install/swap, never throw later inside the daemon.
// Mirrors parseChart's shape so the control API's existing error handling maps a
// failure to a 400 with no extra wiring.
export function parseCollection(yamlText: string): Collection {
  const raw = parseYaml(yamlText)
  return collectionSchema.parse(raw) as Collection
}
