// Canvas zoom / pan / minimap for the control surface (roadmap 2b).
//
// WHY viewBox (not a CSS/SVG transform on a layer): the marbles, edges, gate
// buttons and node shapes all live in SVG user space. Marble travel is animated
// with path.getPointAtLength() (user space) and marbles are positioned with
// `translate(<userX>px,<userY>px)`. Driving zoom/pan through the root <svg>
// viewBox means every one of those keeps working untouched — user coordinates
// don't change, only the window onto them does. Node/marble CLICK handlers are
// DOM listeners on the elements, so hit-testing is the browser's job and stays
// correct at any zoom. Nothing in app.js's geometry needs to know we zoomed.
//
// Self-contained like legend.js: injects its own controls + minimap + styles
// into #canvas. app.js only calls initViewport().

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// The view rect for a given zoom + center. scale 1 == the whole chart fits
// (viewBox == chart bounds); larger scale zooms in. The view always keeps the
// chart's aspect ratio so the root svg's preserveAspectRatio letterboxes
// identically at every zoom level (no surprise reframing while zooming).
export function viewFor(scale, cx, cy, base) {
  const w = base.w / scale, h = base.h / scale
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

// Keep the view center inside the chart bounds so the graph can never be panned
// completely off-screen (at least its far edge stays reachable).
export function clampCenter(cx, cy, base) {
  return { cx: clamp(cx, 0, base.w), cy: clamp(cy, 0, base.h) }
}

// Cursor-anchored zoom. Returns the new {scale, cx, cy} such that the user-space
// point `anchor` (the point currently under the cursor) stays under the same
// cursor pixel after the scale change — the natural "zoom into what I'm pointing
// at" feel. Re-derives the center from the anchor's fractional position in the
// pre-zoom view so it composes cleanly across many wheel ticks.
export function anchoredZoom(scale, cx, cy, base, factor, anchor, minScale, maxScale) {
  const newScale = clamp(scale * factor, minScale, maxScale)
  if (newScale === scale) return { scale, cx, cy }
  const before = viewFor(scale, cx, cy, base)
  const fx = (anchor.x - before.x) / before.w
  const fy = (anchor.y - before.y) / before.h
  const after = viewFor(newScale, cx, cy, base) // same center for w/h only
  const newX = anchor.x - fx * after.w
  const newY = anchor.y - fy * after.h
  const c = clampCenter(newX + after.w / 2, newY + after.h / 2, base)
  return { scale: newScale, cx: c.cx, cy: c.cy }
}

// Screen (clientX/Y) → SVG user coordinates via the element's screen CTM. This
// is the one true conversion: it accounts for the viewBox, preserveAspectRatio
// letterboxing, and the element's on-page offset all at once. Returns null when
// no CTM is available (e.g. detached / headless).
function clientToUser(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM && svg.getScreenCTM()
  if (!ctm) return null
  const inv = ctm.inverse()
  return {
    x: inv.a * clientX + inv.c * clientY + inv.e,
    y: inv.b * clientX + inv.d * clientY + inv.f,
  }
}

const STYLE_ID = "whoachart-viewport-style"
const CSS = `
.vpwrap{position:absolute;top:12px;right:12px;z-index:20;display:flex;flex-direction:column;
  align-items:flex-end;gap:8px;user-select:none}
.minimap{background:rgba(14,20,29,.92);border:1px solid var(--line);border-radius:8px;
  padding:4px;box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;line-height:0}
.minimap.hidden{display:none}
.minimap svg{display:block;border-radius:4px}
.mmnode{fill:#33414f}
.mmview{fill:rgba(0,240,255,.12);stroke:var(--cyan);stroke-width:2;pointer-events:none}
.vpzoom{display:flex;flex-direction:column;background:rgba(14,20,29,.92);border:1px solid var(--line);
  border-radius:8px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,.35)}
.vpzoom button{width:30px;height:28px;border:none;background:none;color:var(--ink);cursor:pointer;
  font:15px monospace;line-height:1;border-bottom:1px solid var(--line)}
.vpzoom button:last-child{border-bottom:none}
.vpzoom button:hover{background:#16212e;color:var(--cyan)}
.vpzoom .vpfit{font-size:11px}
.canvas.panning{cursor:grabbing}
`

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement("style")
  s.id = STYLE_ID
  s.textContent = CSS
  document.head.appendChild(s)
}

const SVGNS = "http://www.w3.org/2000/svg"

