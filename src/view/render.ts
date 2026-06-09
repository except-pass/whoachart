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
.mlabel{font:700 7px monospace;fill:#06090d;pointer-events:none}
.marble{cursor:default}
.marble .face{display:none}
.marble.agent .face{display:block}
.marble.agent .mlabel{display:none}
.marble.agent>circle{animation:agentpulse 1.2s ease-in-out infinite}
@keyframes agentpulse{0%,100%{stroke-opacity:1}50%{stroke-opacity:.3}}
`

// The client runtime: polls the daemon state endpoint and reconciles marble
// <circle>s, moving them with CSS transitions (smooth glide, never a reload).
// Bounded by design — only in-flight marbles + the last N completed per node.
const CLIENT_JS = `
const NS="http://www.w3.org/2000/svg";
const mg=document.getElementById("marbles");
const cg=document.getElementById("counts");
const els=new Map();    // marble id -> circle
const nodeOf=new Map(); // marble id -> node id (for fly-into-counter on drop)
const counts=new Map(); // node id -> text
function cx(b){return b.x+b.w/2;}
function slot(b,i,n){const shown=Math.min(n,8);return {x:cx(b)-(shown-1)*9+(i%8)*18, y:b.y+b.h+13};}
function counterPos(b){return {x:cx(b)+80, y:b.y+b.h+17};}
// Deterministic vivid color per marble id (FNV-1a hash → hue), stable for its
// whole journey, so you can track an individual job across the graph.
function hue(id){let h=2166136261;for(let i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,16777619);}return "hsl("+(((h>>>0)*137)%360)+" 72% 62%)";}
// Status lives on the ring now (fill encodes identity): red=failed, bright=working.
function ring(status){return status==="failed"?["#ef4444",2.5]:(status==="running"||status==="blocked")?["#eaf7ff",2]:["#0a0e14",1.25];}
function upsert(id,status,x,y,node){
  nodeOf.set(id,node);
  let g=els.get(id);
  if(!g){
    g=document.createElementNS(NS,"g");
    g.setAttribute("class","marble");
    g.style.transition="transform .6s cubic-bezier(.4,0,.2,1), opacity .45s";
    g.style.opacity="0";
    const c=document.createElementNS(NS,"circle"); c.setAttribute("r","8"); c.setAttribute("fill",hue(id)); g.appendChild(c);
    const t=document.createElementNS(NS,"text"); t.setAttribute("class","mlabel"); t.setAttribute("text-anchor","middle"); t.setAttribute("y","2.6"); t.textContent=id.slice(0,2); g.appendChild(t);
    const f=document.createElementNS(NS,"g"); f.setAttribute("class","face");
    const e1=document.createElementNS(NS,"circle"); e1.setAttribute("cx","-2.4"); e1.setAttribute("cy","-1"); e1.setAttribute("r","1"); e1.setAttribute("fill","#06090d"); f.appendChild(e1);
    const e2=document.createElementNS(NS,"circle"); e2.setAttribute("cx","2.4"); e2.setAttribute("cy","-1"); e2.setAttribute("r","1"); e2.setAttribute("fill","#06090d"); f.appendChild(e2);
    const sm=document.createElementNS(NS,"path"); sm.setAttribute("d","M-2.6,2 q2.6,2.4 5.2,0"); sm.setAttribute("stroke","#06090d"); sm.setAttribute("stroke-width","1"); sm.setAttribute("fill","none"); sm.setAttribute("stroke-linecap","round"); f.appendChild(sm);
    g.appendChild(f);
    const ti=document.createElementNS(NS,"title"); ti.textContent=id+" @ "+node; g.appendChild(ti);
    g._c=c; g._ti=ti;
    mg.appendChild(g); els.set(id,g);
    requestAnimationFrame(()=>{g.style.opacity="1";});
  }
  const r=ring(status); g._c.setAttribute("stroke",r[0]); g._c.setAttribute("stroke-width",String(r[1]));
  g.setAttribute("class","marble"+(status==="blocked"?" agent":""));
  g._ti.textContent=id+" @ "+node;
  g.style.transform="translate("+x+"px,"+y+"px)";
}
function setCount(node,total){
  const b=LAYOUT.boxes[node]; if(!b)return;
  const cp=counterPos(b);
  let t=counts.get(node);
  if(!t){t=document.createElementNS(NS,"text");t.setAttribute("class","endcount");t.setAttribute("x",cp.x);t.setAttribute("y",cp.y);t.setAttribute("text-anchor","start");t.style.transition="transform .25s ease";t.style.transformOrigin=cp.x+"px "+cp.y+"px";cg.appendChild(t);counts.set(node,t);}
  const next="×"+total;
  if(t.textContent!==next){ t.textContent=next; t.style.transform="scale(1.6)"; setTimeout(()=>{t.style.transform="scale(1)";},170); }
}
async function tick(){
  let s; try{const r=await fetch(STATE_URL,{cache:"no-store"});s=await r.json();}catch(e){return;}
  const seen=new Set();
  const groups={};
  for(const m of s.live){(groups[m.node]=groups[m.node]||[]).push(m);}
  for(const node in groups){const b=LAYOUT.boxes[node];if(!b)continue;groups[node].forEach((m,i)=>{const p=slot(b,i,groups[node].length);upsert(m.id,m.status,p.x,p.y,node);seen.add(m.id);});}
  for(const node in s.ends){const info=s.ends[node];const b=LAYOUT.boxes[node];if(!b)continue;info.recent.forEach((rm,i)=>{const p=slot(b,i,info.recent.length);upsert(rm.id,rm.status,p.x,p.y,node);seen.add(rm.id);});setCount(node,info.total);}
  for(const [id,el] of els){
    if(!seen.has(id)){
      const n=nodeOf.get(id); const b=n&&LAYOUT.boxes[n];
      if(b&&counts.has(n)){ const cp=counterPos(b); el.style.transform="translate("+cp.x+"px,"+cp.y+"px) scale(0.15)"; } // fly into the tally
      el.style.opacity="0";
      setTimeout(()=>el.remove(),600);
      els.delete(id); nodeOf.delete(id);
    }
  }
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
