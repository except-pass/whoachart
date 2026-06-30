// whoachart collection client. Draws the collection index (one card per member
// chart with live status) from /api/collections/:name, polls on the same 600ms
// cadence as the per-chart page, and toggles a combined canvas that tiles each
// loaded member's existing chart view (live animation comes for free — each tile
// is the per-chart page polling its own /state). The page never reloads.
import { escHtml } from "./helpers.js"

// Optional-chained so importing this module in a DOM test (no WHOACHART set)
// doesn't throw or auto-start the poll loop; start() is gated on it below.
const NAME = globalThis.WHOACHART?.collection
const $ = (id) => document.getElementById(id)
const POLL_MS = 600 // matches the per-chart page so liveness feels uniform

let canvasOpen = false // index is the default surface (R13); canvas is opt-in
let tilesBuilt = false // are member iframes currently mounted? (drives teardown)
let lastView = null

// Status badges for one member card. Order is fixed so cards read consistently;
// a zero count is omitted to keep a calm card calm.
export function badges(m) {
  if (m.missing) return '<div class="stale">⚠ chart not loaded</div>'
  const out = []
  if (m.inFlight) out.push(`<span class="badge flight">${m.inFlight} in flight</span>`)
  if (m.blocked) out.push(`<span class="badge blocked">${m.blocked} blocked</span>`)
  if (m.failed) out.push(`<span class="badge failed">${m.failed} failed</span>`)
  if (m.ended) out.push(`<span class="badge ended">${m.ended} ended</span>`)
  if (m.lastOutcome) out.push(`<span class="badge outcome-${m.lastOutcome}">last: ${m.lastOutcome}</span>`)
  if (!out.length) out.push('<span class="badge ended">idle</span>')
  return `<div class="badges">${out.join("")}</div>`
}

// One member card. A loaded member links to its full chart view (R9); a missing
// member renders a non-clickable stale card (R8) rather than being dropped.
// RELATIVE href (../charts/, not /ui/charts/): this page is served BOTH directly
// and inside Tinstar's widget proxy. A root-relative URL escapes the proxy and
// resolves against the Tinstar origin — whose SPA fallback serves the Tinstar
// canvas app for any unknown path — so a card click would boot a whole Tinstar.
// From /ui/collections/:name, ../charts/:name resolves to /ui/charts/:name when
// direct and stays under the proxy when embedded (same rule as the ../app.js src).
export function card(m) {
  const inner = `<div class="cn">${escHtml(m.name)}</div>${badges(m)}`
  if (m.missing) return `<div class="card missing">${inner}</div>`
  return `<a class="card" href="../charts/${encodeURIComponent(m.name)}">${inner}</a>`
}

export function renderIndex(view) {
  $("ctitle").textContent = view.title || NAME
  $("cdesc").textContent = view.description || ""
  const cards = $("cards")
  if (!view.members.length) {
    cards.innerHTML = '<span class="empty">this collection has no members</span>'
    return
  }
  // Members render in manifest order (R5) — the payload preserves it.
  cards.innerHTML = view.members.map(card).join("")
}

// Build the combined canvas: a tile per LOADED member (a missing member has no
// chart to render, so it stays on the index only). Each tile embeds the per-chart
// page, which polls its own /state — so marbles animate live across every tile
// simultaneously (R11/R12) without this client touching graph code. Rebuilt fresh
// on each open so it reflects current membership rather than a one-shot snapshot.
export function renderTiles(view) {
  const loaded = view.members.filter((m) => !m.missing)
  // RELATIVE iframe src (../charts/, not /ui/charts/) — CRITICAL under Tinstar.
  // Tinstar serves this page through its widget proxy on the Tinstar ORIGIN. A
  // root-relative /ui/charts/:name escapes the proxy to that origin, whose SPA
  // fallback returns the Tinstar canvas app for ANY unknown path — so each tile
  // would boot a full nested Tinstar canvas (N tiles = N Tinstars = browser meltdown),
  // not the whoachart chart. The relative path resolves to the chart when served
  // direct and stays inside the proxy when embedded (same rule as the ../app.js src).
  $("tiles").innerHTML = loaded
    .map(
      (m) => `<div class="tile"><div class="th">${escHtml(m.name)}</div>` +
        `<iframe src="../charts/${encodeURIComponent(m.name)}" title="${escHtml(m.name)}"></iframe></div>`,
    )
    .join("")
  tilesBuilt = true
}

// Tear the tiles down (not just hide): each embedded chart page runs its own
// 600ms /state poll, so leaving hidden iframes mounted leaks N poll loops for the
// page lifetime. Clearing the container unmounts the iframes and stops them.
function teardownTiles() {
  $("tiles").innerHTML = ""
  tilesBuilt = false
}

export function setCanvas(open, view) {
  canvasOpen = open
  $("cards").classList.toggle("hidden", open)
  $("tiles").classList.toggle("hidden", !open)
  const btn = $("canvasToggle")
  btn.classList.toggle("on", open)
  btn.textContent = open ? "◂ index" : "canvas ▸"
  if (open) {
    // Build from the latest data we have. If the first poll hasn't landed yet
    // (view null), tick() builds the tiles as soon as it does — so an early
    // toggle no longer leaves the canvas permanently empty.
    if (view) renderTiles(view)
  } else {
    teardownTiles()
  }
}

async function tick() {
  const res = await fetch(`/api/collections/${encodeURIComponent(NAME)}`, { cache: "no-store" })
  if (!res.ok) return
  const view = await res.json()
  lastView = view
  // Always keep the index fresh; the canvas tiles self-poll once mounted, so we
  // don't rebuild them on every tick (that would reset each iframe's animation).
  renderIndex(view)
  // If the operator opened the canvas before the first poll landed, build the
  // tiles now that data exists — without this the early-toggle canvas stays blank.
  if (canvasOpen && !tilesBuilt) renderTiles(view)
}

// Chained, not setInterval: a slow response can't overlap-and-stack (mirrors the
// per-chart page's poll loop).
function pollLoop() {
  tick().catch((e) => console.error("collection tick failed", e)).finally(() => setTimeout(pollLoop, POLL_MS))
}

function start() {
  $("canvasToggle").addEventListener("click", () => setCanvas(!canvasOpen, lastView))
  pollLoop()
}

// Only auto-run inside a real page (WHOACHART injected by the shell). Imported
// bare in a DOM test, the module exposes its render functions without starting
// the poll loop or touching elements that don't exist yet.
if (NAME) start()
