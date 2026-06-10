// whoachart control surface client. Draws the chart from /def, polls /state,
// and renders marbles that travel along the edge curves. The page never
// reloads — all updates are DOM reconciliation + rAF animation.
import { hue, ringFor, fmtAge, fmtMs, ageSeconds, slotPos, counterPos, escHtml, isDangerEdge, oldestBlockedPerNode } from "./helpers.js"
import { renderForm, readForm, showFieldErrors } from "./forms.js"
import { showMarble, selectedMarble, clearDrawer, deselectMarble } from "./drawer.js"
import { showNode, selectedNode, clearNodeDrawer } from "./nodeDrawer.js"

const NS = "http://www.w3.org/2000/svg"
const CHART = globalThis.WHOACHART.chart
const api = (p) => `/api/charts/${encodeURIComponent(CHART)}${p}`

const $ = (id) => document.getElementById(id)
const gEdges = $("edges"), gNodes = $("nodes"), gCounts = $("counts"), gMarbles = $("marbles"), gOverlay = $("overlay")

let DEF = null
const BOX = {} // node id -> box
const NODE = {} // node id -> def node
const NODE_RECT = {} // node id -> <rect> (for selection highlight)
const EDGE_PATH = new Map() // `${from}→${to}` -> path element
const els = new Map() // marble id -> <g>
const lastNode = new Map() // marble id -> node id (for travel detection)
const counts = new Map() // node id -> counter <text>
const traveling = new Set() // marble ids mid path-animation
let lastState = { live: [], ends: {}, stats: {}, deadLetter: [] }

// ---------- API wrappers (shared with the drawer) ----------

async function jsonOrNull(res) {
  try { return await res.json() } catch { return null }
}

// Transient operator feedback for non-field errors (e.g. "marble is not
// blocked" when someone else already decided it). Silence here would let an
// operator believe an action landed when it didn't.
function toast(msg) {
  const t = document.createElement("div")
  t.className = "toast"
  t.textContent = msg
  // flex-column container stacks toasts in DOM order so rapid errors stay readable
  $("toasts").appendChild(t)
  setTimeout(() => {
    t.classList.add("out") // fades and collapses the slot so later toasts don't stack below a ghost
    setTimeout(() => t.remove(), 450)
  }, 2600)
}

const API = {
  toast,
  async marble(id) {
    const res = await fetch(api(`/marbles/${id}`), { cache: "no-store" })
    return res.ok ? jsonOrNull(res) : null
  },
  // returns null on success, {fields} on validation failure, {message} otherwise
  async signal(id, body) {
    const res = await fetch(api(`/marbles/${id}/signal`), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    if (res.ok) return null
    const b = await jsonOrNull(res)
    if (b?.fields) return { fields: b.fields }
    return { message: b?.error ?? `signal failed (${res.status})` }
  },
  async retry(id) {
    const res = await fetch(api(`/marbles/${id}/retry`), { method: "POST" })
    if (!res.ok) {
      const b = await jsonOrNull(res)
      toast(b?.error ?? `retry failed (${res.status})`)
    }
  },
  async focusSession(id) {
    const res = await fetch(api(`/marbles/${id}/focus-session`), { method: "POST" })
    if (!res.ok) {
      const b = await jsonOrNull(res)
      toast(b?.error ?? `focus-session failed (${res.status})`)
    }
  },
  async submit(context) {
    const res = await fetch(api(`/marbles`), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context }),
    })
    if (res.ok) return null
    const b = await jsonOrNull(res)
    if (b?.fields) return { fields: b.fields }
    return { message: b?.error ?? `submit failed (${res.status})` }
  },
  // Live-output delta for a node: { lines, nextSeq } since the given cursor.
  async nodeLogs(nodeId, since) {
    const res = await fetch(api(`/nodes/${encodeURIComponent(nodeId)}/logs?since=${since}`), { cache: "no-store" })
    return res.ok ? jsonOrNull(res) : null
  },
}

// Shared deps handed to the node inspector: jump-to-marble + the log fetcher.
const NODE_API = { openMarble: openDrawer, nodeLogs: (id, since) => API.nodeLogs(id, since) }

