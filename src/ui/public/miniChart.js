// Read-only mini-graph renderer: draws ONE chart's node-graph (nodes, edges, and
// live-marble positions) from {def, state} into a provided <svg>. Reuses the pure
// geometry/style helpers from helpers.js so a cell looks identical to the full
// per-chart view, but carries NO interactivity, NO drawer/gates, NO viewport, and
// NO requestAnimationFrame — it is a static snapshot redrawn each poll. This is
// the seam that lets the collection canvas tile N charts in ONE page (one <svg>
// per member) instead of N full chart apps in N iframes. Deliberately does NOT
// import from app.js (whose drawing is coupled to module-global state); it shares
// only the stateless helpers.js primitives.
import { shapeForType, fitLabel, diamondHalfWidth, hue, ringFor, slotPos } from "./helpers.js"

const NS = "http://www.w3.org/2000/svg"

// Same type→fill map the per-chart canvas uses, so cells match the full view.
const TYPE_COLOR = {
  source: "#3a5566", shell: "#2a3340", api: "#2a3340", decision: "#5a4a86",
  human: "#5a4a86", agent: "#a78bfa", end: "#2f6f63",
}

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (parent) parent.appendChild(e)
  return e
}

// Node outline shaped by type but always filling the layout box — identical
// geometry to app.js nodeShape() so edges/marbles stay shape-agnostic.
function nodeShape(box, type, stroke, parent) {
  const { x, y, w, h } = box
  const shape = shapeForType(type)
  if (shape === "diamond") {
    const cx = x + w / 2, cy = y + h / 2
    return el("polygon", { class: "node", points: `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`, stroke }, parent)
  }
  const rx = shape === "stadium" ? h / 2 : 11
  return el("rect", { class: "node", x, y, width: w, height: h, rx, stroke }, parent)
}

// Empty the svg so a re-render fully replaces prior content (idempotent).
export function clearMiniChart(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild)
}

// Draw `def` (topology + layout) and `state` (live marbles) into `svg`. Safe to
// call repeatedly with fresh state — it clears and redraws. `def` is the /def
// payload (nodes, edges, layout.boxes/width/height); `state` is the /state
// snapshot (its `live` array carries {id, node, status}).
export function renderMiniChart(svg, def, state) {
  clearMiniChart(svg)
  const layout = def?.layout
  if (!layout) return
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`)
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet")
  const boxes = layout.boxes ?? {}

  const gEdges = el("g", { class: "mc-edges" }, svg)
  const gNodes = el("g", { class: "mc-nodes" }, svg)
  const gMarbles = el("g", { class: "mc-marbles" }, svg)

  // Edges: same top-center → bottom-center bezier the full canvas draws.
  for (const e of def.edges ?? []) {
    const a = boxes[e.from], b = boxes[e.to]
    if (!a || !b) continue
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y
    el("path", { class: "mc-edge", d: `M${x1},${y1} C${x1},${y1 + 40} ${x2},${y2 - 40} ${x2},${y2}` }, gEdges)
  }

  // Nodes: shape + fitted label (diamonds taper, so their labels are width-clipped).
  for (const n of def.nodes ?? []) {
    const box = boxes[n.id]
    if (!box) continue
    const g = el("g", {}, gNodes)
    nodeShape(box, n.type, n.color ?? TYPE_COLOR[n.type] ?? "#2a3340", g)
    const diamond = shapeForType(n.type) === "diamond"
    const nameText = n.name ?? n.id
    const label = el("text", { class: "mc-nname", x: box.x + box.w / 2, y: box.y + box.h / 2 + 3 }, g)
    label.textContent = diamond ? fitLabel(nameText, 2 * diamondHalfWidth(box.w, box.h, 1), 6.8) : nameText
  }

  // Marbles: a dot at each live marble's node (slotPos spreads several on one
  // node), filled by identity-hue, ringed by status. Position only — no travel
  // animation; the overview answers "what's where now", click-through for detail.
  const byNode = new Map()
  for (const m of state?.live ?? []) {
    if (!byNode.has(m.node)) byNode.set(m.node, [])
    byNode.get(m.node).push(m)
  }
  for (const [node, marbles] of byNode) {
    const box = boxes[node]
    if (!box) continue
    marbles.forEach((m, i) => {
      const p = slotPos(box, i, marbles.length)
      const [stroke, width] = ringFor(m.status)
      el("circle", { class: "mc-marble", cx: p.x, cy: p.y, r: 7, fill: hue(m.id), stroke, "stroke-width": width }, gMarbles)
    })
  }
}
