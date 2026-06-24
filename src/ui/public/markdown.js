// Tiny, dependency-free, SAFE markdown → HTML renderer for the control surface.
//
// SECURITY MODEL: the source is HTML-escaped FIRST (escHtml), so any `<`, `>`,
// `&`, or `"` in agent/operator-supplied content becomes inert text before a
// single markdown rule runs. Every tag this renderer emits is its own — the
// input can never inject raw HTML. The only attribute we ever interpolate is a
// link href, and that is restricted to http(s) (everything else renders as the
// bracket text only). Keep that invariant if you extend this.
//
// Supported: ATX headings (#..####), bold (**/__), italic (*/_), inline `code`,
// fenced ``` code blocks, -/*/+ and 1. lists, > blockquotes, --- rules, and
// [text](http(s)://…) links. Unsupported syntax degrades to escaped text.
import { escHtml } from "./helpers.js"

// Inline spans, applied to ALREADY-ESCAPED text. Order matters: code first so
// `**` inside backticks stays literal; links before emphasis so a `*` in a URL
// isn't eaten.
function inline(escaped) {
  let s = escaped
  // `code`
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
  // [label](http(s)://url) — href restricted to http(s); label keeps its spans
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
    // href came through escHtml already, so quotes are &quot; — safe in an attr.
    return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`
  })
  // **bold** / __bold__
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>")
  // *italic* / _italic_  (single delimiters, run after the double forms)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>")
  return s
}

// Render markdown source to a safe HTML string. Pure: no DOM access.
export function renderMarkdown(src) {
  const lines = escHtml(String(src ?? "")).split("\n")
  const out = []
  let para = [] // buffered paragraph lines
  let list = null // { tag: "ul"|"ol", items: string[] }
  let quote = [] // buffered blockquote lines

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((t) => `<li>${inline(t)}</li>`).join("")}</${list.tag}>`)
    list = null
  }
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`)
    quote = []
  }
  const flushAll = () => { flushPara(); flushList(); flushQuote() }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Fenced code block: consume verbatim (no inline rules) until the closing ```
    if (/^```/.test(line.trim())) {
      flushAll()
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++])
      out.push(`<pre class="mdcode">${buf.join("\n")}</pre>`)
      continue
    }

    if (line.trim() === "") { flushAll(); continue }

    // Horizontal rule
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { flushAll(); out.push("<hr>"); continue }

    // ATX heading (cap at h4 so it fits the narrow sidebar)
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushAll()
      const level = Math.min(4, h[1].length)
      out.push(`<h${level} class="mdh">${inline(h[2].trim())}</h${level}>`)
      continue
    }

    // Blockquote — note the marker is the ESCAPED `&gt;` (escHtml ran first)
    const bq = /^\s*&gt;\s?(.*)$/.exec(line)
    if (bq) { flushPara(); flushList(); quote.push(bq[1]); continue }

    // Unordered list
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      flushPara(); flushQuote()
      if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] } }
      list.items.push(ul[1])
      continue
    }
    // Ordered list
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      flushPara(); flushQuote()
      if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] } }
      list.items.push(ol[1])
      continue
    }

    // Plain text → paragraph buffer
    flushList(); flushQuote()
    para.push(line)
  }
  flushAll()
  return out.join("\n")
}