// ---------- static graph ----------

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (parent) parent.appendChild(e)
  return e
}

const TYPE_COLOR = {
  source: "#3a5566", shell: "#2a3340", api: "#2a3340", decision: "#5a4a86",
  human: "#5a4a86", agent: "#a78bfa", end: "#2f6f63",
}

function drawStatic() {
  $("svg").setAttribute("viewBox", `0 0 ${DEF.layout.width} ${DEF.layout.height}`)
  for (const n of DEF.nodes) { BOX[n.id] = DEF.layout.boxes[n.id]; NODE[n.id] = n }

  for (const e of DEF.edges) {
    const a = BOX[e.from], b = BOX[e.to]
    if (!a || !b) continue
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y
    const path = el("path", {
      class: "edge",
      d: `M${x1},${y1} C${x1},${y1 + 40} ${x2},${y2 - 40} ${x2},${y2}`,
    }, gEdges)
    EDGE_PATH.set(`${e.from}→${e.to}`, path)
    if (e.name) {
      const t = el("text", { class: "elabel", x: (x1 + x2) / 2 + 6, y: (y1 + y2) / 2 }, gEdges)
      t.textContent = e.name
    }
  }

  for (const n of DEF.nodes) {
    const b = BOX[n.id]
    if (!b) continue
    const g = el("g", {}, gNodes)
    NODE_RECT[n.id] = el("rect", {
      class: "node", x: b.x, y: b.y, width: b.w, height: b.h, rx: 11,
      stroke: n.color ?? TYPE_COLOR[n.type] ?? "#2a3340",
    }, g)
    const name = el("text", { class: "nname", x: b.x + b.w / 2, y: b.y + b.h / 2 - 1 }, g)
    name.textContent = n.name ?? n.id
    const sub = el("text", { class: "nsub", x: b.x + b.w / 2, y: b.y + b.h / 2 + 14 }, g)
    sub.textContent = n.type
    g.addEventListener("mouseenter", (ev) => showHover(n.id, ev))
    g.addEventListener("mousemove", (ev) => moveHover(ev))
    g.addEventListener("mouseleave", hideHover)
    g.addEventListener("click", () => openNodeDrawer(n.id))

    if (n.id === DEF.start && n.type === "source") {
      const add = el("g", { class: "addbtn" }, gNodes)
      el("circle", { cx: b.x + b.w + 14, cy: b.y + 10, r: 11 }, add)
      const plus = el("text", { x: b.x + b.w + 14, y: b.y + 14.5 }, add)
      plus.textContent = "+"
      add.addEventListener("click", () => openIntakeModal(n))
    }
  }
}

// ---------- marbles ----------

function makeMarble(id, node) {
  const g = el("g", { class: "marble" })
  g.style.transition = "transform .55s cubic-bezier(.4,0,.2,1), opacity .45s"
  g.style.opacity = "0"
  const c = el("circle", { r: 8, fill: hue(id) }, g)
  const t = el("text", { class: "mlabel", y: 2.6 }, g)
  t.textContent = id.slice(0, 2)
  const face = el("g", { class: "face" }, g)
  el("circle", { cx: -2.4, cy: -1, r: 1, fill: "#06090d" }, face)
  el("circle", { cx: 2.4, cy: -1, r: 1, fill: "#06090d" }, face)
  el("path", { d: "M-2.6,2 q2.6,2.4 5.2,0", stroke: "#06090d", "stroke-width": 1, fill: "none", "stroke-linecap": "round" }, face)
  const title = el("title", {}, g)
  const age = el("text", { class: "agetag", x: 11, y: 3 }, g)
  g._c = c; g._title = title; g._age = age
  g.addEventListener("click", () => openDrawer(id))
  gMarbles.appendChild(g)
  els.set(id, g)
  requestAnimationFrame(() => { g.style.opacity = "1" })
  return g
}

function setTransform(g, x, y) {
  g.style.transform = `translate(${x}px,${y}px)`
  g._x = x; g._y = y
}

