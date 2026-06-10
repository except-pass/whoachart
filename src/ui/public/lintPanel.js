// Dismissible lint panel for the currently-viewed chart. Lists the advisory
// static-analysis findings carried in DEF.lint (see daemon.def / src/lint.ts)
// with click-through to the offending node. Self-contained: it injects its own
// DOM into the canvas and its own <style>, so it never edits the shared page
// shell (src/ui/page.ts) — keeps the concurrent frontend merges clean.
import { escHtml } from "./helpers.js"

const STYLE_ID = "lintpanel-style"

// One <style> for the whole module, injected on first mount. Scoped under
// .lintpanel so it can't collide with the page shell's rules.
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement("style")
  s.id = STYLE_ID
  s.textContent = `
.lintpanel{position:absolute;top:12px;left:12px;z-index:35;width:320px;max-width:calc(100% - 24px);
  background:var(--panel,#0e141d);border:1px solid #3a2f12;border-radius:9px;
  font-family:system-ui,sans-serif;box-shadow:0 6px 22px rgba(0,0,0,.45)}
.lintpanel.hidden{display:none}
.lintpanel .lph{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;
  font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--amber,#f59e0b);font-weight:600}
.lintpanel .lph .lpcount{font:11px monospace;color:var(--dim,#5d6b7a);font-weight:400;text-transform:none}
.lintpanel .lph .lpx{margin-left:auto;color:var(--dim,#5d6b7a);font:600 13px system-ui;
  border:none;background:none;cursor:pointer;padding:0 2px;line-height:1}
.lintpanel .lph .lpx:hover{color:var(--ink,#c9d6e3)}
.lintpanel .lpcaret{transition:transform .15s ease;display:inline-block;color:var(--dim,#5d6b7a)}
.lintpanel.collapsed .lpcaret{transform:rotate(-90deg)}
.lintpanel.collapsed .lpbody{display:none}
.lintpanel .lpbody{max-height:280px;overflow:auto;border-top:1px solid #1c2531;padding:4px 0}
.lintpanel .lpitem{display:flex;gap:8px;align-items:flex-start;padding:6px 10px;font-size:11.5px;
  line-height:1.45;color:var(--ink,#c9d6e3);border-bottom:1px dashed #18222d}
.lintpanel .lpitem:last-child{border-bottom:none}
.lintpanel .lpitem.click{cursor:pointer}
.lintpanel .lpitem.click:hover{background:#13202c}
.lintpanel .lpdot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;margin-top:4px}
.lintpanel .lpdot.warn{background:var(--amber,#f59e0b)}
.lintpanel .lpdot.info{background:var(--dim,#5d6b7a)}
.lintpanel .lpmsg{flex:1 1 auto;word-break:break-word}
.lintpanel .lploc{display:block;margin-top:2px;font:10px monospace;color:var(--cyan,#00f0ff)}
.lintpanel .lpitem.info .lploc{color:var(--dim,#5d6b7a)}
`
  document.head.appendChild(s)
}

// The node a finding points at, for click-through. Node-scoped findings jump to
// that node; an edge-scoped finding (e.g. a dangling edge) jumps to its source
// node when that endpoint is real.
function targetNode(w, def) {
  if (w.node) return w.node
  if (w.edge && def.nodes.some((n) => n.id === w.edge.from)) return w.edge.from
  return null
}

function locLabel(w) {
  if (w.node) return `node: ${w.node}`
  if (w.edge) return `edge: ${w.edge.from} → ${w.edge.to}`
  return ""
}

// Mount the panel into `host` (the canvas). Returns the panel element, or null
// when the chart is clean (nothing to show). `onNodeClick(id)` opens the node
// inspector for click-through.
export function mountLintPanel(def, { host, onNodeClick } = {}) {
  const warnings = (def && def.lint) || []
  const mount = host || document.getElementById("canvas") || document.body
  if (!warnings.length) return null
  injectStyles()

  const warnCount = warnings.filter((w) => w.level !== "info").length
  const infoCount = warnings.length - warnCount
  const counts = [warnCount ? `${warnCount} warning${warnCount === 1 ? "" : "s"}` : "", infoCount ? `${infoCount} info` : ""]
    .filter(Boolean)
    .join(" · ")

  const panel = document.createElement("div")
  panel.className = "lintpanel"
  panel.innerHTML =
    `<div class="lph"><span class="lpcaret">▼</span><span>lint</span>` +
    `<span class="lpcount">${escHtml(counts)}</span>` +
    `<button class="lpx" title="dismiss">×</button></div>` +
    `<div class="lpbody">` +
    warnings
      .map((w) => {
        const node = targetNode(w, def)
        const click = node ? " click" : ""
        const loc = locLabel(w)
        return (
          `<div class="lpitem ${escHtml(w.level)}${click}"${node ? ` data-node="${escHtml(node)}"` : ""}>` +
          `<span class="lpdot ${escHtml(w.level)}"></span>` +
          `<span class="lpmsg">${escHtml(w.message)}` +
          (loc ? `<span class="lploc">${escHtml(loc)}</span>` : "") +
          `</span></div>`
        )
      })
      .join("") +
    `</div>`

  // Header toggles collapse; the × dismisses for the session (clicking × must not
  // also fire the collapse toggle).
  const header = panel.querySelector(".lph")
  header.addEventListener("click", (ev) => {
    if (ev.target.classList.contains("lpx")) return
    panel.classList.toggle("collapsed")
  })
  panel.querySelector(".lpx").addEventListener("click", () => panel.classList.add("hidden"))

  if (onNodeClick) {
    for (const item of panel.querySelectorAll(".lpitem.click")) {
      item.addEventListener("click", () => onNodeClick(item.dataset.node))
    }
  }

  mount.appendChild(panel)
  return panel
}
