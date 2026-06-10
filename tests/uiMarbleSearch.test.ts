import { test, expect } from "bun:test"
// marbleSearch.js is plain ESM — bun imports it directly. We exercise the pure
// search/filter/format helpers; the DOM mount is covered by manual/e2e use.
import { Window } from "happy-dom"
import {
  marbleHaystack, fuzzyScore, searchMarbles, statusCounts, fmtAgeFull, mountMarbleSearch,
} from "../src/ui/public/marbleSearch.js"

const mk = (over: Record<string, unknown> = {}) => ({
  id: "m1", chart: "c", node: "build", status: "running",
  context: {}, history: [], createdAt: "2026-06-10T00:00:00Z", updatedAt: "2026-06-10T00:00:00Z",
  ...over,
})

test("marbleHaystack covers id, workpiece, node, and stringified context VALUES", () => {
  const hay = marbleHaystack(mk({
    id: "abc123", workpiece: "deploy.yaml", node: "review",
    context: { env: "prod", retries: 3, meta: { k: 1 } },
  }))
  expect(hay).toContain("abc123")
  expect(hay).toContain("deploy.yaml")
  expect(hay).toContain("review")
  expect(hay).toContain("prod")
  expect(hay).toContain("3")
  expect(hay).toContain('{"k":1}') // nested objects are JSON-stringified, so still findable
})

test("fuzzyScore matches subsequences and rejects non-subsequences", () => {
  expect(fuzzyScore("dep", "deploy")).toBeGreaterThanOrEqual(0)
  expect(fuzzyScore("dpy", "deploy")).toBeGreaterThanOrEqual(0) // gapped subsequence
  expect(fuzzyScore("xyz", "deploy")).toBe(-1)
  expect(fuzzyScore("acb", "abc")).toBe(-1) // order matters
  expect(fuzzyScore("", "anything")).toBe(0) // empty query matches
})

test("fuzzyScore rewards contiguous and word-boundary matches", () => {
  // contiguous "dep" beats the same chars gapped by non-boundary letters
  expect(fuzzyScore("dep", "xdep")).toBeGreaterThan(fuzzyScore("dep", "xdaeap"))
  // word-start hit outscores a mid-word hit of the same length
  expect(fuzzyScore("rev", "x review")).toBeGreaterThan(fuzzyScore("rev", "xrevyy"))
})

test("searchMarbles: null statuses = no filter, Set = exact membership, empty Set = none", () => {
  const ms = [mk({ id: "a", status: "running" }), mk({ id: "b", status: "done" }), mk({ id: "c", status: "failed" })]
  expect(searchMarbles(ms, "", null).map((m) => m.id).sort()).toEqual(["a", "b", "c"])
  expect(searchMarbles(ms, "", new Set(["done"])).map((m) => m.id)).toEqual(["b"])
  expect(searchMarbles(ms, "", new Set(["done", "failed"])).map((m) => m.id).sort()).toEqual(["b", "c"])
  expect(searchMarbles(ms, "", new Set())).toEqual([])
})

test("searchMarbles: tokens are ANDed and can span fields", () => {
  const ms = [
    mk({ id: "deploy-1", workpiece: "prod release", context: { env: "staging" } }),
    mk({ id: "deploy-2", workpiece: "test run", context: { env: "prod" } }),
    mk({ id: "build-3", workpiece: "prod thing", context: {} }),
  ]
  // "deploy prod" — one token from id, the other from workpiece/context
  const hits = searchMarbles(ms, "deploy prod", null).map((m) => m.id)
  expect(hits).toContain("deploy-1")
  expect(hits).toContain("deploy-2")
  expect(hits).not.toContain("build-3") // missing "deploy"
})

test("searchMarbles sorts by score then newest first", () => {
  const ms = [
    mk({ id: "old-deploy", createdAt: "2026-06-09T00:00:00Z", workpiece: "deploy" }),
    mk({ id: "new-deploy", createdAt: "2026-06-10T00:00:00Z", workpiece: "deploy" }),
  ]
  // equal score (both match "deploy" the same way) → newest createdAt wins the tie
  expect(searchMarbles(ms, "deploy", null).map((m) => m.id)).toEqual(["new-deploy", "old-deploy"])
})

test("statusCounts tallies per status", () => {
  const ms = [mk({ status: "done" }), mk({ status: "done" }), mk({ status: "failed" })]
  expect(statusCounts(ms)).toEqual({ done: 2, failed: 1 })
})

test("fmtAgeFull renders compact, always-on age across units", () => {
  const base = new Date("2026-06-10T12:00:00Z").getTime()
  const ago = (s: number) => new Date(base - s * 1000).toISOString()
  expect(fmtAgeFull(ago(5), base)).toBe("5s")
  expect(fmtAgeFull(ago(90), base)).toBe("1m")
  expect(fmtAgeFull(ago(3 * 3600), base)).toBe("3h")
  expect(fmtAgeFull(ago(2 * 86400), base)).toBe("2d")
  expect(fmtAgeFull(ago(-100), base)).toBe("0s") // future timestamp clamps to 0
})

// ---- DOM smoke test: mount, load, filter, click-through ----
// mountMarbleSearch reads the ambient `document`/`fetch` globals, so we install
// a happy-dom window + a stub fetch for the test and RESTORE both afterward —
// bun shares globalThis across test files, and a leaked fetch stub would break
// the routes/daemon suites that hit the real network.
test("mountMarbleSearch wires button + overlay, loads marbles, and rows click through to openMarble", async () => {
  const win = new Window()
  const doc = win.document
  const prevDoc = (globalThis as any).document
  const prevEvent = (globalThis as any).Event
  const prevFetch = (globalThis as any).fetch
  ;(globalThis as any).document = doc
  ;(globalThis as any).Event = win.Event
  try {
    const bar = doc.createElement("div")
    bar.className = "bar"
    doc.body.appendChild(bar)

    const marbles = [
      { id: "deploy-1", node: "build", status: "running", context: { env: "prod" }, createdAt: "2026-06-10T00:00:00Z" },
      { id: "old-2", node: "review", status: "done", context: {}, createdAt: "2026-06-09T00:00:00Z" },
    ]
    ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ marbles }) })

    const opened: string[] = []
    mountMarbleSearch({ chart: "c", openMarble: (id: string) => opened.push(id) })

    const btn = doc.getElementById("msearchBtn")!
    const overlay = doc.querySelector(".msearch")!
    expect(btn).toBeTruthy()
    expect(overlay.classList.contains("hidden")).toBe(true) // starts closed

    btn.dispatchEvent(new win.Event("click")) // open() → load()
    await new Promise((r) => setTimeout(r, 0)) // let the fetch microtask resolve
    expect(overlay.classList.contains("hidden")).toBe(false)

    const rows = overlay.querySelectorAll(".msearch-row")
    expect(rows.length).toBe(2)

    rows[0].dispatchEvent(new win.Event("click")) // click-through + auto-close
    expect(opened).toEqual(["deploy-1"])
    expect(overlay.classList.contains("hidden")).toBe(true)

    // idempotent — a second mount doesn't duplicate the button
    mountMarbleSearch({ chart: "c", openMarble: () => {} })
    expect(doc.querySelectorAll("#msearchBtn").length).toBe(1)
  } finally {
    ;(globalThis as any).document = prevDoc
    ;(globalThis as any).Event = prevEvent
    ;(globalThis as any).fetch = prevFetch
  }
})