// Animate a marble along the edge curve between two nodes (rAF over the
// path geometry). Falls back to the CSS transform slide when no edge exists.
function travelAlong(g, id, from, to, dest) {
  const path = EDGE_PATH.get(`${from}→${to}`)
  if (!path) { setTransform(g, dest.x, dest.y); return }
  traveling.add(id)
  path.classList.add("pulse")
  const total = path.getTotalLength()
  const start = performance.now()
  const D = 600
  const prevTransition = g.style.transition
  g.style.transition = "opacity .45s" // rAF owns transform during travel
  const stepFrame = (now) => {
    if (els.get(id) !== g) { // dropped mid-travel — stop overwriting the exit transform
      setTimeout(() => path.classList.remove("pulse"), 350)
      return
    }
    const t = Math.min(1, (now - start) / D)
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    const p = path.getPointAtLength(ease * total)
    g.style.transform = `translate(${p.x}px,${p.y}px)`
    if (t < 1) requestAnimationFrame(stepFrame)
    else {
      g.style.transition = prevTransition
      setTransform(g, dest.x, dest.y)
      traveling.delete(id)
      setTimeout(() => path.classList.remove("pulse"), 350)
    }
  }
  requestAnimationFrame(stepFrame)
}

function upsertMarble(id, node, status, agent, dest) {
  let g = els.get(id)
  const isNew = !g
  if (!g) g = makeMarble(id, node)
  const [stroke, width] = ringFor(status)
  g._c.setAttribute("stroke", stroke)
  g._c.setAttribute("stroke-width", width)
  g.classList.toggle("agent", agent)
  g._title.textContent = `${id} @ ${node}`

  const prev = lastNode.get(id)
  lastNode.set(id, node)
  if (isNew || traveling.has(id)) {
    if (isNew) setTransform(g, dest.x, dest.y)
    return
  }
  if (prev && prev !== node) travelAlong(g, id, prev, node, dest)
  else setTransform(g, dest.x, dest.y)
}

function dropMarble(id) {
  const g = els.get(id)
  if (!g) return
  const n = lastNode.get(id)
  const b = n && BOX[n]
  if (b && counts.has(n)) {
    const cp = counterPos(b)
    // restore a transform transition — travelAlong may have left an opacity-only one
    g.style.transition = "transform .55s cubic-bezier(.4,0,.2,1), opacity .45s"
    g.style.transform = `translate(${cp.x}px,${cp.y}px) scale(0.15)` // fly into the tally
  }
  g.style.opacity = "0"
  setTimeout(() => g.remove(), 600)
  els.delete(id)
  lastNode.delete(id)
  traveling.delete(id)
}

function setCount(node, total) {
  const b = BOX[node]
  if (!b) return
  const cp = counterPos(b)
  let t = counts.get(node)
  if (!t) {
    t = el("text", { class: "endcount", x: cp.x, y: cp.y, "text-anchor": "start" }, gCounts)
    t.style.transition = "transform .25s ease"
    t.style.transformOrigin = `${cp.x}px ${cp.y}px`
    counts.set(node, t)
  }
  const next = `×${total}`
  if (t.textContent !== next) {
    t.textContent = next
    t.style.transform = "scale(1.6)"
    setTimeout(() => { t.style.transform = "scale(1)" }, 170)
  }
}

// ---------- gate buttons on the canvas ----------

function drawGateButtons(live) {
  gOverlay.replaceChildren()
  for (const m of oldestBlockedPerNode(live).values()) {
    const b = BOX[m.node]
    if (!b) continue
    m.gate.edges.forEach((edge, i) => {
      const g = el("g", { class: `gatebtn${isDangerEdge(edge.name) ? " danger" : ""}` }, gOverlay)
      const y = b.y + 4 + i * 24
      el("rect", { x: b.x + b.w + 8, y, width: 96, height: 20 }, g)
      const t = el("text", { x: b.x + b.w + 56, y: y + 14 }, g)
      const name = edge.name.length > 9 ? edge.name.slice(0, 8) + "…" : edge.name
      t.textContent = `${name} · ${m.id.slice(0, 4)}`
      el("title", {}, g).textContent = `${edge.name} → ${m.id}` // full name + id (label truncates both)
      g.addEventListener("click", () => {
        if (edge.form && edge.form.length > 0) openEdgeModal(m.id, edge)
        else void API.signal(m.id, { next: edge.name }).then((r) => { if (r?.message) toast(r.message) })
      })
    })
  }
}

