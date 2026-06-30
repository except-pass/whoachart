// whoachart collection client. Draws the collection index (one card per member
// chart with live status) from /api/collections/:name, and a combined canvas that
// renders every loaded member's node-graph INLINE as SVG (no iframes) via the
// shared mini-graph renderer — one poll loop refreshes the index and every cell.
// The page never reloads.
import { escHtml } from "./helpers.js"
import { renderMiniChart } from "./miniChart.js"

// Optional-chained so importing this module in a DOM test (no WHOACHART set)
// doesn't throw or auto-start the poll loop; start() is gated on it below.
const NAME = globalThis.WHOACHART?.collection
const $ = (id) => document.getElementById(id)
const POLL_MS = 600 // matches the per-chart page so liveness feels uniform
const SVGNS = "http://www.w3.org/2000/svg"

let canvasOpen = false // index is the default surface (R13); canvas is opt-in
let cellsBuilt = false // are the member SVG cells currently mounted?
let lastView = null
const cellSvgs = new Map() // member name -> its <svg> (current canvas cells)
const defCache = new Map() // member name -> /def payload (topology is static between hot-reloads)

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

// Build the combined canvas: one cell per LOADED member (a missing member has no
// chart to render, so it stays on the index only). Each cell is a header linking
// to the full chart plus an inline <svg> the poll loop draws into — NO iframes, so
// the nested-Tinstar-proxy class of bug cannot recur and there are no N nested
// apps. Rebuilt fresh on each open so it reflects current membership.
export function buildCells(view) {
  const tiles = $("tiles")
  tiles.innerHTML = ""
  cellSvgs.clear()
  for (const m of view.members.filter((x) => !x.missing)) {
    const cell = document.createElement("div")
    cell.className = "cell"
    // RELATIVE deep-link (proxy-safe) — same rule as the index card href.
    cell.innerHTML = `<div class="ch"><a href="../charts/${encodeURIComponent(m.name)}">${escHtml(m.name)}</a></div>`
    const svg = document.createElementNS(SVGNS, "svg")
    svg.setAttribute("class", "mc")
    cell.appendChild(svg)
    tiles.appendChild(cell)
    cellSvgs.set(m.name, svg)
  }
  cellsBuilt = true
}

// Refresh every mounted cell from live data. ONE call per tick (not one loop per
// member): fetch each member's /def (cached — topology is static) and /state in
// parallel via ROOT-RELATIVE fetch (Tinstar's proxy shims fetch, so this is the
// proxy-safe data path), then redraw its graph. A per-member failure is isolated
// so one bad chart can't blank the rest.
export async function refreshCells() {
  await Promise.all(
    [...cellSvgs.entries()].map(async ([name, svg]) => {
      try {
        if (!defCache.has(name)) {
          const dr = await fetch(`/api/charts/${encodeURIComponent(name)}/def`, { cache: "no-store" })
          if (!dr.ok) return
          defCache.set(name, await dr.json())
        }
        const sr = await fetch(`/api/charts/${encodeURIComponent(name)}/state`, { cache: "no-store" })
        if (!sr.ok) return
        renderMiniChart(svg, defCache.get(name), await sr.json())
      } catch (e) {
        console.error(`collection cell ${name} failed`, e)
      }
    }),
  )
}

// Unmount the cells (clear the container) and forget their svgs. The cached defs
// can persist across open/close — topology doesn't change — so reopening is cheap.
function teardownCells() {
  $("tiles").innerHTML = ""
  cellSvgs.clear()
  cellsBuilt = false
}

export function setCanvas(open, view) {
  canvasOpen = open
  $("cards").classList.toggle("hidden", open)
  $("tiles").classList.toggle("hidden", !open)
  const btn = $("canvasToggle")
  btn.classList.toggle("on", open)
  btn.textContent = open ? "◂ index" : "canvas ▸"
  if (open) {
    // Build cell scaffolding from the latest membership; the poll loop fills the
    // graphs. If the first poll hasn't landed yet (view null), tick() builds them
    // as soon as it does — so an early toggle no longer leaves the canvas blank.
    if (view) buildCells(view)
  } else {
    teardownCells()
  }
}

async function tick() {
  const res = await fetch(`/api/collections/${encodeURIComponent(NAME)}`, { cache: "no-store" })
  if (!res.ok) return
  const view = await res.json()
  lastView = view
  renderIndex(view)
  if (canvasOpen) {
    // Build cells if the canvas was opened before the first poll, then draw graphs.
    if (!cellsBuilt) buildCells(view)
    await refreshCells()
  }
}

// Chained, not setInterval: a slow response can't overlap-and-stack (mirrors the
// per-chart page's poll loop). ONE loop drives both the index and the canvas.
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
