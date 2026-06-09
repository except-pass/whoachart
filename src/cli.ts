export const DEFAULT_PORT = 5330

export interface CliArgs {
  cmd: string
  chart?: string
  context?: Record<string, unknown>
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
  const args: CliArgs = { cmd, port: flags.has("port") ? Number(flags.get("port")) : DEFAULT_PORT }

  if (cmd === "submit" || cmd === "marbles") args.chart = positional[1]
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
  } else {
    console.log("usage: whoachart <charts|submit|marbles> [...]  (--port N)")
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((err) => {
    console.error(String(err))
    process.exit(1)
  })
}
