function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Stable shell for the control surface. The client modules (/ui/app.js et al)
// draw everything from /def + /state; this page never reloads.
export function renderPage(chartName: string): string {
  return `<!DOCTYPE html>
<html class="dark"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFaUlEQVRYw+2VW4he1RmG32+ttfd/mj9zymScGk1i0GSskTYRmmKgFZvEm3ohVYyHqamXDVIplAYvWhoFDxgFBRV7MaW0ihQVlaZWlEhFoonRGG1iBnOaZDIZMvPPzH+af++9vteL/c9kxpHYCuLNvLA3e8NmrWd93/t+G1jQghb0HUu+7oPVm34Ja2yLtWaVNSZDKtUrSIIgQEBJaJLAx5FYI0mgyUiOjTOjSdDYsUZx27OvfDOAe//0BB57+nmsXLV8e5L4+0REAIIkQRIQQAAS0FwRbOuGBBmiUR+z1dF94dRkf5vTNyJF48BbL3zlHu5CACQRFAswYiZFdCwFgFVllyqdCAEKfPcKJCvXAfk2hIFFd1aKk6XRZZXjhzf7s58/1W4b9/9g852TH73+13l72AsB7Nm9C2s3bEQhl/3YWvNCLhv2Z8OgX6ll9XotSKOLFsNf9RMw3wYlsP7iPHZuuhQbLu/GWL47PF7x6+Pxc/bSLN/u6v2xnjr8wf8OAABDn+3D6cN7/dmBDyeGj+wf775iXSkMwsFGFN9CajFZfjXYtRxCAiC8AsWMxTU9BVy/ohXHdJE5Olxa0yiN7C1PRUf7tm7Fnt2vz23Bb3Y8iV1vv4+WfDYTx0nWGOOLxVytpdDCk0Nn83GUOIDwXhkn3iZJslGVHTAOLHaCIASAQDBUifDwu8P4z8kyHrhuKe5e242PBla31kqnt9yWPfbmewMndZ4Hdu85gEIu2zFRrj6ceP2hEVNvxH7H8Mh4JUqSB0AWIAAIJrV6huRKglmknkxdCEJEIBCQxLunqnh1oISbVrWjc3Enjufa1r5RKrZT66PzAJQEPVuV+CmAlUoFgCsBlEBuAGhBYdOYQjKNkHqY2gQUS1MG4Uy0COK5T8ZwYGQKg1WFCcNWOpcnOB8gEwYAzIk8ucUaXFabiibDjHsvnwmTcrU6lHifI6kk4JzNee9vV+WNIGFGTgA9lwMubFaimW8BzlRiDFUnYTVBNolrUN/4cu4dAOx9+SkAUAB7m9ds/Xv2S+/P+mACd6hab6xXkSV2/Azc4CHEy9YAYiDpeGpCCMQYSHkctjZ+uDNMSpVwbvLN16Vgtm7e9geMTZShkC4CGUAA9XDHPkRwdD8kqoEioDGgmBSlPAp3dH/sahMvHRx38TVXr5qz5pyKXLn5Lhgx7VNRdCsg3c7ZNy10fyP2twdBcIWIMPE+jKJ4o1ffmx41TQDEQAvt8O0XQXNFQBVSGYMrDSNM6v9oLebuTpSTB3f1z2/BtKamIoRhcG0UxY8TCJVuXS4MHo3ixiNR7BcBs3oMaZoudb1QYSrnYMrnAJGmKaHO2n8WCtnf1Rrx5K/vuAH3XAggDAI4Yw8Ezj0DoMs5+5Kz9pMwcE8AuIxKQgAjaeHYvKv3l3jlVYAUYQCB1MXIEWvt37KZ4C+1emNs0/Vrcc9dd8xrqwDApq2/x87H75e+vm2LQdXHtv9q7LcP9XdWa/UCCQSBFStilEyjP+N2gRGBqhYTr6u96jICYsWcttZ8BvJs4hMThmHlxafvG71l20MdAMzPr/vRuQ8+HeBrf34wBfj+DVthRHoq1frfxUitJZ/bXq7UdirZC4EKpk/MufhM49YshpJsVl6kaXABaKwxn7cU8vdWqvU/AmjL5zJbCJ769F/9aQvS+QVLsgVKK0AgIgUrUhTBzOicPrjIee+mjzIzjmd7u/nXNgAWiSAgkSW0Raluei0HAN9b0oHlSy86/c6+gzepqq7pXTH03yMnf5HLBEucteePO11204wYz5dAZmCmgQAqkXiPetQYvbinc/DYiZE+pQZLezoGoyjBof9nBixoQQv6tvQFL0S5G3CES8wAAAAASUVORK5CYII="/>
<title>whoachart — ${esc(chartName)}</title>
<style>
:root{--bg:#0a0e14;--panel:#0e141d;--node:#0d141c;--line:#1c2531;--ink:#c9d6e3;--dim:#5d6b7a;
  --cyan:#00f0ff;--violet:#a78bfa;--amber:#f59e0b;--green:#3ad98a;--red:#ef4444}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif}
.bar{display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid var(--line);
  font-size:13px;color:var(--cyan);font-weight:600}
.bar .stat{color:var(--dim);font:11px monospace;font-weight:400}
.stage{display:grid;grid-template-columns:1fr 300px;height:calc(100% - 37px)}
.canvas{position:relative;overflow:hidden;
  background:radial-gradient(circle at 1px 1px,#141d28 1px,transparent 0) 0 0/26px 26px}
svg{width:100%;height:100%;display:block}
/* graph */
.edge{fill:none;stroke:#3a4a5a;stroke-width:2;marker-end:url(#arr)}
.edge.pulse{stroke:var(--cyan);filter:drop-shadow(0 0 4px rgba(0,240,255,.7));
  stroke-dasharray:6 5;animation:flow 1s linear infinite}
@keyframes flow{to{stroke-dashoffset:-22}}
.elabel{fill:#6c7c8b;font:10px monospace}
.node{fill:var(--node);stroke-width:1.5;cursor:pointer}
.node.selected{stroke:var(--cyan);stroke-width:2.5;filter:drop-shadow(0 0 5px rgba(0,240,255,.45))}
.nname{fill:var(--ink);font:600 12.5px system-ui;text-anchor:middle;pointer-events:none}
.nsub{fill:var(--dim);font:9.5px monospace;text-anchor:middle;pointer-events:none}
.endcount{fill:var(--cyan);font:600 11px monospace}
.addbtn{cursor:pointer}
.addbtn circle{fill:#0f2630;stroke:var(--cyan);stroke-width:1.4}
.addbtn text{fill:#bff4ff;font:700 13px monospace;text-anchor:middle;pointer-events:none}
/* marbles */
.marble{cursor:pointer}
.mlabel{font:700 7px monospace;fill:#06090d;pointer-events:none;text-anchor:middle}
.marble .face{display:none;pointer-events:none}
.marble.agent .face{display:block}
.marble.agent .mlabel{display:none}
.marble.agent>circle{animation:agentpulse 1.2s ease-in-out infinite}
@keyframes agentpulse{0%,100%{stroke-opacity:1}50%{stroke-opacity:.3}}
.agetag{fill:var(--amber);font:700 8.5px monospace;pointer-events:none}
.marble.stuck>circle{stroke:var(--amber)}
/* gate buttons (svg overlay) */
.gatebtn{cursor:pointer}
.gatebtn rect{fill:#0f2630;stroke:var(--cyan);rx:6}
.gatebtn text{fill:#bff4ff;font:600 10px system-ui;text-anchor:middle;pointer-events:none}
.gatebtn.danger rect{fill:#2a0f12;stroke:var(--red)}
.gatebtn.danger text{fill:#ffc9c9}
/* drawer */
.drawer{border-left:1px solid var(--line);background:var(--panel);overflow:auto}
.dh{padding:10px 12px;border-bottom:1px solid var(--line);font-size:11px;color:var(--dim);
  letter-spacing:1px;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.db{padding:12px;font-size:12px}
.kv{display:flex;justify-content:space-between;gap:8px;padding:4.5px 0;border-bottom:1px dashed #18222d}
.kv .k{color:var(--dim)}.kv .v{font:11px monospace;color:var(--ink);text-align:right;word-break:break-all}
.kv.mrow{cursor:pointer}.kv.mrow:hover{background:#13202c}
.mswatch{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
.liveplaceholder{color:var(--dim);font:10.5px monospace}
/* live output feed */
.logfeed{max-height:240px;overflow:auto;background:#06090d;border:1px solid #15202b;border-radius:7px;
  padding:6px 8px;font:10px monospace;line-height:1.55}
.logline{white-space:pre-wrap;word-break:break-word}
.logline .lts{color:#42525f}
.logline .lm{color:var(--dim)}
.logline.lout .ltx{color:#9fb6c9}
.logline.lerr .ltx{color:#ffb4b4}
.logline.levt .ltx{color:var(--cyan)}
.crumb{font:10.5px monospace;color:var(--dim);line-height:1.9;margin:4px 0 10px}
.crumb b{color:#9fb6c9}.crumb .now{color:var(--violet)}.crumb .t{color:#42525f}
.crumb .step{cursor:pointer;border-radius:4px;padding:1px 2px}
.crumb .step:hover{background:#13202c}
.crumb .step.sel{background:#0f2630;outline:1px solid #1d4754}
.crumb .step.sel b,.crumb .step.sel .now{color:var(--cyan)}
.chg{color:var(--amber);font:10px monospace;margin:4px 0}
.pinhint{font:10px monospace;color:var(--dim);margin:2px 0 8px}
.pinhint .resume{cursor:pointer;color:var(--cyan)}.pinhint .resume:hover{text-decoration:underline}
.section{border:1px solid #1b2836;border-radius:9px;padding:10px;margin:12px 0}
.section.decision{border-color:#3a2f5a;background:#120f1f}
.sh{font-size:10px;color:var(--dim);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px}
.section.decision .sh{color:var(--violet)}
.diff{font:10.5px monospace;line-height:1.8;margin:6px 0}
.dadd{color:var(--green)}
.ddel{color:var(--red)}
.dchg{color:var(--amber)}
details.fullstate{margin-top:8px;font-size:10.5px;color:var(--dim)}
details.fullstate summary{cursor:pointer}
.pill{display:inline-block;padding:1px 8px;border-radius:20px;font-size:10.5px;
  font-family:monospace;border:1px solid currentColor}
pre.json{background:#06090d;border:1px solid #15202b;border-radius:7px;padding:8px;
  font:10px monospace;color:#7fd7c4;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:8px 0}
.present{background:#0a1118;border:1px solid #1b2836;border-radius:7px;padding:8px 10px;margin:8px 0;
  font-size:11.5px;line-height:1.6;white-space:pre-wrap}
.present .pk{color:var(--dim);font:10px monospace;display:block;margin-bottom:2px}
pre.nodedesc{margin:0;font:inherit;color:var(--ink);white-space:pre-wrap;word-break:break-word}
/* primary gate brief — the decision itself, prominent at the top of the gate */
.decision-primary{background:#170f28;border:1px solid var(--violet);border-left-width:3px;
  border-radius:8px;padding:10px 12px;margin:8px 0 12px;font-size:12.5px;line-height:1.6;color:var(--ink)}
/* rendered-markdown typography (present as:markdown / markdown_file, node desc) */
.md{font-size:12px;line-height:1.6;color:var(--ink);word-break:break-word}
.md>*:first-child{margin-top:0}.md>*:last-child{margin-bottom:0}
.md p{margin:6px 0}
.md .mdh{margin:10px 0 4px;color:#e9deff;line-height:1.3}
.md h1.mdh{font-size:15px}.md h2.mdh{font-size:13.5px}.md h3.mdh{font-size:12.5px}.md h4.mdh{font-size:11.5px}
.md ul,.md ol{margin:6px 0;padding-left:20px}.md li{margin:2px 0}
.md code{background:#06090d;border:1px solid #15202b;border-radius:4px;padding:0 4px;font:11px monospace;color:#7fd7c4}
.md pre.mdcode{background:#06090d;border:1px solid #15202b;border-radius:7px;padding:8px;
  font:10.5px monospace;color:#9fe6d6;line-height:1.55;white-space:pre-wrap;word-break:break-word;margin:6px 0}
.md blockquote{margin:6px 0;padding:2px 10px;border-left:2px solid #3a4a5a;color:var(--dim)}
.md a{color:var(--cyan)}.md hr{border:none;border-top:1px solid #1b2836;margin:8px 0}
.md strong{color:#fff}.md em{color:#d8d0e6}
.mdfile-load{font:10.5px monospace;color:var(--dim)}
.mdfile-miss{font:10.5px monospace;color:var(--amber)}
/* evidence footer — demoted paths/counts/links, collapsed by default */
details.evidence{margin-top:8px}
details.evidence>summary{cursor:pointer;font-size:10px;color:var(--dim);letter-spacing:1px;
  text-transform:uppercase;list-style:none}
details.evidence>summary::before{content:"▸ ";color:var(--dim)}
details.evidence[open]>summary::before{content:"▾ "}
details.evidence>summary:hover{color:var(--cyan)}
button.act{display:inline-block;margin:4px 6px 4px 0;padding:6px 12px;border-radius:7px;font-size:11.5px;
  border:1px solid var(--cyan);color:#bff4ff;background:#0f2630;cursor:pointer}
button.act.danger{border-color:var(--red);color:#ffc9c9;background:#2a0f12}
button.act.violet{border-color:var(--violet);color:#d8c9ff;background:#16102a}
button.act:disabled{opacity:.45;cursor:default}
details.force{margin-top:8px;font-size:11px;color:var(--dim)}
/* tray */
.tray{position:absolute;left:12px;bottom:12px;right:12px;background:#140b0d;border:1px solid #5f1d22;
  border-radius:9px;padding:6px 12px;font:10.5px monospace;color:#ffb4b4;display:flex;gap:14px;
  align-items:center;flex-wrap:wrap}
.tray.hidden{display:none}
.tray .retry{border:1px solid var(--red);background:none;border-radius:5px;padding:1px 8px;
  color:#ffc9c9;cursor:pointer;font:10.5px monospace}
/* toast */
.toasts{position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;
  flex-direction:column;align-items:center;z-index:40;pointer-events:none}
.toast{background:#2a0f12;overflow:hidden;max-height:60px;margin-bottom:6px;
  border:1px solid var(--red);color:#ffc9c9;border-radius:8px;padding:6px 14px;
  font:11px monospace;opacity:1;
  transition:opacity .4s,max-height .4s,margin .4s,padding .4s,border-width .4s}
.toast.out{opacity:0;max-height:0;margin-bottom:0;padding-top:0;padding-bottom:0;border-width:0}
/* hover stats card */
.hovercard{position:absolute;background:var(--panel);border:1px solid #2a3a4a;border-radius:7px;
  padding:8px 11px;font:10px monospace;color:var(--dim);pointer-events:none;z-index:30;line-height:1.7}
.hovercard b{color:var(--ink);font-family:system-ui;font-size:11px}
.hovercard.hidden{display:none}
/* modal */
.modal{position:fixed;inset:0;background:rgba(4,7,11,.7);display:flex;align-items:center;
  justify-content:center;z-index:50}
.modal.hidden{display:none}
.modal .box{background:var(--panel);border:1px solid #2a3a4a;border-radius:11px;min-width:320px;
  max-width:440px;padding:16px}
.modal h3{margin:0 0 12px;font-size:14px;color:var(--cyan)}
.field{margin:9px 0}
.field label.fl{display:block;font-size:11px;color:var(--dim);margin-bottom:4px}
.field input[type=text],.field input[type=number],.field textarea,.field select{
  width:100%;background:#06090d;border:1px solid #243240;border-radius:6px;color:var(--ink);
  padding:6px 8px;font:12px monospace}
.field textarea{min-height:64px}
.field .radio-row{display:flex;gap:12px;font-size:12px}
.ferr{color:var(--red);font-size:10.5px;margin-top:3px}
.field.haserr input,.field.haserr textarea,.field.haserr select{border-color:var(--red)}
</style></head>
<body>
<div class="bar">whoachart ▸ ${esc(chartName)}
  <span class="stat"><span id="livecount">0</span> live</span>
  <span class="stat" id="barstats"></span>
</div>
<div class="stage">
  <div class="canvas" id="canvas">
    <svg id="svg" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 Z" fill="#3a4a5a"/>
        </marker>
      </defs>
      <g id="edges"></g><g id="nodes"></g><g id="counts"></g><g id="marbles"></g><g id="overlay"></g>
    </svg>
    <div id="toasts" class="toasts"></div>
    <div id="tray" class="tray hidden"></div>
    <div id="hovercard" class="hovercard hidden"></div>
  </div>
  <aside class="drawer" id="drawer">
    <div class="dh">inspector</div>
    <div class="db" id="drawerBody"><span style="color:var(--dim)">click a marble…</span></div>
  </aside>
</div>
<div id="modal" class="modal hidden"></div>
<script>globalThis.WHOACHART = { chart: ${JSON.stringify(chartName).replace(/</g, "\\u003c")} }</script>
<!-- RELATIVE script src: resolves to /ui/app.js when served directly AND to
     /api/proxy/<wid>/ui/app.js inside Tinstar's widget proxy. The proxy skips
     rewriting <script> tags entirely (JS-safety), so a root-relative src would
     escape the proxy and 404 against the Tinstar SPA. Module imports inside
     app.js are relative too, and the proxy's runtime shim patches our
     root-relative fetch() calls. Keep this relative. -->
<script type="module" src="../app.js"></script>
</body></html>`
}
