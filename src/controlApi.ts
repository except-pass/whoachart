import type { Daemon } from "./daemon"
import { ChartError } from "./chartStore"
import { FormError } from "./forms"
import { isLoopbackAddr, isTrustedAddr } from "./netGuard"
import { renderPage } from "./ui/page"
import { serveStatic } from "./ui/static"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

// WRITE GATE — the single chokepoint every state-mutating chart route
// (POST/PUT/DELETE /api/charts) passes through. Registering a chart installs
// YAML the daemon will EXECUTE (shell/on_leave/agent), so writes are gated
// STRICTER than reads/triggers: loopback ONLY, never the tailnet. Authoring
// happens on the host, so this costs nothing operationally and removes remote
// code-install from the tailnet surface entirely.
//
// This is LOOPBACK-ABSOLUTE and is NOT overridable by WHOACHART_TRUST_ALL —
// that env var still opens the base read/trigger gate (isTrustedAddr below), but
// it deliberately can NOT re-open chart writes. (Not a bug: code-install stays
// loopback-only even on a fully-trusted network.) SEAM: to allow remote
// authoring later, accept a write-scoped token here, not a network override.
// Returns a Response to reject, else null.
function writeGate(addr: string | undefined): Response | null {
  if (isLoopbackAddr(addr)) return null
  return new Response("forbidden: chart writes are loopback-only", { status: 403, headers: CORS })
}

export interface ControlApiOpts {
  // Test seam: override how the peer address is read (defaults to the socket's
  // requestIP). Lets tests simulate a tailnet peer without a real remote socket.
  resolveAddr?: (req: Request, server: { requestIP: (r: Request) => { address: string } | null }) => string | undefined
}

// Minimal HTTP control plane for the daemon. Routes:
//   GET  /ui/charts/:name                 (shell HTML page)
//   GET  /ui/app.js                       (v0 JSON client)
//   GET    /api/charts
//   POST   /api/charts                    (register a new chart; raw YAML body)
//   PUT    /api/charts/:name              (update + hot-reload; ?on_conflict=fail)
//   DELETE /api/charts/:name              (remove; ?force=true ?purge=true)
//   GET  /api/charts/:name/def            (chart topology + layout)
//   GET  /api/charts/:name/state          (bounded live view aggregate; polled by the canvas page)
//   GET  /api/charts/:name/nodes/:id/logs (live-output delta: ?since=<seq>&marble=<id>)
//   POST /api/charts/:name/marbles        { context?, workpiece?, start? }
//   GET  /api/charts/:name/marbles
//   GET  /api/charts/:name/marbles/:id
//   POST /api/charts/:name/marbles/:id/signal       (resume a blocked marble)
//   POST /api/charts/:name/marbles/:id/retry        (re-run a failed marble)
//   POST /api/charts/:name/marbles/:id/focus-session (pan Tinstar canvas)
// All responses send permissive CORS so the Tinstar-served canvas page can poll.
export function createControlApi(daemon: Daemon, port: number, opts: ControlApiOpts = {}) {
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: CORS })

  // The control plane executes shell scripts and spawns agent sessions, so it
  // only answers loopback + Tailscale peers (see netGuard). WHOACHART_TRUST_ALL=1
  // opts back into the old open behavior on an already-trusted network.
  const trustAll = process.env.WHOACHART_TRUST_ALL === "1"
  const resolveAddr = opts.resolveAddr ?? ((req, server) => server.requestIP(req)?.address)

  return Bun.serve({
    port,
    async fetch(req, server) {
      const addr = resolveAddr(req, server)
      if (!trustAll && !isTrustedAddr(addr)) {
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

        // POST /api/charts — register a new chart from a raw YAML request body.
        if (req.method === "POST" && url.pathname === "/api/charts") {
          const blocked = writeGate(addr)
          if (blocked) return blocked
          return json(await daemon.registerChart(await req.text()), 201)
        }

        // POST /api/charts/reload — rescan the store dir and bring live any
        // newly-dropped chart files, no daemon restart. Mutation → loopback-only.
        if (req.method === "POST" && url.pathname === "/api/charts/reload") {
          const blocked = writeGate(addr)
          if (blocked) return blocked
          return json(await daemon.loadNewCharts())
        }

        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "def" && req.method === "GET") {
          return json(daemon.def(p[2]))
        }

        // PUT/DELETE /api/charts/:name — update (hot-reload) or remove a chart.
        if (p[0] === "api" && p[1] === "charts" && p[2] && !p[3]) {
          if (req.method === "PUT") {
            const blocked = writeGate(addr)
            if (blocked) return blocked
            const forceFail = url.searchParams.get("on_conflict") === "fail"
            return json(await daemon.updateChart(p[2], await req.text(), { forceFail }))
          }
          if (req.method === "DELETE") {
            const blocked = writeGate(addr)
            if (blocked) return blocked
            const force = url.searchParams.get("force") === "true"
            const purge = url.searchParams.get("purge") === "true"
            return json(await daemon.deleteChart(p[2], { force, purge }))
          }
        }

        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "state" && req.method === "GET") {
          return json(daemon.snapshot(p[2]))
        }

        // Live-output delta for one node (inspector live feed). since defaults to
        // 0 (NaN-safe) and is clamped non-negative — a negative ?since is truthy
        // and would otherwise match every ring entry ("replay everything").
        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "nodes" && p[4] && p[5] === "logs" && req.method === "GET") {
          const since = Math.max(0, Number(url.searchParams.get("since")) || 0)
          const marble = url.searchParams.get("marble") ?? undefined
          return json(daemon.logsSince(p[2], decodeURIComponent(p[4]), since, marble))
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
            if (result === "session-gone") return json({ error: "session is no longer open on the canvas" }, 409)
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
        // ChartError carries its own HTTP status + optional detail (e.g. the
        // marbles blocking a hot-reload). Everything else (parse/schema) → 400.
        if (err instanceof ChartError) return json({ error: err.message, ...(err.detail ?? {}) }, err.status)
        return json({ error: String(err) }, 400)
      }
    },
  })
}
