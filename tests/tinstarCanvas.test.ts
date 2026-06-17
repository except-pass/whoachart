// tests/tinstarCanvas.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test"
import { TinstarClient } from "../src/tinstar"

let server: ReturnType<typeof Bun.serve>
let base: string
let widgets: any[] = []
let viewportCalls: any[] = []
let runs: any[] = []
let stateStatus = 200
let spaces: any[] = []
let spacesStatus = 200
let widgetBodies: any[] = []
let deletedWidgets: string[] = []
let spaceSeq = 1

beforeEach(() => {
  widgets = []
  viewportCalls = []
  runs = []
  stateStatus = 200
  spaces = []
  spacesStatus = 200
  widgetBodies = []
  deletedWidgets = []
  spaceSeq = 1
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/api/state") {
        return Response.json({ browserWidgets: widgets, runs }, { status: stateStatus })
      }
      if (req.method === "POST" && url.pathname === "/api/browser-widgets") {
        const body = (await req.json()) as any
        widgetBodies.push(body)
        const w = { id: `browser-${widgets.length + 1}`, ...body }
        widgets.push(w)
        return Response.json({ ok: true, data: w })
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/browser-widgets/")) {
        deletedWidgets.push(decodeURIComponent(url.pathname.slice("/api/browser-widgets/".length)))
        return Response.json({ ok: true })
      }
      if (req.method === "GET" && url.pathname === "/api/spaces") {
        return Response.json({ ok: true, data: spaces }, { status: spacesStatus })
      }
      if (req.method === "POST" && url.pathname === "/api/spaces") {
        const body = (await req.json()) as any
        const s = { id: `spc-${spaceSeq++}`, name: body.name }
        spaces.push(s)
        return Response.json({ ok: true, data: s }, { status: 201 })
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

test("ensureBrowserWidget forwards spaceId when provided", async () => {
  const c = new TinstarClient(base)
  await c.ensureBrowserWidget({ url: "http://x/ui/charts/demo", title: "whoachart-demo", spaceId: "spc-7" })
  expect(widgetBodies[0].spaceId).toBe("spc-7")
})

test("ensureBrowserWidget omits spaceId when not provided", async () => {
  const c = new TinstarClient(base)
  await c.ensureBrowserWidget({ url: "http://x/ui/charts/demo", title: "whoachart-demo" })
  expect("spaceId" in widgetBodies[0]).toBe(false)
})

test("ensureSpace returns the existing space id when the name is present", async () => {
  spaces.push({ id: "spc-existing", name: "_testing" })
  const c = new TinstarClient(base)
  expect(await c.ensureSpace("_testing")).toBe("spc-existing")
  // did not create a duplicate
  expect(spaces).toHaveLength(1)
})

test("ensureSpace creates the space when absent and returns the new id", async () => {
  const c = new TinstarClient(base)
  const id = await c.ensureSpace("_testing")
  expect(id).toBe("spc-1")
  expect(spaces.find((s) => s.name === "_testing")).toBeTruthy()
})

test("ensureSpace with create=false does not create and returns null when absent", async () => {
  const c = new TinstarClient(base)
  expect(await c.ensureSpace("_testing", false)).toBeNull()
  expect(spaces).toHaveLength(0)
})

test("ensureSpace returns null when tinstar is unreachable", async () => {
  const c = new TinstarClient("http://localhost:1")
  expect(await c.ensureSpace("_testing")).toBeNull()
})

test("ensureSpace returns null when /api/spaces returns non-2xx", async () => {
  spacesStatus = 500
  const c = new TinstarClient(base)
  expect(await c.ensureSpace("_testing")).toBeNull()
  // a 500 on GET must not trigger a create attempt
  expect(spaces).toHaveLength(0)
})

test("deleteBrowserWidget issues DELETE and returns true on success", async () => {
  const c = new TinstarClient(base)
  expect(await c.deleteBrowserWidget("browser-9")).toBe(true)
  expect(deletedWidgets).toEqual(["browser-9"])
})

test("deleteBrowserWidget returns false when tinstar is unreachable", async () => {
  const c = new TinstarClient("http://localhost:1")
  expect(await c.deleteBrowserWidget("browser-9")).toBe(false)
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

test("panToSession returns unreachable when /api/state returns non-2xx", async () => {
  stateStatus = 500
  const c = new TinstarClient(base)
  expect(await c.panToSession("x")).toBe("unreachable")
  expect(viewportCalls).toHaveLength(0)
})
