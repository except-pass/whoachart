// Marble HISTORY search (roadmap 3c). A self-contained overlay panel that lists
// EVERY marble for the chart — live, completed, and failed — from
// GET /api/charts/:name/marbles, with fuzzy search (across id, context VALUES,
// workpiece, current node) and a per-status filter. Each row clicks through to
// openDrawer(id) so the marble opens in the existing 1a/1b inspector.
//
// Search runs CLIENT-SIDE: the endpoint already returns the full set, charts
// carry a bounded number of marbles, and keeping it client-side means no new
// query-param parsing on the (shared, concurrently-edited) controlApi.ts and a
// tiny merge surface — only app.js gains an import + one mount call.
//
// The module is import-safe: nothing here touches the DOM at load time, so
// app.js (and the test harness, which imports app.js with autoboot off) can
// pull it in without a document. mountMarbleSearch() does all the DOM work.
import { hue, escHtml } from "./helpers.js"

const STATUSES = ["queued", "running", "blocked", "done", "failed"]
const STATUS_COLOR = {
  queued: "var(--dim)", running: "var(--cyan)", blocked: "var(--violet)",
  done: "var(--green)", failed: "var(--red)",
}

// ---------- pure, unit-tested ----------

// Flatten a marble into one searchable string. We search context VALUES (not
// keys, per spec) plus id, workpiece, and current node. Non-string values are
// JSON-stringified so structured context (numbers, arrays, objects) stays
// findable. Fields are joined with a non-word separator so a fuzzy subsequence
// can still span fields without the contiguity bonus leaking across a boundary.
export function marbleHaystack(m) {
  const parts = [m.id ?? "", m.workpiece ?? "", m.node ?? ""]
  for (const v of Object.values(m.context ?? {})) {
    parts.push(typeof v === "string" ? v : JSON.stringify(v) ?? "")
  }
  return parts.join("  ")
}

// Case-insensitive subsequence fuzzy score. Returns -1 when `query` is not a
// subsequence of `text`; otherwise a non-negative score that rewards contiguous
// runs and word-boundary starts so the tightest matches rank first. Empty query
// scores 0 (matches everything).
export function fuzzyScore(query, text) {
  const q = query.toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  let qi = 0, score = 0, prev = -2, run = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    run = ti === prev + 1 ? run + 1 : 0
    score += 1 + run * 2 // longer contiguous runs score progressively higher
    if (ti === 0 || /\W/.test(t[ti - 1])) score += 3 // bonus for word-start hits
    prev = ti
    qi++
  }
  return qi === q.length ? score : -1
}

// Filter + rank marbles for the panel. The query is whitespace-tokenised and
// every token must fuzzy-match the marble's combined text (AND semantics), so
// "deploy prod" can match a workpiece in one field and a context value in
// another. `statuses` is null (no status filter — match all) or a Set of
// allowed statuses (an empty Set therefore matches NOTHING — an explicit
// "deselect everything"). Sorted by score desc, then newest first.
export function searchMarbles(marbles, query, statuses) {
  const tokens = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean)
  const out = []
  for (const m of marbles) {
    if (statuses && !statuses.has(m.status)) continue
    let score = 0
    if (tokens.length) {
      const hay = marbleHaystack(m)
      let ok = true
      for (const tok of tokens) {
        const s = fuzzyScore(tok, hay)
        if (s < 0) { ok = false; break }
        score += s
      }
      if (!ok) continue
    }
    out.push({ m, score })
  }
  // ISO timestamps sort lexicographically by time, so newest-first = b vs a.
  out.sort((a, b) => b.score - a.score || String(b.m.createdAt).localeCompare(String(a.m.createdAt)))
  return out.map((r) => r.m)
}

export function statusCounts(marbles) {
  const c = {}
  for (const m of marbles) c[m.status] = (c[m.status] ?? 0) + 1
  return c
}

