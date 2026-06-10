// Marble inspector drawer: journey + dwell timings, gate presentation,
// decision buttons (with edge forms), session focus, retry.
import { escHtml, fmtMs, hue, isDangerEdge, trailSteps } from "./helpers.js"
import { renderForm, readForm, showFieldErrors } from "./forms.js"

const body = () => document.getElementById("drawerBody")

let current = null // marble id the drawer is showing
let lastRender = "" // change-detection key so polling doesn't flicker the DOM
let stepSel = null // selected trail step for state time-travel (null = latest)
let fetchSeq = 0 // discard out-of-order marble fetches from overlapping polls

export function selectedMarble() {
  return current
}

export function clearDrawer() {
  current = null
  lastRender = ""
  stepSel = null
  body().innerHTML = `<span style="color:var(--dim)">click a marble…</span>`
}

function trailHtml(steps, sel) {
  return `<div class="crumb">${steps
    .map((s, i) => {
      const dwell = s.dwellMs != null
        ? `<span class="t"> ${fmtMs(s.dwellMs)}</span>`
        : s.live
          ? ` <span class="t">\u25cf now</span>`
          : ""
      const label = s.live
        ? `<span class="now">${escHtml(s.node)}</span>`
        : `<b>${escHtml(s.node)}</b>`
      return `<span class="step${i === sel ? " sel" : ""}" data-i="${i}" title="state after ${escHtml(s.node)}">${label}${dwell}</span>`
    })
    .join(" \u203a ")}</div>`
}

// State time-travel: diff-first view of what changed at the selected step,
// with the full snapshot behind a disclosure.
function diffLines(changes) {
  if (!changes.length) return `<div class="chg" style="color:var(--dim)">no state changes at this step</div>`
  return `<div class="diff">${changes
    .map((c) => {
      const v = (x) => escHtml(JSON.stringify(x))
      if (c.kind === "added") return `<div class="dadd">+ ${escHtml(c.key)}: ${v(c.after)}</div>`
      if (c.kind === "removed") return `<div class="ddel">− ${escHtml(c.key)} (was ${v(c.before)})</div>`
      return `<div class="dchg">~ ${escHtml(c.key)}: ${v(c.before)} → ${v(c.after)}</div>`
    })
    .join("")}</div>`
}

function statePanel(m, steps, sel) {
  const s = steps[sel]
  if (!s) return `<pre class="json">${escHtml(JSON.stringify(m.context, null, 2))}</pre>`
  const title = s.live ? `current state · ${escHtml(s.node)}` : `state after ${escHtml(s.node)}`
  if (!s.context) {
    return `<div class="present"><span class="pk">${title}</span><div class="chg" style="color:var(--dim)">no snapshot for this step (recorded before time-travel existed)</div></div>`
  }
  // First step has no baseline — show the intake state in full instead of a diff.
  const body = sel === 0
    ? `<pre class="json">${escHtml(JSON.stringify(s.context, null, 2))}</pre>`
    : diffLines(s.changes) +
      `<details class="fullstate"><summary>full state at this step</summary><pre class="json">${escHtml(JSON.stringify(s.context, null, 2))}</pre></details>`
  return `<div class="present"><span class="pk">${sel === 0 ? `intake state · ${escHtml(s.node)}` : title}</span>${body}</div>`
}

function presentHtml(m, gate) {
  const specs = gate?.present
  if (!specs || specs.length === 0) return ""
  return specs
    .map((p) => {
      const v = p.key === "workpiece" ? m.workpiece : m.context[p.key]
      if (v === undefined || v === null || v === "") return ""
      let rendered
      switch (p.as) {
        case "json":
          rendered = `<pre class="json">${escHtml(JSON.stringify(v, null, 2))}</pre>`
          break
        case "link":
          // context values are agent/user-supplied — only http(s) gets an <a>
          rendered = /^https?:\/\//i.test(String(v))
            ? `<a href="${escHtml(String(v))}" target="_blank" rel="noopener" style="color:var(--cyan)">${escHtml(String(v))}</a>`
            : escHtml(String(v))
          break
        // markdown renders as plain text for v1 — line breaks preserved by the CSS
        default:
          rendered = escHtml(String(v))
      }
      return `<div class="present"><span class="pk">${escHtml(p.key)}</span>${rendered}</div>`
    })
    .join("")
}

function decisionHtml(gate) {
  const buttons = gate.edges
    .map(
      (e, i) =>
        `<button class="act${isDangerEdge(e.name) ? " danger" : ""}" data-edge="${i}">${escHtml(e.name)}</button>`,
    )
    .join("")
  return gate.agent
    ? `<details class="force"><summary>force a decision (an agent is working this marble)</summary>${buttons}</details>`
    : `<div style="margin-top:10px">${buttons}</div>`
}

