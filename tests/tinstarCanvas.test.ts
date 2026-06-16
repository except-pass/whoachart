// tests/tinstarCanvas.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { TinstarClient } from "../src/tinstar"

let server: ReturnType<typeof Bun.serve>
let base: string
let widgets: any[] = []
let viewportCalls: any[] = []
let runs: any[] = []

beforeEach(() => {
  widgets = []
  viewportCalls = []
  runs = []
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/api/state") {
        return Response.json({ browserWidgets: widgets, runs })
      }
      if (req.method === "POST" && url.pathname === "/api/browser-widgets") {
        const body = (await req.json()) as any
        const w = { id: `browser-${widgets.length + 1}`, ...body }
        widgets.push(w)
        return Response.json({ ok: true, data: w })
      }
      if (req.method === "POST" && url.pathname === "/api/canvas/viewport") {
        viewportCalls.push(await req.json())
        return Response.json({ ok: true })
      }
      return new Response("nope", { status: 404 })
    },
  })
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("ensureBrowserWidget creates when absent, reuses when present", async () => {
  const c = new TinstarClient(base)
  const a = await c.ensureBrowserWidget({ url: "http://x/ui/charts/demo", title: "whoachart-demo" })
  expect(a.widgetId).toBe("browser-1")
  const b = await c.ensureBrowserWidget({ url: "http://x/ui/charts/demo" })
  expect(b.widgetId).toBe("browser-1") // no duplicate
  expect(widgets).toHaveLength(1)
})

test("panToSession focuses when a live run matches the session", async () => {
  runs.push({ sessionId: "wc-demo-m1" })
  const c = new TinstarClient(base)
  expect(await c.panToSession("wc-demo-m1")).toBe("ok")
  expect(viewportCalls[0]).toEqual({ action: "focus", sessionName: "wc-demo-m1" })
})

test("panToSession returns no-run when no live run matches", async () => {
  const c = new TinstarClient(base)
  expect(await c.panToSession("wc-demo-gone")).toBe("no-run")
  expect(viewportCalls).toHaveLength(0)
})

test("panToSession returns unreachable when tinstar is down", async () => {
  const c = new TinstarClient("http://localhost:1")
  expect(await c.panToSession("x")).toBe("unreachable")
})
