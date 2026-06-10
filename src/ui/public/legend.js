// Shape legend for the canvas (roadmap 2b). Explains the node-shape vocabulary
// established in 2a: terminal (stadium), decision (diamond), step (rect). The
// type→shape mapping comes from shapeForType() in helpers.js — the SAME single
// source the canvas renders from — so a legend swatch can never drift from what
// a node actually looks like.
//
// Self-contained: this module injects its own panel + styles into #canvas, so
// the shared shell (page.ts) needs no edits. app.js only calls initLegend().
import { shapeForType } from "./helpers.js"

// Render order + human labels for each shape. Only shapes that actually occur in
// the chart are shown, so a graph with no decisions doesn't advertise diamonds.
const SHAPE_ORDER = ["stadium", "diamond", "rect"]
const SHAPE_LABEL = { stadium: "terminal", diamond: "decision", rect: "step" }

// Which shapes are present in this chart, each with the node types that map to
// it (sorted) so the legend can name them. Pure: def → ordered entries.
export function legendEntries(def) {
  const byShape = new Map()
  for (const n of def?.nodes ?? []) {
    const s = shapeForType(n.type)
    if (!byShape.has(s)) byShape.set(s, new Set())
    byShape.get(s).add(n.type)
  }
  return SHAPE_ORDER.filter((s) => byShape.has(s)).map((s) => ({
    shape: s,
    label: SHAPE_LABEL[s],
    types: [...byShape.get(s)].sort(),
  }))
}

// A swatch is the shape drawn at the REAL node-box geometry (150×60), displayed
// small via the SVG viewport. Because it's the same coordinates/rx the canvas
// uses (stadium rx = h/2, step rx = 11, diamond = side-midpoint vertices — see
// nodeShape() in app.js), the swatch is a faithful scale model, not an
// approximation that could disagree with the rendered node.
export function swatchSvg(shape) {
  const W = 150, H = 60, x = 4, y = 4, w = W - 8, h = H - 8
  let inner
  if (shape === "diamond") {
    const cx = x + w / 2, cy = y + h / 2
    inner = `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}"/>`
  } else {
    const rx = shape === "stadium" ? h / 2 : 11
    inner = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`
  }
  return `<svg class="lgswatch" viewBox="0 0 ${W} ${H}" width="42" height="17" aria-hidden="true">${inner}</svg>`
}

// Pure panel markup for a def. Empty string when the chart has no nodes (nothing
// to explain) so init can skip injecting an empty box.
export function legendHtml(def) {
  const entries = legendEntries(def)
  if (!entries.length) return ""
  const rows = entries
    .map(
      (e) =>
        `<div class="lgrow">${swatchSvg(e.shape)}` +
        `<span class="lglabel">${e.label}</span>` +
        `<span class="lgtypes">${e.types.join(" · ")}</span></div>`,
    )
    .join("")
  return `<div class="lghead"><span>shapes</span><button class="lgtoggle" title="collapse">–</button></div>` +
    `<div class="lgbody">${rows}</div>`
}

const STYLE_ID = "whoachart-legend-style"
const CSS = `
.legend{position:absolute;top:12px;left:12px;z-index:20;background:rgba(14,20,29,.92);
  border:1px solid var(--line);border-radius:9px;padding:6px 8px;font-size:11px;
  color:var(--ink);box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:230px;user-select:none}
.legend.collapsed .lgbody{display:none}
.lghead{display:flex;align-items:center;justify-content:space-between;gap:10px;
  font:10px monospace;letter-spacing:1px;text-transform:uppercase;color:var(--dim)}
.lgtoggle{border:none;background:none;color:var(--dim);cursor:pointer;font:14px monospace;
  line-height:1;padding:0 2px}
.lgtoggle:hover{color:var(--cyan)}
.lgbody{margin-top:6px;display:flex;flex-direction:column;gap:5px}
.lgrow{display:flex;align-items:center;gap:8px}
.lgswatch{flex:0 0 auto}
.lgswatch rect,.lgswatch polygon{fill:var(--node);stroke:#3a4a5a;stroke-width:3}
.lglabel{color:var(--ink);font-weight:600}
.lgtypes{color:var(--dim);font:9.5px monospace;margin-left:auto;text-align:right}
`

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement("style")
  s.id = STYLE_ID
  s.textContent = CSS
  document.head.appendChild(s)
}

// Inject the legend panel into the canvas and wire its collapse toggle. Safe to
// call once after the static graph is drawn; no-ops when there's nothing to show.
export function initLegend(canvas, def) {
  const html = legendHtml(def)
  if (!html) return null
  ensureStyle()
  const panel = document.createElement("div")
  panel.className = "legend"
  panel.id = "legend"
  panel.innerHTML = html
  const toggle = panel.querySelector(".lgtoggle")
  toggle?.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed")
    toggle.textContent = collapsed ? "+" : "–"
    toggle.title = collapsed ? "expand" : "collapse"
  })
  canvas.appendChild(panel)
  return panel
}
