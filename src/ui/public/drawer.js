// Marble inspector drawer: journey + dwell timings, gate presentation,
// decision buttons (with edge forms), session focus, retry.
import { escHtml, fmtMs, hue, isDangerEdge } from "./helpers.js"
import { renderForm, readForm, showFieldErrors } from "./forms.js"

const body = () => document.getElementById("drawerBody")

let current = null // marble id the drawer is showing
let lastRender = "" // change-detection key so polling doesn't flicker the DOM
let fetchSeq = 0 // discard out-of-order marble fetches from overlapping polls

export function selectedMarble() {
  return current
}

export function clearDrawer() {
  current = null
  lastRender = ""
  body().innerHTML = `<span style="color:var(--dim)">click a marble…</span>`
}

function trailHtml(m) {
  const trail = m.trail ?? []
  return `<div class="crumb">${trail
    .map((h, i) => {
      const last = i === trail.length - 1
      const dwell = h.leftAt
        ? `<span class="t"> ${fmtMs(new Date(h.leftAt) - new Date(h.enteredAt))}</span>`
        : last
          ? ` <span class="t">● now</span>`
          : ""
      return last && !h.leftAt
        ? `<span class="now">${escHtml(h.node)}</span>${dwell}`
        : `<b>${escHtml(h.node)}</b>${dwell}`
    })
    .join(" › ")}</div>`
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
  current = id
  const seq = ++fetchSeq
  const m = await api.marble(id)
  if (!m || current !== id || seq !== fetchSeq) return
  const el = body()

  // Don't clobber the DOM while the user is typing in a drawer form, and
  // skip identical re-renders (the poll loop calls this every 600ms).
  if (el.contains(document.activeElement) && document.activeElement !== document.body) return
  const renderKey = id + JSON.stringify(m) + JSON.stringify(gateInfo)
  if (renderKey === lastRender) return
  lastRender = renderKey
  const status = m.status
  const failed = status === "failed" && m.error

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="width:13px;height:13px;border-radius:50%;background:${hue(m.id)};display:inline-block"></span>
      <b style="font-family:monospace">${escHtml(m.id)}</b>
      <span class="pill" style="color:${failed ? "var(--red)" : status === "blocked" ? "var(--violet)" : "var(--cyan)"}">${escHtml(status)}</span>
    </div>
    ${trailHtml(m)}
    ${m.workpiece ? `<div class="kv"><span class="k">workpiece</span><span class="v">${escHtml(m.workpiece)}</span></div>` : ""}
    ${typeof m.context._session === "string" ? `<div class="kv"><span class="k">session</span><span class="v">${escHtml(m.context._session)}</span></div><button class="act violet" id="dFocus">⌖ open session on canvas</button>` : ""}
    ${failed ? `<pre class="json" style="color:#ffb4b4">${escHtml(m.error.split("\n")[0])}</pre><button class="act danger" id="dRetry">↻ retry</button>` : ""}
    ${gateInfo ? presentHtml(m, gateInfo) : ""}
    ${gateInfo ? decisionHtml(gateInfo) : ""}
    <div id="dForm"></div>
    <pre class="json">${escHtml(JSON.stringify(m.context, null, 2))}</pre>
  `

  el.querySelector("#dFocus")?.addEventListener("click", () => api.focusSession(id))
  el.querySelector("#dRetry")?.addEventListener("click", () => api.retry(id))

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
