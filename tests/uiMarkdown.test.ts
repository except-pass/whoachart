import { test, expect } from "bun:test"
import { renderMarkdown } from "../src/ui/public/markdown.js"

test("escapes HTML before any markdown rule runs (no raw-tag injection)", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> **bold**')
  expect(html).not.toContain("<img")
  expect(html).toContain("&lt;img")
  expect(html).toContain("<strong>bold</strong>")
})

test("renders headings capped at h4", () => {
  expect(renderMarkdown("# Title")).toContain('<h1 class="mdh">Title</h1>')
  expect(renderMarkdown("###### deep")).toContain('<h4 class="mdh">deep</h4>')
})

test("bold, italic, and inline code", () => {
  expect(renderMarkdown("**b** and *i* and `c`")).toBe(
    '<p><strong>b</strong> and <em>i</em> and <code>c</code></p>',
  )
})

test("fenced code blocks render verbatim (no inline rules inside)", () => {
  const html = renderMarkdown("```\n**not bold** <x>\n```")
  expect(html).toContain('<pre class="mdcode">**not bold** &lt;x&gt;</pre>')
  expect(html).not.toContain("<strong>")
})

test("unordered and ordered lists", () => {
  expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>")
  expect(renderMarkdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>")
})

test("only http(s) links become anchors; label keeps its text", () => {
  const ok = renderMarkdown("[site](https://example.com)")
  expect(ok).toContain('<a href="https://example.com" target="_blank" rel="noopener">site</a>')
  const bad = renderMarkdown("[x](javascript:alert(1))")
  expect(bad).not.toContain("<a ")
  expect(bad).toContain("[x](javascript:alert(1))")
})

test("paragraphs split on blank lines, soft-wrap with <br>", () => {
  expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one<br>two</p>\n<p>three</p>")
})

test("horizontal rule and blockquote", () => {
  expect(renderMarkdown("---")).toBe("<hr>")
  expect(renderMarkdown("> quoted")).toBe("<blockquote>quoted</blockquote>")
})

test("empty / nullish input yields empty string", () => {
  expect(renderMarkdown("")).toBe("")
  expect(renderMarkdown(null)).toBe("")
  expect(renderMarkdown(undefined)).toBe("")
})
