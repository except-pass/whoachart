import type { Marble } from "../types"

const RECENT_N = 8

export interface LiveMarble {
  id: string
  node: string
  status: string
}

export interface EndTally {
  total: number
  recent: { id: string; status: string }[]
}

export interface ViewSnapshot {
  live: LiveMarble[]
  ends: Record<string, EndTally>
}

// In-memory aggregate of a chart's marbles for the live view. Updated O(1) per
// engine onChange — never rescans the store. In-flight marbles are tracked
// individually; terminal marbles collapse into a per-node counter that keeps
// only the last N as renderable dots, so the view stays bounded across any
// number of completed jobs.
export class ViewState {
  private live = new Map<string, LiveMarble>()
  private ends = new Map<string, EndTally>()

  constructor(private recentN = RECENT_N) {}

  apply(m: Marble): void {
    if (m.status === "done" || m.status === "failed") {
      this.live.delete(m.id)
      const tally = this.ends.get(m.node) ?? { total: 0, recent: [] }
      tally.total += 1
      tally.recent.push({ id: m.id, status: m.status })
      if (tally.recent.length > this.recentN) tally.recent.shift()
      this.ends.set(m.node, tally)
    } else {
      this.live.set(m.id, { id: m.id, node: m.node, status: m.status })
    }
  }

  seed(marbles: Marble[]): void {
    for (const m of marbles) this.apply(m)
  }

  snapshot(): ViewSnapshot {
    const ends: Record<string, EndTally> = {}
    for (const [node, tally] of this.ends) {
      ends[node] = { total: tally.total, recent: [...tally.recent] }
    }
    return { live: [...this.live.values()], ends }
  }
}
