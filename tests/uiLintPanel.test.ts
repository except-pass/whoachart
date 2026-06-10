// tests/uiLintPanel.test.ts — DOM behavior of the lint panel client module.
// Stays on the happy-dom `window.document` object (never the DOM globals) so it
// typechecks under the project's ESNext-only lib, mirroring uiNodeDrawer.test.ts.
import { test, expect } from "bun:test"
import { Window } from "happy-dom"
import { mountLintPanel, type LintWarning } from "../src/ui/public/lintPanel.js"

function setupDom() {
  const window = new Window()
  ;(globalThis as any).document = window.document
  ;(globalThis as any).Event = window.Event
  const doc = window.document
  const canvas = doc.createElement("div")
  canvas.id = "canvas"
  doc.body.appendChild(canvas)
  const click = (el: any) => el.dispatchEvent(new window.Event("click"))
  return { doc, canvas, click }
}

function def(lint: LintWarning[], nodes = [{ id: "a" }, { id: "b" }]) {
  return { lint, nodes }
}

test("renders nothing for a clean chart", () => {
  const { doc } = setupDom()
  const panel = mountLintPanel(def([]))
  expect(panel).toBeNull()
  expect(doc.querySelector(".lintpanel")).toBeNull()
})

test("lists each finding with a level dot and a header count", () => {
  const { canvas } = setupDom()
  mountLintPanel(def([
    { level: "warn", code: "dead-end", node: "a", message: "node a has no outgoing edges" },
    { level: "info", code: "end-with-outgoing", node: "b", message: "end b has an outgoing edge" },
  ]))
  const panel = canvas.querySelector(".lintpanel")!
  expect(panel).not.toBeNull()
  expect(panel.querySelectorAll(".lpitem").length).toBe(2)
  expect(panel.querySelector(".lpdot.warn")).not.toBeNull()
  expect(panel.querySelector(".lpdot.info")).not.toBeNull()
  // header summarizes counts split by severity
  expect(panel.querySelector(".lpcount")!.textContent).toContain("1 warning")
  expect(panel.querySelector(".lpcount")!.textContent).toContain("1 info")
})

test("clicking a node-scoped finding invokes the click-through callback", () => {
  const { doc, click } = setupDom()
  const clicks: string[] = []
  mountLintPanel(def([{ level: "warn", code: "dead-end", node: "a", message: "x" }]), {
    onNodeClick: (id) => clicks.push(id),
  })
  const item = doc.querySelector(".lpitem.click")
  expect(item).not.toBeNull()
  click(item)
  expect(clicks).toEqual(["a"])
})

test("an edge finding routes click-through to a real source endpoint", () => {
  const { doc, click } = setupDom()
  const clicks: string[] = []
  mountLintPanel(def([{ level: "warn", code: "dangling-edge", edge: { from: "a", to: "ghost" }, message: "x" }]), {
    onNodeClick: (id) => clicks.push(id),
  })
  click(doc.querySelector(".lpitem.click"))
  expect(clicks).toEqual(["a"])
})

test("escapes a malicious node id / message rather than injecting live markup", () => {
  const { doc } = setupDom()
  const evil = `"><img src=x onerror=alert(1)>`
  mountLintPanel(def(
    [{ level: "warn", code: "dead-end", node: evil, message: `node ${evil} dangles` }],
    [{ id: evil }],
  ))
  const panel = doc.querySelector(".lintpanel")!
  // PRIMARY: the injected <img> must never become a real element anywhere in
  // the panel — neither from the message nor from the data-node attribute (the
  // `"` escape keeps the attribute from breaking out of its quotes).
  expect(panel.querySelectorAll("img").length).toBe(0)
  // The payload survives as inert TEXT, proving it was escaped, not parsed as
  // markup (textContent round-trips the entities back to the literal string).
  expect(panel.querySelector(".lpmsg")!.textContent).toContain("<img src=x onerror=alert(1)>")
  // And the click-through still targets the (escaped) node id intact.
  expect((doc.querySelector(".lpitem.click") as any).getAttribute("data-node")).toBe(evil)
})

test("the × dismiss button hides the panel; header toggles collapse", () => {
  const { doc, click } = setupDom()
  mountLintPanel(def([{ level: "warn", code: "dead-end", node: "a", message: "x" }]))
  const panel = doc.querySelector(".lintpanel")!
  click(panel.querySelector(".lph"))
  expect(panel.classList.contains("collapsed")).toBe(true)
  click(panel.querySelector(".lpx"))
  expect(panel.classList.contains("hidden")).toBe(true)
})
