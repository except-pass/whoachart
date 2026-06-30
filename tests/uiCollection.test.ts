import { test, expect } from "bun:test"
import { Window } from "happy-dom"
import { badges, card, renderIndex, renderTiles, setCanvas, type CollectionView } from "../src/ui/public/collection.js"

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

test("a loaded card links to its full chart view (R9)", () => {
  mount()
  const html = card(VIEW.members[1]) // alpha
  expect(html).toContain('href="/ui/charts/alpha"')
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

test("canvas toggle tiles loaded members only and hides the index (R11/R12/R13)", () => {
  const doc = mount()
  renderIndex(VIEW)
  // Default surface is the index — tiles start hidden.
  expect((doc.getElementById("tiles") as any).classList.contains("hidden")).toBe(true)

  setCanvas(true, VIEW)
  const tiles = [...doc.querySelectorAll("#tiles > .tile")]
  expect(tiles).toHaveLength(3) // ghost (missing) omitted from the canvas
  expect(tiles.map((t: any) => t.querySelector(".th").textContent)).toEqual(["charlie", "alpha", "bravo"])
  // Each tile embeds the per-chart page, which self-animates via its own /state.
  expect((tiles[1] as any).querySelector("iframe").getAttribute("src")).toBe("/ui/charts/alpha")
  // Index hidden, canvas shown.
  expect((doc.getElementById("cards") as any).classList.contains("hidden")).toBe(true)
  expect((doc.getElementById("tiles") as any).classList.contains("hidden")).toBe(false)
})
