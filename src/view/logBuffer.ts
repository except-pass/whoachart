// Ephemeral, in-memory live-output buffer for the node inspector. Per node we
// keep a bounded ring of recent lines (lifecycle events + shell stdout/stderr),
// tagged with the marble that produced them. NOT persisted — logs are
// operational telemetry, not durable state, so they're deliberately kept out of
// the marble store / time-travel trail and are lost on daemon restart.
//
// Each line gets a monotonic per-buffer `seq` so the poll-based UI can fetch a
// delta with `since(node, sinceSeq)` and advance a cursor. Because the ring is
// bounded, since=0 returns at most one ring's worth — never a full replay.

import type { ActivityStream } from "../types"

// Activity streams plus the synthetic "event" stream for lifecycle lines.
export type LogStream = ActivityStream | "event"

export interface LogEntry {
  seq: number
  ts: string
  marble: string
  node: string
  stream: LogStream
  line: string
}

export interface LogDelta {
  lines: LogEntry[]
  nextSeq: number
}

export class LogBuffer {
  // One ring per node, SHARED across all marbles currently on that node — a hot
  // node (many concurrent marbles) evicts faster, so older lines age out sooner.
  // Per-marble isolation is deferred; callers narrow with since(node, seq, marble).
  private perNode = new Map<string, LogEntry[]>()
  private seq = 0

  constructor(private perNodeMax = 200) {}

  append(e: { marble: string; node: string; stream: LogStream; line: string; ts: string }): LogEntry {
    const entry: LogEntry = { seq: ++this.seq, ...e }
    let arr = this.perNode.get(e.node)
    if (!arr) {
      arr = []
      this.perNode.set(e.node, arr)
    }
    arr.push(entry)
    if (arr.length > this.perNodeMax) arr.shift() // evict oldest — ring semantics
    return entry
  }

  // Lines for `node` with seq > sinceSeq (optionally only those from `marble`).
  // nextSeq is the cursor the caller should send next time: the highest seq
  // returned, or sinceSeq unchanged when there's nothing new. Bounded by the
  // ring, so a far-behind / since=0 caller gets at most perNodeMax lines, never
  // an error and never an unbounded replay.
  since(node: string, sinceSeq: number, marble?: string): LogDelta {
    const arr = this.perNode.get(node) ?? []
    const lines = arr.filter((e) => e.seq > sinceSeq && (!marble || e.marble === marble))
    const nextSeq = lines.length ? lines[lines.length - 1]!.seq : sinceSeq
    return { lines, nextSeq }
  }
}
