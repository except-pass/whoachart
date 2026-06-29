import type { Chart } from "./types"

// The kickoff prompt for a chart's supervisor session. It points the agent at
// the control API and names the gates it MAY resolve (decider:"agent"), with an
// explicit prohibition on human gates.
export function buildSupervisorBrief(chart: Chart, apiBase: string): string {
  const agentGates = chart.nodes.filter((n) => n.decider === "agent").map((n) => n.id)
  return [
    `You are the SUPERVISOR for the whoachart chart "${chart.name}". You oversee its runs end-to-end.`,
    chart.supervisor?.brief ?? "",
    ``,
    `Watch the run:`,
    `  GET ${apiBase}/api/charts/${chart.name}/state`,
    `  GET ${apiBase}/api/charts/${chart.name}/marbles`,
    `Inspect topology and which gates are yours (each node's "decider"):`,
    `  GET ${apiBase}/api/charts/${chart.name}/def`,
    ``,
    `You MAY resolve ONLY gates whose node has decider:"agent"${agentGates.length ? ` (currently: ${agentGates.join(", ")})` : ""}.`,
    `For such a blocked marble, choose an outgoing edge and signal:`,
    `  curl -X POST ${apiBase}/api/charts/${chart.name}/marbles/<id>/signal -H 'Content-Type: application/json' -d '{"next":"<edge>","merge":{}}'`,
    `NEVER signal a gate whose decider is "human" or unset — leave those for a person.`,
    `Surface stuck or failed marbles. Do not author or edit the chart.`,
  ].filter(Boolean).join("\n")
}
