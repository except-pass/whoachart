#!/usr/bin/env bun
export const DEFAULT_PORT = 5330

export interface CliArgs {
  cmd: string
  chart?: string
  marble?: string
  context?: Record<string, unknown>
  merge?: Record<string, unknown>
  next?: string
  workpiece?: string
  start?: string
  port: number
}

export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      flags.set(a.slice(2), argv[++i] ?? "")
    } else {
      positional.push(a)
    }
  }
  const cmd = positional[0] ?? "help"
  let port = DEFAULT_PORT
  if (flags.has("port")) {
    port = Number(flags.get("port"))
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`invalid --port: ${flags.get("port")} (expected an integer 0–65535)`)
    }
  }
  const args: CliArgs = { cmd, port }

  if (cmd === "submit" || cmd === "marbles") args.chart = positional[1]
  if (cmd === "signal") { args.chart = positional[1]; args.marble = positional[2] }
  if (flags.has("next")) args.next = flags.get("next")
  if (flags.has("merge")) {
    try {
      args.merge = JSON.parse(flags.get("merge")!)
    } catch (err) {
      throw new Error(`invalid --merge JSON: ${err}`)
    }
  }
  if (flags.has("workpiece")) args.workpiece = flags.get("workpiece")
  if (flags.has("start")) args.start = flags.get("start")
  if (flags.has("context")) {
    try {
      args.context = JSON.parse(flags.get("context")!)
    } catch (err) {
      throw new Error(`invalid --context JSON: ${err}`)
    }
  }
  return args
}

async function main(argv: string[]): Promise<void> {
  const a = parseArgs(argv)
  const base = `http://localhost:${a.port}`
  if (a.cmd === "charts") {
    const res = await fetch(`${base}/api/charts`)
    console.log(JSON.stringify(await res.json(), null, 2))
  } else if (a.cmd === "submit") {
    if (!a.chart) throw new Error("usage: whoachart submit <chart> [--context json] [--workpiece path]")
    const res = await fetch(`${base}/api/charts/${a.chart}/marbles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: a.context, workpiece: a.workpiece, start: a.start }),
    })
    console.log(JSON.stringify(await res.json(), null, 2))
  } else if (a.cmd === "marbles") {
    if (!a.chart) throw new Error("usage: whoachart marbles <chart>")
    const res = await fetch(`${base}/api/charts/${a.chart}/marbles`)
    console.log(JSON.stringify(await res.json(), null, 2))
  } else if (a.cmd === "signal") {
    if (!a.chart || !a.marble) throw new Error("usage: whoachart signal <chart> <marble> --next <edge> [--merge json]")
    const res = await fetch(`${base}/api/charts/${a.chart}/marbles/${a.marble}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next: a.next, merge: a.merge }),
    })
    console.log(JSON.stringify(await res.json(), null, 2))
  } else {
    console.log("usage: whoachart <charts|submit|marbles|signal> [...]  (--port N)")
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((err) => {
    console.error(String(err))
    process.exit(1)
  })
}
