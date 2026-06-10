import type { Chart, ChartEdge, ChartNode, FormField, Marble, PresentSpec } from "../types"

const RECENT_N = 8
const DWELL_SAMPLES = 64
const DEAD_LETTER_MAX = 20

export interface GateInfo {
  agent: boolean
  edges: { name: string; form?: FormField[] }[]
  present?: PresentSpec[]
}

export interface LiveMarble {
  id: string
  node: string
  status: string
  enteredAt: string
  gate?: GateInfo
}

export interface EndTally {
  total: number
  recent: { id: string; status: string }[]
}

export interface NodeStats {
  runs: number
  fails: number
  dwellP50: number | null
  dwellP95: number | null
}

export interface DeadLetter {
  id: string
  node: string
  error: string
  failedAt: string
}

export interface ViewSnapshot {
  live: LiveMarble[]
  ends: Record<string, EndTally>
  stats: Record<string, NodeStats>
  deadLetter: DeadLetter[]
}

function pct(samples: number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

// In-memory aggregate of a chart's marbles for the live view. Updated O(1) per
// engine onChange — never rescans the store. Bounded by design: in-flight
// marbles individually, last-N completed dots + counters per end node, last-20
// dead letters, 64 dwell samples per node. In-memory only (resets on restart).
export class ViewState {
  private live = new Map<string, LiveMarble>()
  private ends = new Map<string, EndTally>()
  private nodeStats = new Map<string, { runs: number; fails: number; samples: number[] }>()
  private dead = new Map<string, DeadLetter>()
  private seenHops = new Map<string, number>() // marble id -> closed hops already counted

  constructor(private chart: Chart, private recentN = RECENT_N) {}

  private nodeById(id: string): ChartNode | undefined {
    return this.chart.nodes.find((n) => n.id === id)
  }

  private outgoing(id: string): ChartEdge[] {
    return this.chart.edges.filter((e) => e.from === id)
  }

  private stat(node: string) {
    let s = this.nodeStats.get(node)
    if (!s) {
      s = { runs: 0, fails: 0, samples: [] }
      this.nodeStats.set(node, s)
    }
    return s
  }

  // Count each CLOSED trail hop exactly once into dwell stats.
  private recordDwells(m: Marble): void {
    const trail = m.trail ?? []
    const counted = this.seenHops.get(m.id) ?? 0
    let closed = 0
    for (const hop of trail) {
      if (!hop.leftAt) continue
      closed++
      if (closed <= counted) continue
      const s = this.stat(hop.node)
      s.runs++
      s.samples.push(new Date(hop.leftAt).getTime() - new Date(hop.enteredAt).getTime())
      if (s.samples.length > DWELL_SAMPLES) s.samples.shift()
    }
    this.seenHops.set(m.id, closed)
  }

  apply(m: Marble): void {
    this.recordDwells(m)
    if (m.status === "done" || m.status === "failed") {
      this.live.delete(m.id)
      this.seenHops.delete(m.id)
      if (m.status === "failed" && m.error) {
        // an ERRORED marble is a dead letter, not a normal rejection
        this.dead.set(m.id, { id: m.id, node: m.node, error: m.error.split("\n")[0], failedAt: m.updatedAt })
        while (this.dead.size > DEAD_LETTER_MAX) {
          this.dead.delete(this.dead.keys().next().value as string)
        }
        this.stat(m.node).fails++
        return
      }
      const tally = this.ends.get(m.node) ?? { total: 0, recent: [] }
      tally.total += 1
      tally.recent.push({ id: m.id, status: m.status })
      if (tally.recent.length > this.recentN) tally.recent.shift()
      this.ends.set(m.node, tally)
      return
    }

    this.dead.delete(m.id) // a retried marble leaves the tray
    const node = this.nodeById(m.node)
    const lm: LiveMarble = {
      id: m.id,
      node: m.node,
      status: m.status,
      enteredAt: (m.trail ?? []).at(-1)?.enteredAt ?? m.updatedAt,
    }
    if (m.status === "blocked" && node) {
      lm.gate = {
        agent: node.type === "agent",
        edges: this.outgoing(node.id).map((e) => ({ name: e.name ?? e.to, form: e.form })),
        present: node.present,
      }
    }
    this.live.set(m.id, lm)
  }

  seed(marbles: Marble[]): void {
    for (const m of marbles) this.apply(m)
  }

  snapshot(): ViewSnapshot {
    const ends: Record<string, EndTally> = {}
    for (const [node, t] of this.ends) ends[node] = { total: t.total, recent: [...t.recent] }
    const stats: Record<string, NodeStats> = {}
    for (const [node, s] of this.nodeStats) {
      stats[node] = { runs: s.runs, fails: s.fails, dwellP50: pct(s.samples, 50), dwellP95: pct(s.samples, 95) }
    }
    return { live: [...this.live.values()], ends, stats, deadLetter: [...this.dead.values()] }
  }
}
