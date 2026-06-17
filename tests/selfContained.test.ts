// tests/selfContained.test.ts — guard (U4): the unit suite must never reach a
// real Tinstar. `new TinstarClient()` with no argument defaults baseUrl to
// http://localhost:5273 (the user's LIVE workspace), so a test that constructs
// it argless would plant widgets / spawn sessions on the primary canvas. Every
// test must pass an explicit fake base (a Bun.serve port-0 URL). This scan
// fails loudly the moment a future test regresses that rule.
//
// The opt-in integration test (tests/integration/*.it.test.ts) is exempt: it is
// gated behind WHOACHART_IT and is the one place a real round-trip is intended.
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"

const SELF = "selfContained.test.ts"
// Argless construction only: `new TinstarClient()` with nothing (or whitespace)
// between the parens. `new TinstarClient(base)` is fine.
const ARGLESS = /new\s+TinstarClient\s*\(\s*\)/

test("no unit test constructs an argless (live) TinstarClient", () => {
  // Scan relative to the repo root (this file lives in tests/), not the process
  // cwd — otherwise running `bun test` from a subdirectory would glob nothing
  // and the guard would pass vacuously.
  const repoRoot = dirname(import.meta.dir)
  const glob = new Bun.Glob("tests/**/*.ts")
  const offenders: string[] = []
  for (const rel of glob.scanSync(repoRoot)) {
    if (rel.endsWith(SELF)) continue
    if (rel.endsWith(".it.test.ts")) continue // opt-in integration, WHOACHART_IT-gated
    const src = readFileSync(join(repoRoot, rel), "utf8")
    if (ARGLESS.test(src)) offenders.push(rel)
  }
  expect(
    offenders,
    `argless 'new TinstarClient()' defaults to the LIVE Tinstar (:5273) and would pollute the primary workspace. ` +
      `Pass an explicit fake base in: ${offenders.join(", ")}`,
  ).toEqual([])
})
