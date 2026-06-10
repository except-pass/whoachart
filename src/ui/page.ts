function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Minimal stable shell. The client (/ui/app.js) draws everything from
// /def + /state. Plan B replaces app.js with the full control surface.
export function renderPage(chartName: string): string {
  return `<!DOCTYPE html>
<html class="dark"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>whoachart — ${esc(chartName)}</title>
<style>
:root{--bg:#0a0e14;--ink:#c9d6e3;--dim:#5d6b7a;--cyan:#00f0ff;--line:#1c2531}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif}
.bar{padding:8px 14px;border-bottom:1px solid var(--line);font-size:13px;color:var(--cyan);font-weight:600}
#app{height:calc(100% - 37px);overflow:auto;padding:12px;font:11px/1.6 monospace;color:#7fd7c4;white-space:pre}
</style></head>
<body>
<div class="bar">whoachart ▸ ${esc(chartName)}</div>
<main id="app">loading…</main>
<script>globalThis.WHOACHART = { chart: ${JSON.stringify(chartName)} }</script>
<script type="module" src="/ui/app.js"></script>
</body></html>`
}