// Build the minimap: every node box drawn in CHART coordinates inside a viewBox
// of the chart bounds, plus a viewport rectangle the main view updates live.
// Because the minimap viewBox == chart bounds, node rects and the viewport rect
// are placed in raw chart coords — no manual scaling.
function buildMinimap(base, def) {
  const wrap = document.createElement("div")
  wrap.className = "minimap hidden"
  wrap.id = "minimap"
  const mmW = 150, mmH = Math.max(40, Math.round((150 * base.h) / base.w))
  const svg = document.createElementNS(SVGNS, "svg")
  svg.setAttribute("viewBox", `0 0 ${base.w} ${base.h}`)
  svg.setAttribute("width", String(mmW))
  svg.setAttribute("height", String(mmH))
  const boxes = def.layout?.boxes ?? {}
  for (const n of def.nodes ?? []) {
    const b = boxes[n.id]
    if (!b) continue
    const r = document.createElementNS(SVGNS, "rect")
    r.setAttribute("class", "mmnode")
    r.setAttribute("x", b.x); r.setAttribute("y", b.y)
    r.setAttribute("width", b.w); r.setAttribute("height", b.h)
    r.setAttribute("rx", "6")
    if (n.color) r.setAttribute("fill", n.color)
    svg.appendChild(r)
  }
  const viewRect = document.createElementNS(SVGNS, "rect")
  viewRect.setAttribute("class", "mmview")
  svg.appendChild(viewRect)
  wrap.appendChild(svg)
  return { wrap, svg, viewRect }
}

// Wire zoom (wheel + buttons), pan (background drag), and minimap navigation to
// the root <svg> viewBox. Returns a small API mostly for tests/introspection.
export function initViewport(svg, canvas, def) {
  const base = { w: def.layout.width, h: def.layout.height }
  const MIN = 1, MAX = 8
  let scale = 1, cx = base.w / 2, cy = base.h / 2

  ensureStyle()
  const wrap = document.createElement("div")
  wrap.className = "vpwrap"
  const mm = buildMinimap(base, def)
  const zoom = document.createElement("div")
  zoom.className = "vpzoom"
  zoom.innerHTML =
    `<button class="vpin" title="zoom in">+</button>` +
    `<button class="vpfit" title="fit chart">▢</button>` +
    `<button class="vpout" title="zoom out">−</button>`
  wrap.appendChild(mm.wrap)
  wrap.appendChild(zoom)
  canvas.appendChild(wrap)

  function apply() {
    const v = viewFor(scale, cx, cy, base)
    svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`)
    // Minimap is only meaningful once something is off-screen.
    mm.wrap.classList.toggle("hidden", scale <= MIN + 1e-6)
    mm.viewRect.setAttribute("x", v.x)
    mm.viewRect.setAttribute("y", v.y)
    mm.viewRect.setAttribute("width", v.w)
    mm.viewRect.setAttribute("height", v.h)
  }

  function zoomBy(factor, anchor) {
    const a = anchor ?? { x: cx, y: cy }
    ;({ scale, cx, cy } = anchoredZoom(scale, cx, cy, base, factor, a, MIN, MAX))
    apply()
  }

  // --- wheel zoom (anchored at the cursor) ---
  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault()
      const anchor = clientToUser(svg, ev.clientX, ev.clientY)
      zoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15, anchor)
    },
    { passive: false },
  )

  // --- background drag to pan ---
  // Only start panning when the press lands on empty canvas, never on an
  // interactive element — so node/marble/gate clicks are completely unaffected.
  let drag = null
  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return
    if (ev.target.closest && ev.target.closest(".node,.marble,.gatebtn,.addbtn,.vpwrap")) return
    const ctm = svg.getScreenCTM && svg.getScreenCTM()
    if (!ctm) return
    drag = { sx: ev.clientX, sy: ev.clientY, cx, cy, k: ctm.a } // k: screen px per user unit (uniform)
    canvas.classList.add("panning")
    ev.preventDefault()
  })
  document.addEventListener("mousemove", (ev) => {
    if (!drag) return
    const dx = (ev.clientX - drag.sx) / drag.k
    const dy = (ev.clientY - drag.sy) / drag.k
    const c = clampCenter(drag.cx - dx, drag.cy - dy, base)
    cx = c.cx; cy = c.cy
    apply()
  })
  document.addEventListener("mouseup", () => {
    if (!drag) return
    drag = null
    canvas.classList.remove("panning")
  })

  // --- minimap: click / drag to recenter the main view ---
  function recenterFromMinimap(ev) {
    const p = clientToUser(mm.svg, ev.clientX, ev.clientY) // minimap viewBox == chart coords
    if (!p) return
    const c = clampCenter(p.x, p.y, base)
    cx = c.cx; cy = c.cy
    apply()
  }
  let mmDrag = false
  mm.svg.addEventListener("mousedown", (ev) => {
    mmDrag = true
    recenterFromMinimap(ev)
    ev.preventDefault()
    ev.stopPropagation()
  })
  document.addEventListener("mousemove", (ev) => { if (mmDrag) recenterFromMinimap(ev) })
  document.addEventListener("mouseup", () => { mmDrag = false })

  // --- zoom buttons ---
  zoom.querySelector(".vpin").addEventListener("click", () => zoomBy(1.4))
  zoom.querySelector(".vpout").addEventListener("click", () => zoomBy(1 / 1.4))
  zoom.querySelector(".vpfit").addEventListener("click", () => {
    scale = 1; cx = base.w / 2; cy = base.h / 2
    apply()
  })

  apply()
  return { zoomBy, reset: () => { scale = 1; cx = base.w / 2; cy = base.h / 2; apply() } }
}
