// Node inspector drawer: identity + config, the code the node runs (on_enter /
// on_leave shell, agent brief, api request), its present specs, live stats, and
// the marbles currently sitting on it.
//
// Parallel to drawer.js (the marble inspector). Both render into the same
// #drawerBody and are mutually exclusive — selecting a node clears the marble
// selection and vice versa (coordinated in app.js via deselectMarble /
// clearNodeDrawer). All data comes from the existing /def + /state payloads; no
// per-node fetch.
import { escHtml, fmtMs, hue } from "./helpers.js"
import { renderMarkdown } from "./markdown.js"

const body = () => document.getElementById("drawerBody")

let current = null // node id the drawer is showing
let lastRender = "" // change-detection key so polling doesn't flicker the meta region

export function selectedNode() {
  return current
}

// Drop the node selection without touching the DOM (symmetric with
// drawer.deselectMarble). The marble view paints over the body when switching.
export function clearNodeDrawer() {
  current = null
  lastRender = ""
}

function codeBlock(label, text) {
  return `<div class="present"><span class="pk">${escHtml(label)}</span><pre class="json">${escHtml(text)}</pre></div>`
}

function kv(k, v) {
  return `<div class="kv"><span class="k">${escHtml(k)}</span><span class="v">${escHtml(String(v))}</span></div>`
}

// What this step DOES, independent of the code it runs. `description` is
// markdown — rendered as real markdown (shared renderer with the gate present
// specs). `doc` is a runbook/skill link: only http(s) becomes a clickable <a>,
// otherwise it's shown verbatim.
function docsSection(node) {
  const parts = []
  if (typeof node.description === "string" && node.description.trim()) {
    parts.push(`<div class="present"><div class="md">${renderMarkdown(node.description)}</div></div>`)
  }
  if (typeof node.doc === "string" && node.doc.trim()) {
    const link = /^https?:\/\//i.test(node.doc)
      ? `<a href="${escHtml(node.doc)}" target="_blank" rel="noopener" style="color:var(--cyan)">${escHtml(node.doc)}</a>`
      : escHtml(node.doc)
    parts.push(`<div class="present"><span class="pk">runbook</span>${link}</div>`)
  }
  return parts.length ? `<div class="section"><div class="sh">what this does</div>${parts.join("")}</div>` : ""
}

// === 1b SEAM ==============================================================
// Live per-node / per-marble output streaming plugs in HERE, and ONLY here.
// #nodeLiveOutput is the only durable anchor in the node view: it is created
// once per selected node and is intentionally NOT rebuilt by the meta re-render
// that runs on every poll, so lines appended by a stream survive.
//
// IMPORTANT: #nodeMeta and everything in it — including the [data-marble] rows
// in the "marbles here" section — is destroyed and rebuilt on every poll. Do
// NOT anchor any stream UI (per-node OR per-marble) to those rows; they vanish.
// Any per-marble stream UI must live INSIDE #nodeLiveOutput (or be fully
// re-derived from state each poll). The [data-marble] rows are fine as
// transient click targets only.
//
// Task 1b should: open an EventSource/fetch stream keyed by
// `container.dataset.node` (the node id), append lines into this container,
// and reset when data-node changes (a node switch rebuilds it). Keep this
// container stable — don't fold it back into renderNodeBody().
// =========================================================================
function liveSectionHtml(node) {
  return `<div class="section" id="nodeLiveOutput" data-node="${escHtml(node.id)}">
    <div class="sh">live output</div>
    <div class="logfeed"><div class="liveplaceholder">waiting for output…</div></div>
  </div>`
}

const FEED_MAX = 200 // mirror the server-side ring bound

function logLineHtml(e) {
  const cls = e.stream === "stderr" ? "lerr" : e.stream === "event" ? "levt" : "lout"
  const t = typeof e.ts === "string" ? e.ts.slice(11, 19) : "" // HH:MM:SS out of the ISO ts
  return `<div class="logline ${cls}">` +
    `<span class="lts">${escHtml(t)}</span> ` +
    `<span class="lm" title="${escHtml(String(e.marble))}">${escHtml(String(e.marble).slice(0, 4))}</span> ` +
    `<span class="ltx">${escHtml(e.line)}</span></div>`
}

function appendLogLines(container, lines) {
  if (!lines || !lines.length) return
  const feed = container.querySelector(".logfeed")
  if (!feed) return
  feed.querySelector(".liveplaceholder")?.remove()
  // Stick to the bottom only if the user is already there, so scrolling up to
  // read history isn't yanked away by new lines.
  const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 4
  feed.insertAdjacentHTML("beforeend", lines.map(logLineHtml).join(""))
  while (feed.children.length > FEED_MAX) feed.firstElementChild.remove()
  if (atBottom) feed.scrollTop = feed.scrollHeight
}

