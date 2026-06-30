import type { Chart, ChartEdge } from "./types"

// Severity of a lint finding. Both are ADVISORY — lint never blocks a register/
// update (that is `parseChart`'s job). `warn` = a likely authoring bug a marble
// would hit at runtime; `info` = a harmless oddity (e.g. an edge that can never
// fire). 3c may add a blocking `error` tier via `LintResult.errors`.
export type LintLevel = "warn" | "info"

// One static-analysis finding. `node` / `edge` pin it to a spot in the chart so
// the UI can offer click-through to the offender; `code` is a stable machine id
// for grouping/filtering.
export interface LintWarning {
  level: LintLevel
  code: string
  message: string
  node?: string
  edge?: { from: string; to: string }
}

// Result of static-analysing a chart at registration time. `errors` is reserved
// for a future blocking tier (3c) — lint is advisory today, so it stays empty
// and every finding lands in `warnings`, carrying its own `level`.
export interface LintResult {
  errors: LintWarning[]
  warnings: LintWarning[]
}

// Static analysis of a parsed chart — advisory only, never throws. Runs AFTER
// `parseChart`, so structural impossibilities (duplicate ids, edges to unknown
// nodes, unknown node types, bad config) have already hard-failed. The dup-id /
// dangling-edge checks below are therefore dead in the daemon path; they stay as
// defense-in-depth for any standalone caller (a CLI `lint`, a UI preview) that
// hands us a chart that did NOT come through `parseChart`.
export function lintChart(chart: Chart): LintResult {
  const warnings: LintWarning[] = []
  const push = (w: LintWarning) => warnings.push(w)

  const idSeen = new Set<string>()
  for (const n of chart.nodes) {
    // duplicate ids (parseChart hard-fails first; defensive for standalone callers)
    if (idSeen.has(n.id)) {
      push({ level: "warn", code: "duplicate-id", node: n.id, message: `duplicate node id "${n.id}"` })
    }
    idSeen.add(n.id)
  }
  const ids = idSeen

  // Adjacency (by valid endpoints only) + which nodes are routed INTO. Dangling
  // endpoints are reported separately and skipped here so they can't poison the
  // reachability walk.
  const out = new Map<string, string[]>()
  for (const n of chart.nodes) out.set(n.id, [])
  const hasIncoming = new Set<string>()
  for (const e of chart.edges) {
    const fromOk = ids.has(e.from)
    const toOk = ids.has(e.to)
    if (!fromOk) push(danglingEdge(e, "from", e.from))
    if (!toOk) push(danglingEdge(e, "to", e.to))
    if (fromOk && toOk) {
      out.get(e.from)!.push(e.to)
      hasIncoming.add(e.to)
    }
  }

  // Reachability: entry points are every `source` node plus any node with no
  // incoming edge (only reachable via a direct submit/`start`). A node the walk
  // never touches can't be entered from any entry point — flag it. A chart whose
  // nodes form one closed cycle with no source has zero entry points, so every
  // node is (correctly) flagged unreachable.
  const roots = chart.nodes.filter((n) => n.type === "source" || !hasIncoming.has(n.id)).map((n) => n.id)
  const reached = new Set<string>(roots)
  const queue = [...roots]
  while (queue.length) {
    const cur = queue.shift()!
    for (const next of out.get(cur) ?? []) {
      if (!reached.has(next)) {
        reached.add(next)
        queue.push(next)
      }
    }
  }
  for (const n of chart.nodes) {
    if (!reached.has(n.id)) {
      push({ level: "warn", code: "unreachable-node", node: n.id, message: `node "${n.id}" is unreachable — no path leads to it from any source or entry node` })
    }
  }

  // Per-node structural oddities.
  for (const n of chart.nodes) {
    const outgoing = out.get(n.id)!.length
    // Dead ends: a non-`end` node with nowhere to go strands the marble. A
    // decision is the sharpest case (its whole job is to route) so it gets a
    // pointed message; everything else (source/shell/api/agent/human) is the
    // same hazard with a softer one. `end` nodes are terminal by design — skip.
    //
    // ASSUMPTION: marbles only terminate via the `end` node type. True for all
    // builtins (only endNode returns `end:true`). A future CUSTOM node type that
    // self-terminates by returning `{end:true}` from its run() would be FLAGGED
    // here spuriously — it legitimately has no outgoing edge. If such a type is
    // added, exempt it (e.g. a `terminal` flag on the NodeType registration that
    // this check consults) rather than letting the false-positive stand.
    if (outgoing === 0 && n.type !== "end") {
      if (n.type === "decision") {
        push({ level: "warn", code: "decision-no-outgoing", node: n.id, message: `decision node "${n.id}" has no outgoing edges — it cannot route a marble anywhere` })
      } else {
        push({ level: "warn", code: "dead-end", node: n.id, message: `node "${n.id}" (type "${n.type}") has no outgoing edges and is not an "end" node — marbles reaching it have nowhere to go` })
      }
    }
    // A source with an incoming edge is being routed into; sources are entry
    // points, so the inbound edge is almost certainly a wiring mistake.
    if (n.type === "source" && hasIncoming.has(n.id)) {
      push({ level: "warn", code: "source-with-incoming", node: n.id, message: `source node "${n.id}" has an incoming edge — sources are entry points and shouldn't be routed into` })
    }
    // An end with an outgoing edge: harmless (the engine stops at an end) but the
    // edge can never be traversed, so surface it as info, not a bug.
    if (n.type === "end" && outgoing > 0) {
      push({ level: "info", code: "end-with-outgoing", node: n.id, message: `end node "${n.id}" has an outgoing edge — end nodes are terminal, so the edge will never be traversed` })
    }
  }

  // Hook matchers: a `node:`/`edge:` that names nothing in the chart is almost
  // certainly a typo — the hook would silently never fire. Advisory only (a typo
  // must not reject the chart or break hot-reload; that is why this is a lint
  // warning rather than a parseChart error).
  const edgeNames = new Set(chart.edges.map((e) => e.name).filter((x): x is string => x !== undefined))
  for (const h of chart.hooks ?? []) {
    if (h.node !== undefined && !ids.has(h.node)) {
      push({ level: "warn", code: "hook-unknown-node", node: h.node, message: `hook on:${h.on} targets unknown node "${h.node}" — it will never fire` })
    }
    if (h.edge !== undefined && !edgeNames.has(h.edge)) {
      push({ level: "warn", code: "hook-unknown-edge", message: `hook on:${h.on} targets unknown edge "${h.edge}" — it will never fire` })
    }
  }

  return { errors: [], warnings }
}

function danglingEdge(e: ChartEdge, end: "from" | "to", missing: string): LintWarning {
  return {
    level: "warn",
    code: "dangling-edge",
    edge: { from: e.from, to: e.to },
    message: `edge ${end === "from" ? `from "${e.from}"` : `to "${e.to}"`} references unknown node "${missing}"`,
  }
}
