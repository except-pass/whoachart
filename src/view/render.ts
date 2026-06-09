import type { Chart, Marble } from "../types"
import type { Layout, NodeBox } from "./layout"

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const TYPE_COLOR: Record<string, string> = {
  source: "#3a5566",
  shell: "#2a3340",
  api: "#2a3340",
  decision: "#5a4a86",
  agent: "#a78bfa",
  end: "#2f6f63",
}

const CSS = `
:root{--bg:#0a0e14;--node:#0d141c;--ink:#c9d6e3;--dim:#5d6b7a;--cyan:#00f0ff}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif}
.bar{padding:8px 14px;border-bottom:1px solid #1c2531;font-size:13px;color:var(--cyan);font-weight:600}
.wrap{height:calc(100% - 35px)}
svg{width:100%;height:100%;display:block}
.edge{fill:none;stroke:#3a4a5a;stroke-width:2;marker-end:url(#arr)}
.elabel{fill:#6c7c8b;font:10px monospace}
.node{fill:var(--node);stroke-width:1.5}
.nname{fill:var(--ink);font:600 13px system-ui;text-anchor:middle}
.nsub{fill:var(--dim);font:10px monospace;text-anchor:middle}
.chip circle{fill:#0b1118;stroke:var(--cyan);stroke-width:1}
.chip text{fill:var(--cyan);font:10px monospace;text-anchor:middle}
.marble{stroke-width:1.5}
.marble.queued{fill:#3aa;stroke:#0a6b6b}
.marble.running,.marble.blocked{fill:#a78bfa;stroke:#7c6cf0}
.marble.done{fill:#3ad98a;stroke:#0a6b3b}
.marble.failed{fill:#ef4444;stroke:#7f1d1d}
`

function center(b: NodeBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

export function renderChart(chart: Chart, marbles: Marble[], layout: Layout): string {
  const byNode = new Map<string, Marble[]>()
  for (const m of marbles) {
    const a = byNode.get(m.node)
    if (a) a.push(m)
    else byNode.set(m.node, [m])
  }

  let edgeSvg = ""
  for (const e of chart.edges) {
    const a = layout.boxes.get(e.from)
    const b = layout.boxes.get(e.to)
    if (!a || !b) continue
    const ca = center(a)
    const cb = center(b)
    const x1 = ca.x, y1 = a.y + a.h
    const x2 = cb.x, y2 = b.y
    edgeSvg += `<path class="edge" d="M${x1},${y1} C${x1},${y1 + 40} ${x2},${y2 - 40} ${x2},${y2}"/>`
    if (e.name) {
      edgeSvg += `<text class="elabel" x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2}">${esc(e.name)}</text>`
    }
  }

  let nodeSvg = ""
  for (const n of chart.nodes) {
    const b = layout.boxes.get(n.id)
    if (!b) continue
    const color = n.color ?? TYPE_COLOR[n.type] ?? "#2a3340"
    const cx = b.x + b.w / 2
    nodeSvg += `<g>`
    nodeSvg += `<rect class="node" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="11" stroke="${color}"/>`
    nodeSvg += `<text class="nname" x="${cx}" y="${b.y + b.h / 2 - 1}">${esc(n.name ?? n.id)}</text>`
    nodeSvg += `<text class="nsub" x="${cx}" y="${b.y + b.h / 2 + 14}">${esc(n.type)}</text>`

    const ms = byNode.get(n.id) ?? []
    if (ms.length > 0) {
      nodeSvg += `<g class="chip"><circle cx="${b.x + 11}" cy="${b.y + 11}" r="9"/><text x="${b.x + 11}" y="${b.y + 14}">${ms.length}</text></g>`
      const shown = Math.min(ms.length, 6)
      ms.slice(0, 6).forEach((m, i) => {
        const mx = cx - (shown - 1) * 9 + i * 18
        const my = b.y + b.h + 13
        const r = m.status === "running" || m.status === "blocked" ? 9 : 7
        nodeSvg += `<circle class="marble ${m.status}" cx="${mx}" cy="${my}" r="${r}"/>`
      })
    }
    nodeSvg += `</g>`
  }

  const live = marbles.filter((m) => m.status === "queued" || m.status === "running" || m.status === "blocked").length
  const done = marbles.filter((m) => m.status === "done").length

  return `<!DOCTYPE html>
<html class="dark"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><style>${CSS}</style></head>
<body>
<div class="bar">whoachart ▸ ${esc(chart.name)} · ${live} live · ${done} done</div>
<div class="wrap">
<svg viewBox="0 0 ${layout.width} ${layout.height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#3a4a5a"/></marker></defs>
${edgeSvg}
${nodeSvg}
</svg>
</div>
</body></html>`
}
