import { readdir } from "node:fs/promises"
import { join, isAbsolute } from "node:path"
import { Daemon } from "./daemon"
import { createControlApi } from "./controlApi"
import { TinstarClient } from "./tinstar"
import { DEFAULT_PORT } from "./cli"

async function resolveCharts(spec: string): Promise<string[]> {
  const entries = spec.split(",").map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const e of entries) {
    if (e.endsWith(".yaml") || e.endsWith(".yml")) {
      out.push(isAbsolute(e) ? e : join(process.cwd(), e))
    } else {
      const dir = isAbsolute(e) ? e : join(process.cwd(), e)
      for (const f of await readdir(dir)) {
        if (f.endsWith(".yaml") || f.endsWith(".yml")) out.push(join(dir, f))
      }
    }
  }
  return out
}

async function main(): Promise<void> {
  const chartsSpec = process.env.WHOACHART_CHARTS ?? "examples"
  const storeDir = process.env.WHOACHART_STORE ?? join(process.cwd(), ".whoachart")
  const port = process.env.WHOACHART_PORT ? Number(process.env.WHOACHART_PORT) : DEFAULT_PORT
  const tinstarUrl = process.env.TINSTAR_URL ?? "http://localhost:5273"
  // The URL browsers use to reach this daemon. On a tailnet box set e.g.
  // WHOACHART_PUBLIC_URL=http://infrapoc.taile890bc.ts.net:5331 — Bun.serve
  // binds 0.0.0.0 by default, so no port forwarding is needed.
  const publicUrl = process.env.WHOACHART_PUBLIC_URL ?? `http://localhost:${port}`

  const charts = await resolveCharts(chartsSpec)
  const client = new TinstarClient(tinstarUrl)
  const daemon = new Daemon({
    charts,
    storeDir,
    client,
    launcher: client,
    baseUrl: `http://localhost:${port}`,
    publicUrl,
  })
  await daemon.start()
  createControlApi(daemon, port)
  console.log(`[whoachart] daemon up on :${port} — charts: ${daemon.charts().join(", ") || "(none)"}`)
  for (const name of daemon.charts()) console.log(`[whoachart]   ui: ${publicUrl}/ui/charts/${name}`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[whoachart] failed to start: ${err}`)
    process.exit(1)
  })
}
