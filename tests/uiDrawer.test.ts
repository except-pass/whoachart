import { test, expect } from "bun:test"
import { Window } from "happy-dom"
import { showMarble, deselectMarble } from "../src/ui/public/drawer.js"

// DOM harness mirroring uiNodeDrawer.test.ts: drawer.js renders into #drawerBody.
function setupDom() {
  const window = new Window()
  ;(globalThis as any).document = window.document
  ;(globalThis as any).Event = window.Event
  const el = window.document.createElement("div")
  el.id = "drawerBody"
  window.document.body.appendChild(el)
  deselectMarble()
  return el
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function marble(extra: Record<string, unknown> = {}) {
  return {
    id: "m1",
    status: "blocked",
    node: "gate",
    workpiece: null,
    trail: [{ node: "gate", enteredAt: "2026-06-10T00:00:00.000Z" }],
    context: { report_path: "https://x/report", unhealthy_count: 3 },
    ...extra,
  }
}

const GATE = {
  agent: false,
  edges: [{ name: "approve" }, { name: "reject" }],
  present: [
    { key: "decision", as: "markdown", primary: true },
    { key: "report_path", as: "link" },
    { key: "unhealthy_count", as: "text" },
  ],
}

function api(m: any, overrides: Record<string, unknown> = {}) {
  return {
    marble: () => Promise.resolve(m),
    signal: () => Promise.resolve(null),
    retry() {},
    focusSession() {},
    toast() {},
    presentFile: () => Promise.resolve(null),
    ...overrides,
  }
}

test("a primary `decision` renders prominently as real markdown, above a collapsed evidence footer", async () => {
  const el = setupDom()
  const m = marble({ context: { decision: "## Verdict\n**Approve.**", report_path: "https://x/r", unhealthy_count: 3 } })
  await showMarble("m1", GATE, api(m))

  const primary = el.querySelector(".decision-primary")!
  expect(primary).toBeTruthy()
  // real markdown, not plain text
  expect(primary.innerHTML).toContain('<h2 class="mdh">Verdict</h2>')
  expect(primary.innerHTML).toContain("<strong>Approve.</strong>")
  // the primary brief carries no key label — it speaks for itself
  expect(primary.innerHTML).not.toContain("decision")

  // metadata (paths/counts) demoted into a collapsed <details class="evidence">
  const evidence = el.querySelector("details.evidence") as any
  expect(evidence).toBeTruthy()
  expect(evidence.open).toBe(false)
  expect(evidence.innerHTML).toContain("report_path")
  expect(evidence.innerHTML).toContain("unhealthy_count")

  // decision is positioned ABOVE the evidence footer
  expect(el.innerHTML.indexOf("decision-primary")).toBeLessThan(el.innerHTML.indexOf("evidence"))
})

test("charts with only link/text present entries still work — all demoted to evidence, no primary card", async () => {
  const el = setupDom()
  // mirrors prod-health-sweep: paths + counts, no primary/decision
  const gate = {
    agent: false,
    edges: [{ name: "approve" }],
    present: [
      { key: "triage_brief_path", as: "link" },
      { key: "results_dir", as: "text" },
      { key: "unhealthy_count", as: "text" },
    ],
  }
  const m = marble({ context: { triage_brief_path: "/p/brief.md", results_dir: "/p", unhealthy_count: 2 } })
  await showMarble("m1", gate, api(m))

  expect(el.querySelector(".decision-primary")).toBeNull() // nothing promoted
  const evidence = el.querySelector("details.evidence")!
  expect(evidence.innerHTML).toContain("triage_brief_path")
  expect(evidence.innerHTML).toContain("results_dir")
})

test("ACCEPTANCE: an injected decision appears on a re-render WITHOUT manual reload (poll path)", async () => {
  const el = setupDom()
  // Marble is blocked at the gate with no decision yet (operator is looking).
  let m = marble({ context: { report_path: "https://x/r" } })
  const dynamicApi = api(m, { marble: () => Promise.resolve(m) })
  await showMarble("m1", GATE, dynamicApi)
  expect(el.querySelector(".decision-primary")).toBeNull()

  // An agent annotates the marble; the very next poll tick re-fetches it and
  // re-runs showMarble — exactly what app.js's tick() does every 600ms.
  m = marble({ context: { report_path: "https://x/r", decision: "## Go\nship it" } })
  await showMarble("m1", GATE, dynamicApi)

  const primary = el.querySelector(".decision-primary")!
  expect(primary).toBeTruthy()
  expect(primary.innerHTML).toContain('<h2 class="mdh">Go</h2>')
  expect(primary.innerHTML).toContain("ship it")
})

test("as: markdown_file hydrates the file body in place after fetch", async () => {
  const el = setupDom()
  const gate = {
    agent: false,
    edges: [{ name: "approve" }],
    present: [{ key: "brief_file", as: "markdown_file", primary: true }],
  }
  const m = marble({ context: { brief_file: "/tmp/brief.md" } })
  let fetched = 0
  const a = api(m, {
    marble: () => Promise.resolve(m),
    presentFile: (_id: string, key: string) => {
      fetched++
      expect(key).toBe("brief_file")
      return Promise.resolve({ path: "/tmp/brief.md", markdown: "# Inlined\nfrom file" })
    },
  })

  await showMarble("m1", gate, a)
  // first paint shows a placeholder while the fetch is pending
  expect(el.querySelector(".mdfile-load")).toBeTruthy()

  for (let i = 0; i < 6; i++) await flush() // let presentFile resolve + re-render
  expect(fetched).toBe(1)
  expect(el.querySelector(".mdfile-load")).toBeNull() // placeholder replaced
  const primary = el.querySelector(".decision-primary")!
  expect(primary.innerHTML).toContain('<h1 class="mdh">Inlined</h1>')
  expect(primary.innerHTML).toContain("from file")
})

test("a hostile markdown decision cannot inject raw HTML", async () => {
  const el = setupDom()
  const m = marble({ context: { decision: "<img src=x onerror=alert(1)>\n**ok**" } })
  await showMarble("m1", GATE, api(m))
  const primary = el.querySelector(".decision-primary")!
  expect(primary.innerHTML).not.toContain("<img")
  expect(primary.innerHTML).toContain("&lt;img")
  expect(primary.innerHTML).toContain("<strong>ok</strong>")
})
