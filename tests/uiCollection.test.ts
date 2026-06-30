import { test, expect, beforeEach, afterEach } from "bun:test"
import { Window } from "happy-dom"
import { badges, card, renderIndex, buildCells, refreshCells, setCanvas, __resetCanvasState, type CollectionView } from "../src/ui/public/collection.js"

// Reset module-global canvas state between cases (defCache/cellSvgs/flags don't
// leak across tests), and install a benign default fetch stub so setCanvas's
// immediate refreshCells() never hits the real network. Tests that assert fetch
// behavior override globalThis.fetch within their own body and restore it.
let realFetch: typeof fetch
beforeEach(() => {
  __resetCanvasState()
  realFetch = globalThis.fetch
  ;(globalThis as any).fetch = async () => ({ ok: false, json: async () => ({}) })
})
afterEach(() => { globalThis.fetch = realFetch })

// Mount a DOM scaffold mirroring the IDs renderCollectionPage emits (ctitle,
// cdesc, cards, tiles, canvasToggle). collection.js reads globalThis.document at
// call time, so installing it here is enough — the module's own bootstrap is
// gated on WHOACHART (unset in tests), so importing it never starts the poll loop.
function mount() {
  const window = new Window()
  ;(globalThis as any).document = window.document
  const doc = window.document
  doc.body.innerHTML = `
    <div class="bar"><span id="ctitle"></span><span id="cdesc"></span>
      <button class="toggle" id="canvasToggle">canvas ▸</button></div>
    <div class="cards" id="cards"></div>
    <div class="tiles hidden" id="tiles"></div>`
  return doc
}

const VIEW: CollectionView = {
  name: "srena",
  title: "Serena's loop",
  description: "alpha then bravo",
  members: [
    { name: "charlie", missing: false, inFlight: 0, blocked: 0, failed: 0, ended: 0, lastOutcome: null },
    { name: "alpha", missing: false, inFlight: 2, blocked: 1, failed: 0, ended: 3, lastOutcome: "done" },
    { name: "ghost", missing: true },
    { name: "bravo", missing: false, inFlight: 0, blocked: 0, failed: 1, ended: 0, lastOutcome: "failed" },
  ],
}

test("renders a card per member in manifest order, missing one stale (AE1/AE3/R5/R8)", () => {
  const doc = mount()
  renderIndex(VIEW)
  const cards = [...doc.querySelectorAll("#cards > .card")]
  expect(cards).toHaveLength(4)
  // Order preserved: charlie, alpha, ghost, bravo.
  expect(cards.map((c: any) => c.querySelector(".cn").textContent)).toEqual(["charlie", "alpha", "ghost", "bravo"])
  // The missing member is a stale, non-link card (R8).
  const ghost = cards[2] as any
  expect(ghost.classList.contains("missing")).toBe(true)
  expect(ghost.tagName.toLowerCase()).toBe("div") // not an <a>
  expect(ghost.querySelector(".stale")).toBeTruthy()
})

test("a loaded card links to its full chart view with a PROXY-SAFE relative href (R9)", () => {
  mount()
  const html = card(VIEW.members[1]) // alpha
  // Must be relative (../charts/), NOT root-relative (/ui/charts/): a root-relative
  // href escapes Tinstar's widget proxy and lands on the Tinstar origin, whose SPA
  // fallback boots the Tinstar canvas instead of the chart.
  expect(html).toContain('href="../charts/alpha"')
  expect(html).not.toContain('href="/ui/charts/')
})

test("status badges reflect counts (AE2/R7)", () => {
  const html = badges(VIEW.members[1]) // alpha: 2 in flight, 1 blocked, 3 ended, last done
  expect(html).toContain("2 in flight")
  expect(html).toContain("1 blocked")
  expect(html).toContain("3 ended")
  expect(html).toContain("last: done")
  // A calm member shows "idle" rather than a wall of zeros.
  expect(badges(VIEW.members[0])).toContain("idle")
})

test("the title and description render into the bar", () => {
  const doc = mount()
  renderIndex(VIEW)
  expect((doc.getElementById("ctitle") as any).textContent).toBe("Serena's loop")
  expect((doc.getElementById("cdesc") as any).textContent).toBe("alpha then bravo")
})