// ---------- age / stuck ----------

function tickAges() {
  const now = Date.now()
  for (const m of lastState.live) {
    const g = els.get(m.id)
    if (!g) continue
    const threshold = NODE[m.node]?.stuck_after ?? 300
    const age = ageSeconds(m.enteredAt, now)
    const stuck = (m.status === "blocked" || m.status === "running") && age >= threshold
    g.classList.toggle("stuck", stuck)
    g._age.textContent = stuck ? fmtAge(age) : ""
  }
}

// ---------- tray / hover / bar ----------

function renderTray(deadLetter) {
  const tray = $("tray")
  if (!deadLetter.length) { tray.classList.add("hidden"); return }
  tray.classList.remove("hidden")
  tray.innerHTML =
    `⚠ ${deadLetter.length} errored ` +
    deadLetter
      .slice(-4)
      .map(
        (d) =>
          `<span>${escHtml(d.id)} · ${escHtml(d.node)} · ${escHtml(d.error.slice(0, 60))}</span>` +
          `<button class="retry" data-id="${escHtml(d.id)}">retry</button>`,
      )
      .join(" ")
  for (const btn of tray.querySelectorAll(".retry")) {
    btn.addEventListener("click", () => void API.retry(btn.dataset.id))
  }
}

function showHover(nodeId, ev) {
  const s = lastState.stats[nodeId]
  const queued = lastState.live.filter((m) => m.node === nodeId && m.status === "queued").length
  const card = $("hovercard")
  card.innerHTML =
    `<b>${escHtml(NODE[nodeId]?.name ?? nodeId)}</b><br/>` +
    (s
      ? `runs ${s.runs} · fails ${s.fails}<br/>dwell p50 ${s.dwellP50 != null ? fmtMs(s.dwellP50) : "—"} · p95 ${s.dwellP95 != null ? fmtMs(s.dwellP95) : "—"}<br/>`
      : `no runs yet<br/>`) +
    `queued ${queued}`
  card.classList.remove("hidden")
  moveHover(ev)
}

function moveHover(ev) {
  const rect = $("canvas").getBoundingClientRect()
  const card = $("hovercard")
  card.style.left = `${Math.min(ev.clientX - rect.left + 14, rect.width - 180)}px`
  card.style.top = `${ev.clientY - rect.top + 12}px`
}

function hideHover() {
  $("hovercard").classList.add("hidden")
}

function renderBar(state) {
  $("livecount").textContent = state.live.length
  const done = Object.values(state.ends).reduce((a, e) => a + e.total, 0)
  $("barstats").textContent = `${done} completed · ${state.deadLetter.length} errored`
}

// ---------- modal ----------

let modalGen = 0 // bumped each open/close so a stale in-flight submit can't paint onto a newer modal

export function openModal(title, fields, onSubmit) {
  const modal = $("modal")
  const gen = ++modalGen
  modal.innerHTML = `<div class="box"><h3>${escHtml(title)}</h3>${renderForm(fields)}
    <div class="ferr" id="mErr"></div>
    <div style="margin-top:12px"><button class="act" id="mGo">submit</button>
    <button class="act" id="mCancel" style="border-color:#3a4a5a;color:var(--dim);background:none">cancel</button></div></div>`
  modal.classList.remove("hidden")
  modal.querySelector("#mCancel").addEventListener("click", closeModal)
  modal.querySelector("#mGo").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget
    if (btn.disabled) return
    btn.disabled = true // no concurrent submits — their error painting would interleave
    try {
      const values = readForm(modal, fields)
      const err = await onSubmit(values)
      // modal may have been dismissed or reopened mid-flight — don't paint onto a newer modal
      if (gen !== modalGen) return
      const mErr = modal.querySelector("#mErr")
      // reset both error layers so a retry can't show stale field + message errors together
      showFieldErrors(modal, {})
      mErr.textContent = ""
      if (err?.fields) showFieldErrors(modal, err.fields)
      else if (err?.message) mErr.textContent = err.message
      else closeModal()
    } catch (e) {
      console.error("submit failed", e)
      if (gen !== modalGen) return
      const mErr = modal.querySelector("#mErr")
      // paint something rather than nothing — covers network failure and unexpected bugs
      showFieldErrors(modal, {})
      mErr.textContent = "request failed — is the daemon up?"
    } finally {
      btn.disabled = false
    }
  })
}

