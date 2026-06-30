function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Stable shell for a collection's view. Like renderPage (the per-chart shell),
// this never reloads: collection.js draws everything from /api/collections/:name.
// The default surface is the index (member cards); a toggle expands the combined
// canvas, which renders each member's node-graph INLINE via the shared mini-graph
// renderer (miniChart.js) — no iframes, no nested apps. So this stylesheet carries
// the card chrome plus the mc-* graph primitives that mirror the per-chart canvas.
export function renderCollectionPage(name: string): string {
  return `<!DOCTYPE html>
<html class="dark"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>whoachart — ${esc(name)}</title>
<style>
:root{--bg:#0a0e14;--panel:#0e141d;--card:#0d141c;--node:#0d141c;--line:#1c2531;--ink:#c9d6e3;--dim:#5d6b7a;
  --cyan:#00f0ff;--violet:#a78bfa;--amber:#f59e0b;--green:#3ad98a;--red:#ef4444}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif}
.bar{display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid var(--line);
  font-size:13px;color:var(--cyan);font-weight:600}
.bar .ctitle{color:var(--ink)}
.bar .cdesc{color:var(--dim);font:11px system-ui;font-weight:400;flex:1}
.bar .toggle{cursor:pointer;border:1px solid var(--cyan);color:#bff4ff;background:#0f2630;
  border-radius:7px;padding:5px 11px;font:11.5px system-ui}
.bar .toggle.on{background:#143042}
.wrap{height:calc(100% - 37px);overflow:auto;padding:16px}
/* index: member cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{display:block;text-decoration:none;color:inherit;background:var(--card);
  border:1px solid var(--line);border-radius:11px;padding:13px 14px;transition:border-color .15s}
.card:hover{border-color:var(--cyan)}
.card.missing{border-style:dashed;opacity:.7}
.card .cn{font-size:13px;font-weight:600;color:var(--ink);word-break:break-all}
.card .badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.badge{font:10.5px monospace;border-radius:20px;padding:1px 9px;border:1px solid currentColor}
.badge.flight{color:var(--cyan)}.badge.blocked{color:var(--amber)}
.badge.failed{color:var(--red)}.badge.ended{color:var(--dim)}
.badge.outcome-done{color:var(--green)}.badge.outcome-failed{color:var(--red)}
.card .stale{font:10.5px monospace;color:var(--amber);margin-top:10px}
.empty{color:var(--dim);font:12px monospace;padding:20px}
/* canvas: member node-graphs rendered INLINE as SVG (no iframes) — one cell per
   loaded member, each filled by the shared mini-graph renderer. */
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px}
.cell{border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--card);
  display:flex;flex-direction:column;height:340px}
.cell .ch{padding:6px 11px;border-bottom:1px solid var(--line);font:11.5px system-ui}
.cell .ch a{color:var(--cyan);text-decoration:none}
.cell .ch a:hover{text-decoration:underline}
.cell svg.mc{flex:1;width:100%;min-height:0;display:block;
  background:radial-gradient(circle at 1px 1px,#141d28 1px,transparent 0) 0 0/26px 26px}
/* graph primitives — mirror the per-chart canvas so cells read consistently */
.mc .mc-edge{fill:none;stroke:#3a4a5a;stroke-width:2}
.mc .node{fill:var(--node,#0d141c);stroke-width:1.5}
.mc .mc-nname{fill:var(--ink);font:600 11px system-ui;text-anchor:middle;pointer-events:none}
.mc .mc-marble{pointer-events:none}
.hidden{display:none}
</style></head>
<body>
<div class="bar">whoachart ▸ <span class="ctitle" id="ctitle">${esc(name)}</span>
  <span class="cdesc" id="cdesc"></span>
  <button class="toggle" id="canvasToggle">canvas ▸</button>
</div>
<div class="wrap">
  <div class="cards" id="cards"><span class="empty">loading…</span></div>
  <div class="tiles hidden" id="tiles"></div>
</div>
<script>globalThis.WHOACHART = { collection: ${JSON.stringify(name).replace(/</g, "\\u003c")} }</script>
<!-- RELATIVE src: resolves to /ui/collection.js direct AND inside Tinstar's
     widget proxy (same reason the per-chart page keeps ../app.js relative). -->
<script type="module" src="../collection.js"></script>
</body></html>`
}