test("canvas builds one SVG cell per loaded member, ZERO iframes, and hides the index (R11/R13)", () => {
  const doc = mount()
  renderIndex(VIEW)
  // Default surface is the index — canvas starts hidden.
  expect((doc.getElementById("tiles") as any).classList.contains("hidden")).toBe(true)

  setCanvas(true, VIEW)
  const cells = [...doc.querySelectorAll("#tiles > .cell")]
  expect(cells).toHaveLength(3) // ghost (missing) omitted from the canvas
  expect(cells.map((c: any) => c.querySelector(".ch a").textContent)).toEqual(["charlie", "alpha", "bravo"])
  // Each cell is an inline <svg>, NOT an iframe — no nested apps, no nested proxy.
  expect(cells.every((c: any) => c.querySelector("svg.mc"))).toBe(true)
  expect(doc.querySelectorAll("#tiles iframe")).toHaveLength(0)
  // Index hidden, canvas shown.
  expect((doc.getElementById("cards") as any).classList.contains("hidden")).toBe(true)
  expect((doc.getElementById("tiles") as any).classList.contains("hidden")).toBe(false)
})

test("cell deep-links are PROXY-SAFE relative URLs, never root-relative (Tinstar regression)", () => {
  const doc = mount()
  setCanvas(true, VIEW)
  const links = [...doc.querySelectorAll("#tiles .ch a")].map((a: any) => a.getAttribute("href"))
  expect(links.length).toBeGreaterThan(0)
  for (const h of links) {
    expect(h.startsWith("/")).toBe(false) // root-relative would escape the proxy → Tinstar SPA
    expect(h.startsWith("../charts/")).toBe(true)
  }
  // And there is genuinely nothing iframe-shaped anywhere in the canvas.
  expect(doc.querySelectorAll("#tiles iframe")).toHaveLength(0)
})

test("closing the canvas unmounts the cells; reopening rebuilds from current membership", () => {
  const doc = mount()
  renderIndex(VIEW)
  setCanvas(true, VIEW)
  expect(doc.querySelectorAll("#tiles > .cell")).toHaveLength(3)
  setCanvas(false, VIEW)
  expect(doc.querySelectorAll("#tiles > .cell")).toHaveLength(0) // torn down
  // A member that loaded since the last open now appears (no one-shot freeze).
  const grown = { ...VIEW, members: [...VIEW.members, { name: "delta", missing: false }] }
  setCanvas(true, grown)
  const names = [...doc.querySelectorAll("#tiles .ch a")].map((a: any) => a.textContent)
  expect(names).toEqual(["charlie", "alpha", "bravo", "delta"])
})

