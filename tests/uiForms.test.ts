import { test, expect } from "bun:test"
import { Window } from "happy-dom"
import { renderForm, readForm, showFieldErrors } from "../src/ui/public/forms.js"

// renderForm is pure string-in/string-out — assertable without a DOM.

test("renderForm picks radio for short enums, select for long", () => {
  const radio = renderForm([{ key: "mood", type: "enum", options: ["ok", "bad"] }])
  expect(radio).toContain('type="radio"')
  const select = renderForm([{ key: "size", type: "enum", options: ["a", "b", "c", "d", "e"] }])
  expect(select).toContain("<select")
})

test("renderForm select gets an empty placeholder when no default", () => {
  const opts = ["a", "b", "c", "d", "e"]
  const noDefault = renderForm([{ key: "k", type: "enum", options: opts }])
  expect(noDefault).toContain('<option value=""></option>')
  const withDefault = renderForm([{ key: "k", type: "enum", options: opts, default: "b" }])
  expect(withDefault).not.toContain('<option value=""></option>')
  expect(withDefault).toContain('value="b" selected')
})

test("renderForm marks required fields and applies defaults", () => {
  const html = renderForm([
    { key: "name", type: "text", label: "Name", required: true, default: "bob" },
    { key: "n", type: "number", min: 1, max: 9, default: 3 },
    { key: "ok", type: "boolean", default: true },
  ])
  expect(html).toContain("Name *")
  expect(html).toContain('value="bob"')
  expect(html).toContain('min="1"')
  expect(html).toContain('value="3"')
  expect(html).toContain("checked")
})

test("renderForm escapes defaults and labels", () => {
  const html = renderForm([{ key: "x", type: "text", label: '<b>"L"</b>', default: '"><script>' }])
  expect(html).not.toContain("<script>")
  expect(html).toContain("&lt;b&gt;")
  expect(html).toContain("&quot;&gt;&lt;script&gt;")
})

// readForm / showFieldErrors need a DOM — happy-dom provides a light one.

function dom(html: string) {
  const document = new Window().document
  const div = document.createElement("div")
  div.innerHTML = html
  return div
}

test("readForm round-trips typed values and skips empty optionals", () => {
  const fields = [
    { key: "name", type: "text", default: "bob" },
    { key: "n", type: "number", default: 3 },
    { key: "ok", type: "boolean", default: true },
    { key: "blank", type: "text" },
    { key: "size", type: "enum", options: ["a", "b", "c", "d", "e"] },
  ]
  const c = dom(renderForm(fields))
  expect(readForm(c, fields)).toEqual({ name: "bob", n: 3, ok: true })
})

test("readForm picks the checked radio, nothing when unchecked", () => {
  const fields = [{ key: "mood", type: "enum", options: ["ok", "bad"] }]
  const c = dom(renderForm(fields))
  expect(readForm(c, fields)).toEqual({})
  ;(c.querySelector('input[value="bad"]') as any).checked = true
  expect(readForm(c, fields)).toEqual({ mood: "bad" })
})

test("showFieldErrors paints and clears per-field messages", () => {
  const fields = [{ key: "name", type: "text" }, { key: "n", type: "number" }]
  const c = dom(renderForm(fields))
  showFieldErrors(c, { name: "required" })
  const nameField = c.querySelector('[data-key="name"]')!
  expect(nameField.classList.contains("haserr")).toBe(true)
  expect(nameField.querySelector(".ferr")!.textContent).toBe("required")
  expect(c.querySelector('[data-key="n"]')!.classList.contains("haserr")).toBe(false)
  showFieldErrors(c, {})
  expect(nameField.classList.contains("haserr")).toBe(false)
  expect(nameField.querySelector(".ferr")!.textContent).toBe("")
})

test("openModal paints the generic failure and clears fields when onSubmit rejects", async () => {
  const window = new Window()
  ;(globalThis as any).document = window.document
  ;(globalThis as any).WHOACHART = { chart: "c", autoboot: false }
  window.document.body.innerHTML = `<div id="toasts"></div><div id="modal" class="modal hidden"></div>`
  const { openModal } = await import("../src/ui/public/app.js")

  const errs: any[] = []
  const origErr = console.error
  console.error = (...a: any[]) => void errs.push(a)
  try {
    openModal("t", [{ key: "name", type: "text" }], () => Promise.reject(new Error("boom")))
    ;(window.document.querySelector("#mGo") as any).click()
    await new Promise((r) => setTimeout(r, 0))
  } finally {
    console.error = origErr
  }

  expect(window.document.querySelector("#mErr")!.textContent).toBe("request failed — is the daemon up?")
  expect(window.document.querySelector('[data-key="name"]')!.classList.contains("haserr")).toBe(false)
  expect(errs.length).toBe(1) // original error is logged, not swallowed
})