function closeModal() {
  modalGen++
  const modal = $("modal")
  modal.classList.add("hidden")
  modal.innerHTML = ""
}

// backdrop dismiss — registered once; clicks inside the box don't match
$("modal").addEventListener("click", (ev) => { if (ev.target === $("modal")) closeModal() })

function openIntakeModal(sourceNode) {
  openModal(`new marble — ${sourceNode.name ?? sourceNode.id}`, sourceNode.form ?? [], (values) => API.submit(values))
}

function openEdgeModal(marbleId, edge) {
  openModal(`${edge.name} — required input`, edge.form, (values) => API.signal(marbleId, { next: edge.name, merge: values }))
}

// ---------- drawer (marble + node inspectors share #drawerBody) ----------

// Marble and node selection are mutually exclusive: opening one clears the
// other (without repainting the placeholder) so the poll loop only refreshes
// the visible view and the two never fight over #drawerBody.
function openDrawer(id) {
  clearNodeDrawer()
  highlightNode(null)
  const live = lastState.live.find((m) => m.id === id)
  void showMarble(id, live?.gate ?? null, API)
}

function openNodeDrawer(id) {
  deselectMarble()
  highlightNode(id)
  showNode(id, DEF, lastState, NODE_API)
}

function highlightNode(id) {
  for (const [nid, rect] of Object.entries(NODE_RECT)) rect.classList.toggle("selected", nid === id)
}

// ---------- poll loop ----------

async function tick() {
  let state
  try {
    const r = await fetch(api("/state"), { cache: "no-store" })
    if (!r.ok) return
    state = await r.json()
  } catch {
    return // daemon momentarily unreachable; keep the last frame
  }
  lastState = state
  const seen = new Set()

  const byNode = {}
  for (const m of state.live) (byNode[m.node] ??= []).push(m)
  for (const [node, ms] of Object.entries(byNode)) {
    const b = BOX[node]
    if (!b) continue
    ms.forEach((m, i) => {
      upsertMarble(m.id, node, m.status, !!m.gate?.agent && m.status === "blocked", slotPos(b, i, ms.length))
      seen.add(m.id)
    })
  }
  for (const [node, info] of Object.entries(state.ends)) {
    const b = BOX[node]
    if (!b) continue
    info.recent.forEach((rm, i) => {
      upsertMarble(rm.id, node, rm.status, false, slotPos(b, i, info.recent.length))
      seen.add(rm.id)
    })
    setCount(node, info.total)
  }
  for (const id of [...els.keys()]) if (!seen.has(id)) dropMarble(id)

  drawGateButtons(state.live)
  renderTray(state.deadLetter)
  renderBar(state)

  // keep an open drawer fresh (and its gate info current)
  const sel = selectedMarble()
  if (sel) {
    const live = state.live.find((m) => m.id === sel)
    void showMarble(sel, live?.gate ?? null, API)
  }
  const selN = selectedNode()
  if (selN) showNode(selN, DEF, state, NODE_API)
}

// ---------- boot ----------

// Chained (not setInterval) so slow /state responses can't overlap and land
// out of order, regressing lastState to an older snapshot.
function pollLoop() {
  tick().catch((e) => console.error("tick failed", e)).finally(() => setTimeout(pollLoop, 600))
}

async function boot() {
  try {
    const r = await fetch(api("/def"))
    if (!r.ok) throw new Error(`/def returned ${r.status}`)
    DEF = await r.json()
  } catch (err) {
    document.querySelector(".bar").textContent = `whoachart — daemon unreachable (${err})`
    return
  }
  drawStatic()
  clearNodeDrawer() // reset both selections to "nothing selected" (clearDrawer only handles the marble side)
  clearDrawer()
  setInterval(tickAges, 1000)
  pollLoop()
}

if (globalThis.WHOACHART.autoboot !== false) void boot() // tests import this module and set autoboot:false