test("refreshCells draws each cell's graph from one batched fetch pass (one loop, not N)", async () => {
  const doc = mount()
  const defFor = { nodes: [{ id: "n", type: "source" }], edges: [], layout: { width: 100, height: 60, boxes: { n: { x: 0, y: 0, w: 100, h: 60 } } } }
  const calls: string[] = []
  const realFetch = globalThis.fetch // save the real fetch — restore it, never delete (would break other test files)
  ;(globalThis as any).fetch = async (url: string) => {
    calls.push(url)
    const body = url.endsWith("/state")
      ? { live: [{ id: "m", node: "n", status: "running" }] }
      : defFor
    return { ok: true, json: async () => body }
  }
  try {
    setCanvas(true, VIEW) // builds 3 cells (charlie, alpha, bravo)
    await refreshCells()
    // Root-relative fetch paths (proxy-shimmed), per member, def + state — and NO
    // navigational/iframe URLs.
    expect(calls).toContain("/api/charts/alpha/def")
    expect(calls).toContain("/api/charts/alpha/state")
    expect(calls.every((u) => u.startsWith("/api/charts/"))).toBe(true)
    // Each cell's svg now has a drawn graph (a node) and the running marble.
    const cells = [...doc.querySelectorAll("#tiles > .cell")]
    expect(cells.every((c: any) => c.querySelector("svg.mc .node"))).toBe(true)
    expect(cells.every((c: any) => c.querySelector("svg.mc .mc-marble"))).toBe(true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("a member's failed fetch is isolated — other cells still draw", async () => {
  const doc = mount()
  const defFor = { nodes: [{ id: "n", type: "source" }], edges: [], layout: { width: 100, height: 60, boxes: { z: { x: 0, y: 0, w: 100, h: 60 } } }, }
  // Use a distinct node id ("z") so this test doesn't depend on the module-level
  // defCache populated by the prior test (alpha may already be cached).
  const realFetch = globalThis.fetch
  ;(globalThis as any).fetch = async (url: string) => {
    if (url.startsWith("/api/charts/alpha/")) return { ok: false, json: async () => ({}) } // alpha is down
    const body = url.endsWith("/state") ? { live: [] } : { ...defFor, nodes: [{ id: "z", type: "source" }] }
    return { ok: true, json: async () => body }
  }
  try {
    setCanvas(true, VIEW)
    await refreshCells()
    const cells = [...doc.querySelectorAll("#tiles > .cell")] as any[]
    const charlie = cells.find((c) => c.querySelector(".ch a").textContent === "charlie")
    expect(charlie.querySelector("svg.mc .node")).toBeTruthy() // others draw fine despite alpha being down
  } finally {
    globalThis.fetch = realFetch
  }
})

const DEF1 = { nodes: [{ id: "n", type: "source" }], edges: [], layout: { width: 100, height: 60, boxes: { n: { x: 0, y: 0, w: 100, h: 60 } } } }

test("a member's /def is fetched once and cached across ticks (one loop, cached topology)", async () => {
  mount()
  const calls: string[] = []
  ;(globalThis as any).fetch = async (url: string) => {
    calls.push(url)
    return { ok: true, json: async () => (url.endsWith("/state") ? { live: [] } : DEF1) }
  }
  // Drive buildCells directly (not setCanvas, which would fire its own immediate
  // refresh) so the tick count is exactly the two explicit refreshCells calls.
  buildCells({ ...VIEW, members: [{ name: "alpha", missing: false }] })
  await refreshCells()
  await refreshCells() // second tick
  // /def fetched exactly once for alpha; /state fetched each tick.
  expect(calls.filter((u) => u === "/api/charts/alpha/def")).toHaveLength(1)
  expect(calls.filter((u) => u === "/api/charts/alpha/state")).toHaveLength(2)
})

test("a topology hot-reload self-heals: a marble on an unknown node evicts the cached def and re-fetches", async () => {
  mount()
  const calls: string[] = []
  ;(globalThis as any).fetch = async (url: string) => {
    calls.push(url)
    // /state puts a marble on node "added" — which DEF1's cached boxes don't know.
    return { ok: true, json: async () => (url.endsWith("/state") ? { live: [{ id: "m", node: "added", status: "running" }] } : DEF1) }
  }
  buildCells({ ...VIEW, members: [{ name: "alpha", missing: false }] }) // direct: avoid setCanvas's auto-refresh
  await refreshCells() // caches DEF1, sees marble on unknown node -> evicts cache
  await refreshCells() // cache was evicted -> def re-fetched
  expect(calls.filter((u) => u === "/api/charts/alpha/def").length).toBeGreaterThanOrEqual(2)
})

test("a member whose fetch REJECTS (not ok:false) is isolated — others still draw", async () => {
  const doc = mount()
  ;(globalThis as any).fetch = async (url: string) => {
    if (url.startsWith("/api/charts/alpha/")) throw new Error("network down") // a genuine rejection
    return { ok: true, json: async () => (url.endsWith("/state") ? { live: [] } : DEF1) }
  }
  setCanvas(true, VIEW)
  await refreshCells() // must not reject despite alpha throwing
  const charlie = [...doc.querySelectorAll("#tiles > .cell")].find((c: any) => c.querySelector(".ch a").textContent === "charlie") as any
  expect(charlie.querySelector("svg.mc .node")).toBeTruthy()
})

test("opening the canvas fires an immediate refresh (no 600ms blank wait)", async () => {
  mount()
  let fetched = false
  ;(globalThis as any).fetch = async (url: string) => {
    fetched = true
    return { ok: true, json: async () => (url.endsWith("/state") ? { live: [] } : DEF1) }
  }
  setCanvas(true, { ...VIEW, members: [{ name: "alpha", missing: false }] })
  await Promise.resolve() // let the void refreshCells() microtask run
  await new Promise((r) => setTimeout(r, 0))
  expect(fetched).toBe(true)
})