// Render (or re-render) the drawer for a marble. api = {marble, signal, retry, focusSession, toast}
export async function showMarble(id, gateInfo, api) {
  if (current !== id) stepSel = null // new marble: back to latest state
  current = id
  const seq = ++fetchSeq
  const m = await api.marble(id)
  if (!m || current !== id || seq !== fetchSeq) return
  const el = body()

  // Don't clobber the DOM while the user is typing in a drawer form, and
  // skip identical re-renders (the poll loop calls this every 600ms).
  if (el.contains(document.activeElement) && document.activeElement !== document.body) return
  const steps = trailSteps(m)
  if (stepSel !== null && stepSel > steps.length - 1) stepSel = null // pinned step fell off (e.g. retry reset the trail)
  const renderKey = id + JSON.stringify(m) + JSON.stringify(gateInfo) + "|" + stepSel
  if (renderKey === lastRender) return
  lastRender = renderKey
  const status = m.status
  const failed = status === "failed" && m.error
  const sel = stepSel ?? Math.max(0, steps.length - 1)

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="width:13px;height:13px;border-radius:50%;background:${hue(m.id)};display:inline-block"></span>
      <b style="font-family:monospace">${escHtml(m.id)}</b>
      <span class="pill" style="color:${failed ? "var(--red)" : status === "blocked" ? "var(--violet)" : "var(--cyan)"}">${escHtml(status)}</span>
    </div>
    ${m.workpiece ? `<div class="kv"><span class="k">workpiece</span><span class="v">${escHtml(m.workpiece)}</span></div>` : ""}
    ${typeof m.context._session === "string" ? `<div class="kv"><span class="k">session</span><span class="v">${escHtml(m.context._session)}</span></div><button class="act violet" id="dFocus">⌖ open session on canvas</button>` : ""}
    ${failed ? `<pre class="json" style="color:#ffb4b4">${escHtml(m.error.split("\n")[0])}</pre><button class="act danger" id="dRetry">↻ retry</button>` : ""}
    ${gateInfo ? `<div class="section decision"><div class="sh">⏳ decision required · ${escHtml(m.node)}</div>${presentHtml(m, gateInfo)}${decisionHtml(gateInfo)}<div id="dForm"></div></div>` : `<div id="dForm"></div>`}
    <div class="section"><div class="sh">history · click a step</div>
    ${trailHtml(steps, sel)}
    ${stepSel !== null ? `<div class="pinhint">pinned to a past step · <span class="resume" id="dResumeLive">⏵ resume live</span></div>` : ""}
    ${statePanel(m, steps, sel)}</div>
  `

  el.querySelector("#dFocus")?.addEventListener("click", () => api.focusSession(id))
  el.querySelector("#dRetry")?.addEventListener("click", () => api.retry(id))
  el.querySelector("#dResumeLive")?.addEventListener("click", () => {
    stepSel = null
    lastRender = ""
    void showMarble(id, gateInfo, api)
  })

  for (const stepEl of el.querySelectorAll(".crumb .step")) {
    stepEl.addEventListener("click", () => {
      const i = Number(stepEl.dataset.i)
      stepSel = i === steps.length - 1 ? null : i // clicking latest re-follows live state
      lastRender = ""
      void showMarble(id, gateInfo, api)
    })
  }

  for (const btn of el.querySelectorAll("button.act[data-edge]")) {
    btn.addEventListener("click", () => {
      const edge = gateInfo.edges[Number(btn.dataset.edge)]
      if (edge.form && edge.form.length > 0) {
        openEdgeForm(el.querySelector("#dForm"), edge, id, api)
      } else {
        void api.signal(id, { next: edge.name }).then((r) => { if (r?.message) api.toast(r.message) })
      }
    })
  }
}

function openEdgeForm(container, edge, id, api) {
  container.innerHTML = `
    <div class="present" style="border-color:#2a3a4a">
      <span class="pk">${escHtml(edge.name)} — required input</span>
      ${renderForm(edge.form)}
      <button class="act" id="dFormGo">submit ${escHtml(edge.name)}</button>
    </div>`
  container.querySelector("#dFormGo").addEventListener("click", async () => {
    const merge = readForm(container, edge.form)
    const res = await api.signal(id, { next: edge.name, merge })
    if (res?.fields) showFieldErrors(container, res.fields)
    else if (res?.message) api.toast(res.message)
  })
}
