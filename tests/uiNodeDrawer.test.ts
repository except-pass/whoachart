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

const flush = () => new Promise((r) => setTimeout(r, 0))

test("showNode streams logs: fetches from cursor 0, appends, advances _since", async () => {
  const el = setupDom()
  const calls: { id: string; since: number }[] = []
  let served: any = {
    lines: [{ seq: 3, ts: "2026-06-10T00:00:01.000Z", marble: "abcd1234", node: "build", stream: "stdout", line: "hi there" }],
    nextSeq: 3,
  }
  const api = { openMarble() {}, nodeLogs: (id: string, since: number) => { calls.push({ id, since }); return Promise.resolve(served) } }

  showNode("build", DEF, { live: [], stats: {}, ends: {} }, api)
  await flush()
  expect(calls[0]).toEqual({ id: "build", since: 0 }) // just-selected → cursor 0
  const c = el.querySelector("#nodeLiveOutput") as any
  expect(c._since).toBe(3)
  expect(el.querySelector(".logline")).toBeTruthy()
  expect(el.querySelector(".logfeed")!.textContent).toContain("hi there")
  expect(el.querySelector(".liveplaceholder")).toBeNull() // placeholder cleared on first line

  // next poll on the same node resumes from the advanced cursor
  served = { lines: [], nextSeq: 3 }
  showNode("build", DEF, { live: [], stats: {}, ends: {} }, api)
  await flush()
  expect(calls[1]).toEqual({ id: "build", since: 3 })
})

test("showNode resets the log cursor to 0 when switching nodes", async () => {
  const el = setupDom()
  const calls: { id: string; since: number }[] = []
  const api = {
    openMarble() {},
    nodeLogs: (id: string, since: number) => {
      calls.push({ id, since })
      return Promise.resolve({ lines: [{ seq: 9, ts: "2026-06-10T00:00:01.000Z", marble: "m", node: id, stream: "stdout", line: "x" }], nextSeq: 9 })
    },
  }
  showNode("build", DEF, { live: [], stats: {}, ends: {} }, api)
  await flush()
  expect((el.querySelector("#nodeLiveOutput") as any)._since).toBe(9)

  showNode("review", DEF, { live: [], stats: {}, ends: {} }, api) // switch → container rebuilt
  await flush()
  expect(calls.at(-1)).toEqual({ id: "review", since: 0 }) // cursor reset, not carried over
})

test("a fetch in flight during a node switch can't clobber the new node's _busy or append to it", async () => {
  const el = setupDom()
  const resolvers: Record<string, (v: any) => void> = {}
  const line = (node: string, seq: number, text: string) =>
    ({ lines: [{ seq, ts: "2026-06-10T00:00:01.000Z", marble: "m", node, stream: "stdout", line: text }], nextSeq: seq })
  const api = {
    openMarble() {},
    nodeLogs: (id: string) => new Promise<any>((r) => { resolvers[id] = r }),
  }

  showNode("build", DEF, { live: [], stats: {}, ends: {} }, api) // build fetch pending
  showNode("review", DEF, { live: [], stats: {}, ends: {} }, api) // switch: review container, review fetch pending
  const reviewC = el.querySelector("#nodeLiveOutput") as any
  expect(reviewC._busy).toBe(true) // review fetch in flight

  // The STALE build fetch resolves after the switch. It must touch neither the
  // review container's _busy (overlap guard) nor its feed (no cross-append).
  resolvers.build(line("build", 5, "BUILDLINE"))
  await flush()
  expect(reviewC._busy).toBe(true) // still in flight — NOT cleared by build's finally (the bug)
  expect(el.querySelector(".logfeed")!.textContent).not.toContain("BUILDLINE")
  expect(reviewC._since).toBeUndefined() // review cursor untouched by build's nextSeq

  // Review's own fetch resolves normally and clears its _busy.
  resolvers.review(line("review", 9, "REVIEWLINE"))
  await flush()
  expect(reviewC._busy).toBe(false)
  expect(reviewC._since).toBe(9)
  expect(el.querySelector(".logfeed")!.textContent).toContain("REVIEWLINE")
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
