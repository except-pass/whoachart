import { test, expect, beforeEach, afterEach } from "bun:test"
import { readFile } from "node:fs/promises"
import { TinstarClient } from "../src/tinstar"

let server: ReturnType<typeof Bun.serve>
let base: string
let lastBody: any = null

beforeEach(() => {
  lastBody = null
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname === "/api/artifacts") {
        lastBody = await req.json()
        return Response.json({ ok: true, data: { artifactId: "eph-1", widgetId: "browser-1" } })
      }
      if (req.method === "PUT" && url.pathname === "/api/artifacts/eph-1") {
        lastBody = await req.json()
        return Response.json({ ok: true, data: { artifactId: "eph-1", rev: 2 } })
      }
      if (req.method === "PUT" && url.pathname === "/api/artifacts/gone") {
        return Response.json({ ok: false, error: { code: "NOT_FOUND" } }, { status: 404 })
      }
      if (req.method === "DELETE") return Response.json({ ok: true })
      return new Response("nope", { status: 404 })
    },
  })
  base = `http://localhost:${server.port}`
})
afterEach(() => server.stop(true))

test("postArtifact writes html to a file and returns ids", async () => {
  const c = new TinstarClient(base)
  const ref = await c.postArtifact("<h1>hello</h1>", { name: "x" })
  expect(ref.artifactId).toBe("eph-1")
  expect(ref.widgetId).toBe("browser-1")
  expect(lastBody.name).toBe("x")
  expect(await readFile(lastBody.path, "utf8")).toContain("hello")
})

test("putArtifact returns true on success", async () => {
  const c = new TinstarClient(base)
  expect(await c.putArtifact("eph-1", "<p>upd</p>")).toBe(true)
})

test("putArtifact returns false on 404 (artifact gone)", async () => {
  const c = new TinstarClient(base)
  expect(await c.putArtifact("gone", "<p>x</p>")).toBe(false)
})