// Poll the node's live-output delta and append it. The cursor (`_since`) lives on
// the stable #nodeLiveOutput container, so a node switch — which rebuilds that
// container — resets the cursor to 0 automatically. Guarded against overlapping
// fetches and against the container being rebuilt mid-flight (node switch).
function pumpLogs(nodeId, api) {
  if (!api || typeof api.nodeLogs !== "function") return
  const c = body().querySelector("#nodeLiveOutput")
  if (!c || c.dataset.node !== nodeId || c._busy) return
  c._busy = true
  const since = c._since ?? 0
  // Capture `c` (the element this fetch started on) and operate on it by IDENTITY
  // throughout. A node switch rebuilds #nodeLiveOutput into a NEW element with its
  // own _busy/_since; a re-query in .then/.finally would clobber that new element
  // (clearing its _busy mid-flight → double fetch, or appending stale lines).
  // .then(() => api.nodeLogs(...)), not Promise.resolve(api.nodeLogs(...)): a
  // synchronous throw from nodeLogs then still routes through .catch/.finally and
  // releases _busy. An eager call would escape the chain and wedge the feed (_busy
  // stuck true until a node switch rebuilds the container).
  Promise.resolve()
    .then(() => api.nodeLogs(nodeId, since))
    .then((res) => {
      if (!res || body().querySelector("#nodeLiveOutput") !== c) return // c detached by a switch
      appendLogLines(c, res.lines)
      c._since = res.nextSeq ?? since
    })
    .catch(() => {})
    .finally(() => { c._busy = false }) // clear only the captured element, never the new one
}

// Pure: node def + live data -> meta HTML. Unit-testable without a DOM.
// `node` is a /def node, `stats` a /state NodeStats (or null), `marbles` the
// live marbles on this node, `ends` the end tally (only for end nodes).
export function renderNodeBody(node, stats, marbles, ends) {
  const cfg = node.config ?? {}
  const swatch = node.color ?? "#3a4a5a"

  // Highlight the two "code" fields; dump everything else as a config block so
  // unknown node types and extra keys still render without per-type branching.
  const code = []
  if (typeof cfg.on_enter === "string") code.push(codeBlock("on_enter (shell)", cfg.on_enter))
  if (typeof cfg.brief === "string") code.push(codeBlock("agent brief", cfg.brief))
  if (typeof node.on_leave === "string") code.push(codeBlock("on_leave (shell)", node.on_leave))
  const rest = Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== "on_enter" && k !== "brief"))
  if (Object.keys(rest).length) {
    code.push(`<div class="present"><span class="pk">config</span><pre class="json">${escHtml(JSON.stringify(rest, null, 2))}</pre></div>`)
  }

  // Identity/config meta. Type is already on the pill, so it's omitted here.
  const meta = [
    node.stuck_after != null ? kv("stuck after", `${node.stuck_after}s`) : "",
    node.timeout != null ? kv("timeout", fmtMs(node.timeout)) : "",
    node.retry ? kv("retry max", node.retry.max) : "",
  ].join("")

  const present = node.present?.length
    ? `<div class="section"><div class="sh">present · gate display</div>${node.present
        .map((p) => kv(p.key, p.primary === true || p.key === "decision" ? `${p.as} · primary` : p.as))
        .join("")}</div>`
    : ""

  const statsHtml = `<div class="section"><div class="sh">live stats</div>
    ${kv("runs", stats?.runs ?? 0)}
    ${kv("fails", stats?.fails ?? 0)}
    ${kv("dwell p50", stats?.dwellP50 != null ? fmtMs(stats.dwellP50) : "—")}
    ${kv("dwell p95", stats?.dwellP95 != null ? fmtMs(stats.dwellP95) : "—")}</div>`

  const marbleRows = marbles.length
    ? marbles
        .map(
          (m) =>
            `<div class="kv mrow" data-marble="${escHtml(m.id)}">` +
            `<span class="k"><span class="mswatch" style="background:${hue(m.id)}"></span>${escHtml(m.id)}</span>` +
            `<span class="v">${escHtml(m.status)}</span></div>`,
        )
        .join("")
    : `<span style="color:var(--dim)">none</span>`
  const marblesHtml = `<div class="section"><div class="sh">marbles here · ${marbles.length}</div>
    ${marbleRows}
    ${ends ? kv("completed total", `×${ends.total}`) : ""}</div>`

  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="width:13px;height:13px;border-radius:3px;background:${escHtml(swatch)};display:inline-block"></span>
      <b>${escHtml(node.name ?? node.id)}</b>
      <span class="pill" style="color:var(--cyan)">${escHtml(node.type)}</span>
    </div>
    ${kv("id", node.id)}
    ${meta}
    ${docsSection(node)}
    <div class="section"><div class="sh">code &amp; config</div>${code.join("") || `<span style="color:var(--dim)">no config</span>`}</div>
    ${present}
    ${statsHtml}
    ${marblesHtml}
  `
}

// Render (or refresh) the node drawer. def = /def payload, state = /state
// snapshot. api = { openMarble } so a marble row can jump to the marble view.
export function showNode(id, def, state, api) {
  const node = def.nodes.find((n) => n.id === id)
  if (!node) return
  const switching = current !== id
  current = id

  const stats = state.stats[id] ?? null
  const marbles = state.live.filter((m) => m.node === id)
  const ends = state.ends[id] ?? null

  const el = body()
  // Build the two-region scaffold when first showing this node (or arriving from
  // the marble view): a re-rendered #nodeMeta and a persistent #nodeLiveOutput.
  if (switching || !el.querySelector("#nodeMeta")) {
    el.innerHTML = `<div id="nodeMeta"></div>${liveSectionHtml(node)}`
    lastRender = ""
  }

  // Stream live output every tick, independent of the meta change-detection:
  // logs change far more often than stats, so don't gate them on a meta diff.
  pumpLogs(id, api)

  const renderKey = JSON.stringify({ node, stats, marbles, ends })
  if (renderKey === lastRender) return
  lastRender = renderKey

  const meta = el.querySelector("#nodeMeta")
  meta.innerHTML = renderNodeBody(node, stats, marbles, ends)
  for (const row of meta.querySelectorAll("[data-marble]")) {
    row.addEventListener("click", () => api.openMarble(row.dataset.marble))
  }
}
