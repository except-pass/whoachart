// tests/teardown.test.ts — deterministic space teardown (U6). Drives the real
// TinstarClient against a Bun.serve fake (real HTTP round-trip), so the
// enumerate-and-delete logic and the by-space scoping are exercised end to end.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { TinstarClient } from "../src/tinstar"
import { teardownSpace } from "../src/teardown"

let server: ReturnType<typeof Bun.serve>
let base: string
let spaces: any[] = []
let browserWidgets: any[] = []
let runs: any[] = []
let deletedWidgets: string[] = []
let stoppedSessions: string[] = []
let createdSpaces: string[] = []

beforeEach(() => {
  spaces = []
  browserWidgets = []
  runs = []
  deletedWidgets = []
  stoppedSessions = []
  createdSpaces = []
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/api/spaces") {
        return Response.json({ ok: true, data: spaces })
      }
      if (req.method === "POST" && url.pathname === "/api/spaces") {
        const body = (await req.json()) as any
        createdSpaces.push(body.name)
        const s = { id: `spc-new`, name: body.name }
        spaces.push(s)
        return Response.json({ ok: true, data: s }, { status: 201 })
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return Response.json({ browserWidgets, runs })
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/browser-widgets/")) {
        deletedWidgets.push(decodeURIComponent(url.pathname.slice("/api/browser-widgets/".length)))
        return Response.json({ ok: true })
      }
      if (req.method === "POST" && /^\/api\/sessions\/[^/]+\/stop$/.test(url.pathname)) {
        stoppedSessions.push(decodeURIComponent(url.pathname.split("/")[3]!))
        return Response.json({ ok: true })
      }
      return new Response("nope", { status: 404 })
    },
  })
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("removes only whoachart widgets in the target space, leaving other spaces untouched", async () => {
  spaces.push({ id: "spc-test", name: "_testing" }, { id: "spc-main", name: "main" })
  browserWidgets.push(
    { id: "w1", title: "whoachart-a", spaceId: "spc-test" },
    { id: "w2", title: "whoachart-b", spaceId: "spc-test" },
    { id: "w3", title: "whoachart-c", spaceId: "spc-test" },
    { id: "w4", title: "whoachart-main", spaceId: "spc-main" }, // other space
  )
  const res = await teardownSpace(new TinstarClient(base), "_testing")
  expect(res).toMatchObject({ found: true, spaceId: "spc-test", widgets: 3, sessions: 0 })
  expect(deletedWidgets.sort()).toEqual(["w1", "w2", "w3"])
})

test("leaves non-whoachart widgets in the space alone (title prefix scope)", async () => {
  spaces.push({ id: "spc-test", name: "_testing" })
  browserWidgets.push(
    { id: "w1", title: "whoachart-a", spaceId: "spc-test" },
    { id: "human", title: "my notes", spaceId: "spc-test" }, // not whoachart's
  )
  const res = await teardownSpace(new TinstarClient(base), "_testing")
  expect(res.widgets).toBe(1)
  expect(deletedWidgets).toEqual(["w1"])
})

test("stops sessions (runs) living in the target space", async () => {
  spaces.push({ id: "spc-test", name: "_testing" })
  runs.push(
    { sessionId: "wc-a", spaceId: "spc-test" },
    { sessionId: "wc-b", spaceId: "spc-test" },
    { sessionId: "other", spaceId: "spc-main" },
  )
  const res = await teardownSpace(new TinstarClient(base), "_testing")
  expect(res.sessions).toBe(2)
  expect(stoppedSessions.sort()).toEqual(["wc-a", "wc-b"])
})

test("empty space is a clean no-op (idempotent)", async () => {
  spaces.push({ id: "spc-test", name: "_testing" })
  const res = await teardownSpace(new TinstarClient(base), "_testing")
  expect(res).toMatchObject({ found: true, widgets: 0, sessions: 0 })
  expect(deletedWidgets).toEqual([])
})

test("missing space is a no-op and is NOT created", async () => {
  // spaces is empty → _testing does not exist
  const res = await teardownSpace(new TinstarClient(base), "_testing")
  expect(res).toMatchObject({ found: false, spaceId: null, widgets: 0, sessions: 0 })
  expect(createdSpaces).toEqual([]) // teardown must never create the space
})
