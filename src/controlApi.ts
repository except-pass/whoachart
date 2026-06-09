import type { Daemon } from "./daemon"

export function createControlApi(daemon: Daemon, port: number) {
  const json = (data: unknown, status = 200) => Response.json(data, { status })

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const p = url.pathname.split("/").filter(Boolean)

      try {
        if (req.method === "GET" && url.pathname === "/api/charts") {
          return json({ charts: daemon.charts() })
        }

        if (p[0] === "api" && p[1] === "charts" && p[2] && p[3] === "marbles") {
          const name = p[2]
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
