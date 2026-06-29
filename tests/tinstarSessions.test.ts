import { test, expect, beforeEach, afterEach } from "bun:test"
import { TinstarClient, SpawnSessionError } from "../src/tinstar"

let server: ReturnType<typeof Bun.serve>
let base: string
let calls: { method: string; path: string; body: any }[] = []

beforeEach(() => {
  calls = []
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => null) : null
      calls.push({ method: req.method, path: url.pathname, body })
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        if ((body as any)?.name === "wc-taken") {
          return Response.json({ ok: false, error: { code: "CONFLICT", message: "exists" } }, { status: 409 })
        }
        return Response.json({ ok: true, data: { name: (body as any).name } })
      }
      if (req.method === "POST" && /^\/api\/sessions\/[^/]+\/stop$/.test(url.pathname)) {
        return Response.json({ ok: true })
      }
      if (req.method === "DELETE" && /^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
        return Response.json({ ok: true })
      }
      return new Response("nope", { status: 404 })
    },
  })
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("spawnSession POSTs name + prompt in the CREATION body (no separate prompt call)", async () => {
  const c = new TinstarClient(base)
  const ref = await c.spawnSession({ name: "wc-demo-m1", prompt: "do the thing", color: "#a78bfa" })
  expect(ref.name).toBe("wc-demo-m1")
  const post = calls.find((c) => c.path === "/api/sessions")!
  expect(post.body.name).toBe("wc-demo-m1")
  expect(post.body.prompt).toBe("do the thing")
  expect(post.body.color).toBe("#a78bfa")
  // exactly one call — kickoff prompt must ride the creation request
  expect(calls).toHaveLength(1)
})

test("spawnSession sanitizes dots out of the session name", async () => {
  const c = new TinstarClient(base)
  const ref = await c.spawnSession({ name: "wc.demo.M1", prompt: "x" })
  expect(ref.name).toBe("wc-demo-m1")
})

test("stopSession hits the stop endpoint and survives errors", async () => {
  const c = new TinstarClient(base)
  await c.stopSession("wc-demo-m1")
  expect(calls.some((c) => c.path === "/api/sessions/wc-demo-m1/stop")).toBe(true)
  await c.stopSession("missing/${weird}") // must not throw even if server 404s
})

test("spawnSession throws a typed SpawnSessionError carrying the HTTP status on conflict", async () => {
  const c = new TinstarClient(base)
  const err = await c.spawnSession({ name: "wc-taken", prompt: "x" }).then(
    () => null,
    (e) => e,
  )
  expect(err).toBeInstanceOf(SpawnSessionError)
  expect((err as SpawnSessionError).status).toBe(409)
})

test("deleteSession hits the DELETE endpoint and survives errors", async () => {
  const c = new TinstarClient(base)
  await c.deleteSession("wc-demo-m1")
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/sessions/wc-demo-m1")).toBe(true)
  await c.deleteSession("missing/${weird}") // must not throw even if server 404s
})
