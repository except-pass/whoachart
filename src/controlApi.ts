import type { Daemon } from "./daemon"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

// Minimal HTTP control plane for the daemon. Routes:
//   GET  /api/charts
//   POST /api/charts/:name/marbles        { context?, workpiece?, start? }
//   GET  /api/charts/:name/marbles
//   GET  /api/charts/:name/marbles/:id
//   POST /api/charts/:name/marbles/:id/signal   (resume a blocked marble)
//   GET  /api/charts/:name/state          (bounded live view aggregate; polled by the canvas page)
// All responses send permissive CORS so the Tinstar-served canvas page can poll.
export function createControlApi(daemon: Daemon, port: number) {
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: CORS })

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const p = url.pathname.split("/").filter(Boolean)

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })

      try {
        if (req.method === "GET" && url.pathname === "/api/charts") {
          return json({ charts: daemon.charts() })
        }

        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "state" && req.method === "GET") {
          return json(daemon.snapshot(p[2]))
        }

        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "marbles") {
          const name = p[2]
          // POST single-marble signal
          if (req.method === "POST" && p[4] && p[5] === "signal") {
            const body = (await req.json().catch(() => ({}))) as any
            await daemon.signal(name, p[4], { next: body.next, merge: body.merge })
            return json({ ok: true })
          }
          if (req.method === "GET" && p[4]) {
            const m = await daemon.marble(name, p[4])
            return m ? json(m) : json({ error: "marble not found" }, 404)
          }
          if (req.method === "GET") {
            return json({ marbles: await daemon.marbles(name) })
          }
          if (req.method === "POST") {
            const body = (await req.json().catch(() => ({}))) as any
            const m = await daemon.submit(name, {
              context: body.context,
              workpiece: body.workpiece,
              start: body.start,
            })
            return json({ id: m.id, status: m.status }, 201)
          }
        }

        return json({ error: "not found" }, 404)
      } catch (err) {
        return json({ error: String(err) }, 400)
      }
    },
  })
}
