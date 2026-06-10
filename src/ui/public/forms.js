// Typed form rendering + collection for FormField[] specs from /def.
// Server-side validation is the enforcement point; this is the convenience UI.
import { enumWidget, escHtml } from "./helpers.js"

export function renderForm(fields) {
  return fields
    .map((f) => {
      const label = escHtml(f.label ?? f.key)
      const req = f.required ? " *" : ""
      let input
      switch (f.type) {
        case "enum": {
          const opts = f.options ?? []
          if (enumWidget(opts) === "radio") {
            input = `<div class="radio-row">${opts
              .map(
                (o) =>
                  `<label><input type="radio" name="f_${escHtml(f.key)}" value="${escHtml(o)}"${
                    o === f.default ? " checked" : ""
                  }/> ${escHtml(o)}</label>`,
              )
              .join("")}</div>`
          } else {
            input = `<select name="f_${escHtml(f.key)}">${opts
              .map((o) => `<option value="${escHtml(o)}"${o === f.default ? " selected" : ""}>${escHtml(o)}</option>`)
              .join("")}</select>`
          }
          break
        }
        case "number":
          input = `<input type="number" name="f_${escHtml(f.key)}"${
            f.min !== undefined ? ` min="${f.min}"` : ""
          }${f.max !== undefined ? ` max="${f.max}"` : ""}${f.step !== undefined ? ` step="${f.step}"` : ""}${
            f.default !== undefined ? ` value="${escHtml(f.default)}"` : ""
          }/>`
          break
        case "boolean":
          input = `<label><input type="checkbox" name="f_${escHtml(f.key)}"${f.default === true ? " checked" : ""}/> ${label}</label>`
          break
        case "textarea":
          input = `<textarea name="f_${escHtml(f.key)}">${f.default !== undefined ? escHtml(f.default) : ""}</textarea>`
          break
        default:
          input = `<input type="text" name="f_${escHtml(f.key)}"${
            f.default !== undefined ? ` value="${escHtml(f.default)}"` : ""
          }/>`
      }
      const labelRow = f.type === "boolean" ? "" : `<label class="fl">${label}${req}</label>`
      return `<div class="field" data-key="${escHtml(f.key)}">${labelRow}${input}<div class="ferr"></div></div>`
    })
    .join("")
}

// Collect values from a container previously filled by renderForm. Skips
// empty optional fields so server defaults apply.
export function readForm(container, fields) {
  const values = {}
  for (const f of fields) {
    const els = container.querySelectorAll(`[name="f_${f.key}"]`)
    if (els.length === 0) continue
    if (f.type === "boolean") {
      values[f.key] = els[0].checked
    } else if (f.type === "enum" && els[0].type === "radio") {
      const checked = [...els].find((e) => e.checked)
      if (checked) values[f.key] = checked.value
    } else if (f.type === "number") {
      if (els[0].value !== "") values[f.key] = Number(els[0].value)
    } else {
      if (els[0].value !== "") values[f.key] = els[0].value
    }
  }
  return values
}

// Paint per-field error messages returned by the server (400 {fields}).
export function showFieldErrors(container, fieldErrors) {
  for (const div of container.querySelectorAll(".field")) {
    const key = div.dataset.key
    const err = fieldErrors?.[key]
    div.classList.toggle("haserr", !!err)
    div.querySelector(".ferr").textContent = err ?? ""
  }
}
