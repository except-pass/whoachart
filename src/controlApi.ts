import type { Daemon } from "./daemon"
import { FormError } from "./forms"
import { isTrustedAddr } from "./netGuard"
import { renderPage } from "./ui/page"
import { serveStatic } from "./ui/static"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

// Minimal HTTP control plane for the daemon. Routes:
//   GET  /ui/charts/:name                 (shell HTML page)
//   GET  /ui/app.js                       (v0 JSON client)
//   GET  /api/charts
//   GET  /api/charts/:name/def            (chart topology + layout)
//   GET  /api/charts/:name/state          (bounded live view aggregate; polled by the canvas page)
//   POST /api/charts/:name/marbles        { context?, workpiece?, start? }
//   GET  /api/charts/:name/marbles
//   GET  /api/charts/:name/marbles/:id
//   POST /api/charts/:name/marbles/:id/signal       (resume a blocked marble)
//   POST /api/charts/:name/marbles/:id/retry        (re-run a failed marble)
//   POST /api/charts/:name/marbles/:id/focus-session (pan Tinstar canvas)
// All responses send permissive CORS so the Tinstar-served canvas page can poll.
export function createControlApi(daemon: Daemon, port: number) {
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: CORS })

  // The control plane executes shell scripts and spawns agent sessions, so it
  // only answers loopback + Tailscale peers (see netGuard). WHOACHART_TRUST_ALL=1
  // opts back into the old open behavior on an already-trusted network.
  const trustAll = process.env.WHOACHART_TRUST_ALL === "1"

  return Bun.serve({
    port,
    async fetch(req, server) {
      if (!trustAll && !isTrustedAddr(server.requestIP(req)?.address)) {
        return new Response("forbidden", { status: 403, headers: CORS })
      }

      const url = new URL(req.url)
      const p = url.pathname.split("/").filter(Boolean)

      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })

      // UI shell + static client
      if (req.method === "GET" && p[0] === "ui" && p[1] === "charts" && p[2] && !p[3]) {
        // Canonicalize to the slashless form so the relative ../app.js src resolves
        // to /ui/app.js. A trailing slash would resolve it to /ui/charts/app.js (404).
        if (url.pathname.endsWith("/")) {
          const target = new URL(url.pathname.slice(0, -1) + url.search, url)
          return Response.redirect(target.href, 301)
        }
        if (!daemon.charts().includes(p[2])) return new Response("unknown chart", { status: 404 })
        return new Response(renderPage(p[2]), { headers: { "Content-Type": "text/html; charset=utf-8" } })
      }
      if (req.method === "GET" && p[0] === "ui" && p[1] && !p[2]) {
        const file = await serveStatic(p[1])
        return file ?? json({ error: "not found" }, 404)
      }

      try {
        if (req.method === "GET" && url.pathname === "/api/charts") {
          return json({ charts: daemon.charts() })
        }

        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "def" && req.method === "GET") {
          return json(daemon.def(p[2]))
        }

        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "state" && req.method === "GET") {
          return json(daemon.snapshot(p[2]))
        }

        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "marbles") {
          const name = p[2]
          // POST single-marble retry
          if (req.method === "POST" && p[4] && p[5] === "retry") {
            await daemon.retry(name, p[4])
            return json({ ok: true })
          }
          // POST focus the Tinstar canvas on the marble's agent session
          if (req.method === "POST" && p[4] && p[5] === "focus-session") {
            const result = await daemon.focusSession(name, p[4])
            if (result === "ok") return json({ ok: true })
            if (result === "no-session") return json({ error: "marble has no linked session" }, 404)
            return json({ error: "tinstar unreachable" }, 502)
          }
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
        if (err instanceof FormError) return json({ error: "validation", fields: err.fields }, 400)
        return json({ error: String(err) }, 400)
      }
    },
  })
}