// Always-on age label (helpers.fmtAge blanks under a minute, which would leave
// fresh history rows empty): 12s / 5m / 3h / 2d from an ISO timestamp to nowMs.
export function fmtAgeFull(iso, nowMs) {
  const sec = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

// ---------- DOM ----------

const STYLE = `
#msearchBtn{margin-left:auto;background:#0f2630;border:1px solid var(--cyan);color:#bff4ff;
  border-radius:7px;padding:3px 11px;font:600 11px system-ui;cursor:pointer}
#msearchBtn:hover{background:#13323d}
.msearch{position:fixed;inset:0;background:rgba(4,7,11,.72);display:flex;align-items:flex-start;
  justify-content:center;z-index:60;padding-top:7vh}
.msearch.hidden{display:none}
.msearch-box{background:var(--panel);border:1px solid #2a3a4a;border-radius:12px;width:min(760px,92vw);
  max-height:82vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.55)}
.msearch-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)}
.msearch-title{color:var(--cyan);font:600 13px system-ui}
.msearch-count{color:var(--dim);font:10.5px monospace}
.msearch-btn{background:none;border:1px solid #2a3a4a;color:var(--dim);border-radius:6px;
  width:26px;height:26px;cursor:pointer;font-size:13px;line-height:1}
.msearch-btn.right{margin-left:auto}
.msearch-btn:hover{color:var(--ink);border-color:#3a4a5a}
.msearch-input{margin:12px 14px 0;background:#06090d;border:1px solid #243240;border-radius:8px;
  color:var(--ink);padding:9px 11px;font:13px monospace;outline:none}
.msearch-input:focus{border-color:var(--cyan)}
.msearch-chips{display:flex;flex-wrap:wrap;gap:7px;padding:11px 14px 4px}
.msearch-chip{background:#0a1118;border:1px solid #243240;color:var(--dim);border-radius:20px;
  padding:3px 11px;font:11px monospace;cursor:pointer}
.msearch-chip.on{border-color:var(--c);color:var(--c)}
.msearch-chip b{color:var(--ink);font-weight:700}
.msearch-chip.on b{color:var(--c)}
.msearch-results{overflow:auto;padding:6px 8px 12px}
.msearch-empty{color:var(--dim);font:11px monospace;padding:26px;text-align:center}
.msearch-tbl{width:100%;border-collapse:collapse;font-size:12px}
.msearch-tbl th{text-align:left;color:var(--dim);font:10px monospace;text-transform:uppercase;
  letter-spacing:1px;padding:5px 8px;border-bottom:1px solid var(--line);position:sticky;top:0;
  background:var(--panel)}
.msearch-row{cursor:pointer}
.msearch-row:hover{background:#13202c}
.msearch-row td{padding:6px 8px;border-bottom:1px dashed #18222d;font-family:monospace;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.msearch-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;
  vertical-align:middle}
.msearch-pill{display:inline-block;padding:1px 8px;border-radius:20px;font-size:10.5px;
  border:1px solid currentColor}
`

function injectStyle() {
  if (document.getElementById("msearch-style")) return
  const s = document.createElement("style")
  s.id = "msearch-style"
  s.textContent = STYLE
  document.head.appendChild(s)
}

// Mount the search affordance: a button in the top bar + a hidden overlay panel.
// opts = { chart, openMarble }. openMarble(id) is app.js's openDrawer, reused so
// click-through lands in the existing inspector. Idempotent.
export function mountMarbleSearch({ chart, openMarble }) {
  if (typeof document === "undefined") return
  if (document.getElementById("msearchBtn")) return
  injectStyle()

  const btn = document.createElement("button")
  btn.id = "msearchBtn"
  btn.type = "button"
  btn.textContent = "🔍 history"
  btn.title = "search marble history  ( / )"
  ;(document.querySelector(".bar") ?? document.body).appendChild(btn)

  const overlay = document.createElement("div")
  overlay.className = "msearch hidden"
  overlay.innerHTML = `
    <div class="msearch-box">
      <div class="msearch-head">
        <span class="msearch-title">marble history</span>
        <span class="msearch-count" id="msearchCount"></span>
        <button class="msearch-btn right" id="msearchRefresh" title="reload">⟳</button>
        <button class="msearch-btn" id="msearchClose" title="close (Esc)">✕</button>
      </div>
      <input class="msearch-input" id="msearchInput" placeholder="fuzzy: id · context · workpiece · node…"
        autocomplete="off" autocapitalize="off" spellcheck="false"/>
      <div class="msearch-chips" id="msearchChips"></div>
      <div class="msearch-results" id="msearchResults"></div>
    </div>`
  document.body.appendChild(overlay)

  const inputEl = overlay.querySelector("#msearchInput")
  const chipsEl = overlay.querySelector("#msearchChips")
  const resultsEl = overlay.querySelector("#msearchResults")
  const countEl = overlay.querySelector("#msearchCount")

  let all = [] // every marble for the chart (last load)
  let query = ""
  const active = new Set(STATUSES) // all statuses on by default

  const isOpen = () => !overlay.classList.contains("hidden")
  const close = () => overlay.classList.add("hidden")

  function renderChips() {
    const counts = statusCounts(all)
    chipsEl.innerHTML = STATUSES
      .map((s) => `<button class="msearch-chip${active.has(s) ? " on" : ""}" data-s="${s}" ` +
        `style="--c:${STATUS_COLOR[s]}">${s} <b>${counts[s] ?? 0}</b></button>`)
      .join("")
  }

  function renderResults() {
    const now = Date.now()
    const rows = searchMarbles(all, query, active)
    countEl.textContent = `${rows.length} / ${all.length}`
    if (!rows.length) {
      resultsEl.innerHTML = `<div class="msearch-empty">${all.length ? "no marbles match" : "no marbles yet"}</div>`
      return
    }
    resultsEl.innerHTML =
      `<table class="msearch-tbl"><thead><tr><th>id</th><th>status</th><th>node</th><th>age</th></tr></thead><tbody>` +
      rows.map((m) =>
        `<tr class="msearch-row" data-id="${escHtml(m.id)}">` +
        `<td><span class="msearch-dot" style="background:${hue(m.id)}"></span>${escHtml(m.id)}</td>` +
        `<td><span class="msearch-pill" style="color:${STATUS_COLOR[m.status] ?? "var(--ink)"}">${escHtml(m.status)}</span></td>` +
        `<td>${escHtml(m.node)}</td>` +
        `<td>${fmtAgeFull(m.createdAt, now)}</td></tr>`).join("") +
      `</tbody></table>`
    for (const tr of resultsEl.querySelectorAll(".msearch-row")) {
      tr.addEventListener("click", () => { openMarble(tr.dataset.id); close() })
    }
  }

  async function load() {
    resultsEl.innerHTML = `<div class="msearch-empty">loading…</div>`
    try {
      const r = await fetch(`/api/charts/${encodeURIComponent(chart)}/marbles`, { cache: "no-store" })
      if (!r.ok) throw new Error(`marbles ${r.status}`)
      const data = await r.json()
      all = Array.isArray(data?.marbles) ? data.marbles : []
    } catch (e) {
      all = []
      renderChips()
      resultsEl.innerHTML = `<div class="msearch-empty">failed to load marbles (${escHtml(String(e))})</div>`
      return
    }
    renderChips()
    renderResults()
  }

  function open() {
    overlay.classList.remove("hidden")
    inputEl.value = query
    void load()
    inputEl.focus()
    inputEl.select()
  }

  btn.addEventListener("click", open)
  overlay.querySelector("#msearchClose").addEventListener("click", close)
  overlay.querySelector("#msearchRefresh").addEventListener("click", () => void load())
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close() }) // backdrop
  inputEl.addEventListener("input", () => { query = inputEl.value; renderResults() })
  chipsEl.addEventListener("click", (ev) => {
    const chip = ev.target.closest(".msearch-chip")
    if (!chip) return
    const s = chip.dataset.s
    if (active.has(s)) active.delete(s)
    else active.add(s)
    renderChips()
    renderResults()
  })

  // "/" opens the panel (unless typing elsewhere); Esc closes it.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && isOpen()) { close(); return }
    if (ev.key === "/" && !isOpen()) {
      const a = document.activeElement
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return
      ev.preventDefault()
      open()
    }
  })
}
