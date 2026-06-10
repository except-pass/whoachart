import { test, expect } from "bun:test"
import { Window } from "happy-dom"
import { renderNodeBody, showNode, selectedNode, clearNodeDrawer } from "../src/ui/public/nodeDrawer.js"

// renderNodeBody is pure string-in/string-out — assertable without a DOM.

const shellNode = {
  id: "build",
  type: "shell",
  name: "Build it",
  on_leave: "echo bye",
  timeout: 5000,
  retry: { max: 2 },
  stuck_after: 120,
  config: { on_enter: "echo hi", extra: 7 },
}

const stats = { runs: 3, fails: 1, dwellP50: 1500, dwellP95: 9000 }

test("renderNodeBody shows identity, type, and config meta", () => {
  const html = renderNodeBody(shellNode, stats, [], null)
  expect(html).toContain("Build it")
  expect(html).toContain("shell")
  expect(html).toContain("build") // id row
  expect(html).toContain("120s") // stuck_after
  expect(html).toContain("retry max")
})

test("renderNodeBody highlights on_enter, on_leave as code and dumps the rest as config", () => {
  const html = renderNodeBody(shellNode, stats, [], null)
  expect(html).toContain("on_enter (shell)")
  expect(html).toContain("echo hi")
  expect(html).toContain("on_leave (shell)")
  expect(html).toContain("echo bye")
  // remaining config keys (not on_enter/brief) render under a config block
  expect(html).toContain("config")
  expect(html).toContain("extra")
  // on_enter is rendered as a code block, not duplicated into the config dump
  expect(html).not.toContain('"on_enter"')
})

test("renderNodeBody shows the agent brief", () => {
  const agent = {
    id: "review",
    type: "agent",
    config: { brief: "Do the review", keep_session: true },
  }
  const html = renderNodeBody(agent, null, [], null)
  expect(html).toContain("agent brief")
  expect(html).toContain("Do the review")
  expect(html).toContain("keep_session") // remaining config
})

test("renderNodeBody renders live stats, falling back to em-dash when absent", () => {
  expect(renderNodeBody(shellNode, stats, [], null)).toContain("3") // runs
  const noStats = renderNodeBody(shellNode, null, [], null)
  expect(noStats).toContain("runs")
  expect(noStats).toContain("—") // dwell with no samples
})

test("renderNodeBody lists marbles on the node with a click target", () => {
  const marbles = [
    { id: "abc123", node: "build", status: "running" },
    { id: "def456", node: "build", status: "blocked" },
  ]
  const html = renderNodeBody(shellNode, stats, marbles, null)
  expect(html).toContain("marbles here · 2")
  expect(html).toContain('data-marble="abc123"')
  expect(html).toContain("running")
  expect(html).toContain("blocked")
})

test("renderNodeBody shows present specs and end tallies", () => {
  const node = {
    id: "ok",
    type: "end",
    present: [{ key: "summary", as: "markdown" }],
    config: { outcome: "success" },
  }
  const html = renderNodeBody(node, null, [], { total: 12, recent: [] })
  expect(html).toContain("present")
  expect(html).toContain("summary")
  expect(html).toContain("markdown")
  expect(html).toContain("×12")
})

test("renderNodeBody escapes hostile config and ids", () => {
  const node = {
    id: "x",
    type: "shell",
    config: { on_enter: '"><script>alert(1)</script>' },
  }
  const html = renderNodeBody(node, null, [{ id: '<img>', node: "x", status: "ok" }], null)
  expect(html).not.toContain("<script>")
  expect(html).toContain("&lt;script&gt;")
  expect(html).not.toContain("<img>")
})

// --- showNode DOM wiring (the 1b seam + marble coexistence) ---

function setupDom() {
  const window = new Window()
  ;(globalThis as any).document = window.document
  ;(globalThis as any).Event = window.Event
  const el = window.document.createElement("div")
  el.id = "drawerBody"
  window.document.body.appendChild(el)
  clearNodeDrawer()
  return window.document.getElementById("drawerBody")!
}

const DEF = {
  nodes: [
    { id: "build", type: "shell", config: { on_enter: "echo hi" } },
    { id: "review", type: "agent", config: { brief: "review it" } },
  ],
}
const noop = { openMarble() {} }

test("showNode builds a persistent live-output container that survives meta re-renders", () => {
  const el = setupDom()
  showNode("build", DEF, { live: [], stats: {}, ends: {} }, noop)
  expect(selectedNode()).toBe("build")
  const live = el.querySelector("#nodeLiveOutput")!
  expect(live).toBeTruthy()
  expect((live as any).dataset.node).toBe("build")

  // 1b will append stream lines here — simulate that, then re-render with new stats.
  const line = el.ownerDocument.createElement("div")
  line.className = "streamline"
  line.textContent = "log line from 1b"
  live.appendChild(line)
  showNode("build", DEF, { live: [], stats: { build: { runs: 1, fails: 0, dwellP50: null, dwellP95: null } }, ends: {} }, noop)

  // the appended line survives the meta re-render (seam intact)...
  expect(el.querySelector(".streamline")).toBeTruthy()
  // ...and the meta region updated to the new stats
  expect(el.querySelector("#nodeMeta")!.innerHTML).toContain("runs")
})

test("showNode rebuilds the live container when switching nodes", () => {
  const el = setupDom()
  const state = { live: [], stats: {}, ends: {} }
  showNode("build", DEF, state, noop)
  el.querySelector("#nodeLiveOutput")!.appendChild(el.ownerDocument.createElement("div"))
  showNode("review", DEF, state, noop)
  expect((el.querySelector("#nodeLiveOutput") as any).dataset.node).toBe("review")
  expect(el.querySelector("#nodeLiveOutput")!.children.length).toBe(2) // header + placeholder, the stray div is gone
})

test("showNode wires marble rows to openMarble", () => {
  const el = setupDom()
  const opened: string[] = []
  showNode(
    "build",
    DEF,
    { live: [{ id: "m1", node: "build", status: "running" }], stats: {}, ends: {} },
    { openMarble: (id) => opened.push(id) },
  )
  const row = el.querySelector("[data-marble]") as any
  expect(row).toBeTruthy()
  row.dispatchEvent(new Event("click", { bubbles: true }))
  expect(opened).toEqual(["m1"])
})
