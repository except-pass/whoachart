import type { Chart } from "../types"
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
.endcount{fill:var(--cyan);font:600 11px monospace}
.marble{stroke-width:1.5}
.marble.queued{fill:#3aa;stroke:#0a6b6b}
.marble.running,.marble.blocked{fill:#a78bfa;stroke:#7c6cf0}
.marble.done{fill:#3ad98a;stroke:#0a6b3b}
.marble.failed{fill:#ef4444;stroke:#7f1d1d}
`

// The client runtime: polls the daemon state endpoint and reconciles marble
// <circle>s, moving them with CSS transitions (smooth glide, never a reload).
// Bounded by design — only in-flight marbles + the last N completed per node.
const CLIENT_JS = `
const NS="http://www.w3.org/2000/svg";
const mg=document.getElementById("marbles");
const cg=document.getElementById("counts");
const els=new Map();    // marble id -> circle
const counts=new Map(); // node id -> text
function cx(b){return b.x+b.w/2;}
function slot(b,i,n){const shown=Math.min(n,8);return {x:cx(b)-(shown-1)*9+(i%8)*18, y:b.y+b.h+13};}
function upsert(id,status,x,y){
  let el=els.get(id);
  if(!el){
    el=document.createElementNS(NS,"circle");
    el.setAttribute("r","7");
    el.style.transition="transform .6s cubic-bezier(.4,0,.2,1), opacity .4s";
    el.style.opacity="0";
    mg.appendChild(el); els.set(id,el);
    requestAnimationFrame(()=>{el.style.opacity="1";});
  }
  el.setAttribute("class","marble "+status);
  el.style.transform="translate("+x+"px,"+y+"px)";
}
function setCount(node,total){
  const b=LAYOUT.boxes[node]; if(!b)return;
  let t=counts.get(node);
  if(!t){t=document.createElementNS(NS,"text");t.setAttribute("class","endcount");t.setAttribute("x",cx(b));t.setAttribute("y",b.y-8);t.setAttribute("text-anchor","middle");cg.appendChild(t);counts.set(node,t);}
  t.textContent="×"+total;
}
async function tick(){
  let s; try{const r=await fetch(STATE_URL,{cache:"no-store"});s=await r.json();}catch(e){return;}
  const seen=new Set();
  const groups={};
  for(const m of s.live){(groups[m.node]=groups[m.node]||[]).push(m);}
  for(const node in groups){const b=LAYOUT.boxes[node];if(!b)continue;groups[node].forEach((m,i)=>{const p=slot(b,i,groups[node].length);upsert(m.id,m.status,p.x,p.y);seen.add(m.id);});}
  for(const node in s.ends){const info=s.ends[node];const b=LAYOUT.boxes[node];if(!b)continue;info.recent.forEach((rm,i)=>{const p=slot(b,i,info.recent.length);upsert(rm.id,rm.status,p.x,p.y);seen.add(rm.id);});setCount(node,info.total);}
  for(const [id,el] of els){if(!seen.has(id)){el.style.opacity="0";setTimeout(()=>el.remove(),400);els.delete(id);}}
  const lc=document.getElementById("livecount");if(lc)lc.textContent=s.live.length;
}
setInterval(tick,600); tick();
`

function center(b: NodeBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

// Render the STABLE page shell once. Marbles are not drawn server-side — the
// embedded client polls STATE_URL and animates them. The page is POSTed once
// and never replaced, so there is no flashing.
export function renderShell(chart: Chart, layout: Layout, stateUrl: string): string {
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
    const ncx = b.x + b.w / 2
    nodeSvg += `<g>`
    nodeSvg += `<rect class="node" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="11" stroke="${color}"/>`
    nodeSvg += `<text class="nname" x="${ncx}" y="${b.y + b.h / 2 - 1}">${esc(n.name ?? n.id)}</text>`
    nodeSvg += `<text class="nsub" x="${ncx}" y="${b.y + b.h / 2 + 14}">${esc(n.type)}</text>`
    nodeSvg += `</g>`
  }

  // Serialize layout boxes (a Map) into a plain object for the client.
  const boxes: Record<string, NodeBox> = {}
  for (const [id, b] of layout.boxes) boxes[id] = b
  const layoutJson = JSON.stringify({ boxes, width: layout.width, height: layout.height })

  return `<!DOCTYPE html>
<html class="dark"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><style>${CSS}</style></head>
<body>
<div class="bar">whoachart ▸ ${esc(chart.name)} · <span id="livecount">0</span> live</div>
<div class="wrap">
<svg viewBox="0 0 ${layout.width} ${layout.height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#3a4a5a"/></marker></defs>
${edgeSvg}
${nodeSvg}
<g id="counts"></g>
<g id="marbles"></g>
</svg>
</div>
<script>
const LAYOUT=${layoutJson};
const STATE_URL=${JSON.stringify(stateUrl)};
${CLIENT_JS}
</script>
</body></html>`
}
