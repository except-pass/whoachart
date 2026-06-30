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

// The writable chart store is a single directory. Use WHOACHART_CHARTS_DIR when
// set; otherwise, if WHOACHART_CHARTS is a lone directory entry (the common
// case), that directory IS the store. A multi-entry / explicit-file spec has no
// single owning dir, so CRUD is disabled unless WHOACHART_CHARTS_DIR is given.
function resolveChartsDir(spec: string): string | undefined {
  if (process.env.WHOACHART_CHARTS_DIR) {
    const d = process.env.WHOACHART_CHARTS_DIR
    return isAbsolute(d) ? d : join(process.cwd(), d)
  }
  const entries = spec.split(",").map((s) => s.trim()).filter(Boolean)
  if (entries.length !== 1) return undefined
  const e = entries[0]
  if (e.endsWith(".yaml") || e.endsWith(".yml")) return undefined
  return isAbsolute(e) ? e : join(process.cwd(), e)
}

async function main(): Promise<void> {
  const chartsSpec = process.env.WHOACHART_CHARTS ?? "examples"
  const chartsDir = resolveChartsDir(chartsSpec)
  // Collections live in their own dir (a manifest in the chart dir would be
  // parsed as a chart at boot). Opt-in: unset → collections disabled (501).
  const collectionsDir = process.env.WHOACHART_COLLECTIONS_DIR
    ? (isAbsolute(process.env.WHOACHART_COLLECTIONS_DIR)
        ? process.env.WHOACHART_COLLECTIONS_DIR
        : join(process.cwd(), process.env.WHOACHART_COLLECTIONS_DIR))
    : undefined
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
    chartsDir,
    collectionsDir,
    storeDir,
    client,
    launcher: client,
    baseUrl: `http://localhost:${port}`,
    publicUrl,
    // When set (e.g. WHOACHART_SPACE=_testing), confine all browser widgets to
    // that Tinstar space and tear them down on shutdown — keeps dev/test noise
    // off the primary workspace.
    space: process.env.WHOACHART_SPACE || undefined,
    // Supervisor sessions land in this Tinstar space (distinct from `space`,
    // which is widgets only). Unset → Tinstar's active space.
    agentSpace: process.env.WHOACHART_AGENT_SPACE || undefined,
  })
  await daemon.start()
  createControlApi(daemon, port)
  // Opt-in: auto-pick-up of chart files dropped into the store dir (no restart).
  // Needs a writable store dir; the manual POST /api/charts/reload always works.
  if (process.env.WHOACHART_WATCH === "1") {
    if (chartsDir) daemon.watchCharts()
    else console.log("[whoachart] WHOACHART_WATCH=1 ignored — no chart store dir (set WHOACHART_CHARTS_DIR)")
  }
  console.log(`[whoachart] daemon up on :${port} — charts: ${daemon.charts().join(", ") || "(none)"}`)
  for (const e of daemon.bootErrors) {
    console.error(`[whoachart] skipped invalid chart "${e.name}": ${e.error}`)
  }
  for (const name of daemon.charts()) console.log(`[whoachart]   ui: ${publicUrl}/ui/charts/${name}`)
  for (const name of daemon.collections()) console.log(`[whoachart]   collection: ${publicUrl}/ui/collections/${name}`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[whoachart] failed to start: ${err}`)
    process.exit(1)
  })
}
