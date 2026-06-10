// Pure helpers for the whoachart control-surface client. No DOM access here —
// everything in this file is unit-testable from bun directly.

// Deterministic vivid color per marble id (FNV-1a hash → hue), stable for the
// marble's whole journey so an individual job is trackable across the graph.
export function hue(id) {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `hsl(${((h >>> 0) * 137) % 360} 72% 62%)`
}

// Flowchart shape for a node type. ONE place maps type → shape so the canvas
// and the legend (task 2b) stay in sync: source/end read as terminals (stadium
// pill), decision as a branch (diamond), everything else as a step (rect).
export function shapeForType(type) {
  if (type === "source" || type === "end") return "stadium"
  if (type === "decision") return "diamond"
  return "rect"
}

// Status lives on the ring (fill encodes identity): red=failed, bright=working.
export function ringFor(status) {
  if (status === "failed") return ["#ef4444", 2.5]
  if (status === "running" || status === "blocked") return ["#eaf7ff", 2]
  return ["#0a0e14", 1.25]
}

// Compact age label: 47s, 12m, 3h. Empty string under a minute keeps the
// canvas quiet for fresh marbles.
export function fmtAge(sec) {
  if (sec < 60) return ""
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60) > 0 ? Math.floor((sec % 3600) / 60) + "m" : ""}`
}

// Compact duration for dwell times in the drawer: 840ms, 2.1s, 4m.
export function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
}

export function ageSeconds(enteredAt, nowMs) {
  return Math.max(0, Math.floor((nowMs - new Date(enteredAt).getTime()) / 1000))
}

// Position of the i-th of n marbles parked under a node box (max 8 shown).
export function slotPos(box, i, n) {
  const shown = Math.min(n, 8)
  return { x: box.x + box.w / 2 - (shown - 1) * 9 + (i % 8) * 18, y: box.y + box.h + 13 }
}

// Where a node's ×N completed-counter sits: bottom-right of the marble row.
export function counterPos(box) {
  return { x: box.x + box.w / 2 + 80, y: box.y + box.h + 17 }
}

// Gate edges with refusal semantics get danger styling. Word-start match for
// the verbs (covers "rejected", "failed"); "no" must be a whole word so names
// like "acknowledge", "snooze", or "normal" don't read as destructive.
export function isDangerEdge(name) {
  return /\b(reject|decline|fail)|\bno\b/i.test(name)
}

// One gate-button set per node, acting on the OLDEST blocked marble there
// (FIFO) — per-marble sets would stack unreadably. Agent gates are excluded
// (forcing an agent decision goes via the drawer).
export function oldestBlockedPerNode(live) {
  const byNode = new Map()
  for (const m of live) {
    if (m.status !== "blocked" || !m.gate || m.gate.agent) continue
    const cur = byNode.get(m.node)
    if (!cur || m.enteredAt < cur.enteredAt) byNode.set(m.node, m)
  }
  return byNode
}

// Enum fields render as radios when short, a dropdown when long.
export function enumWidget(options) {
  return options.length <= 4 ? "radio" : "select"
}

export function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// Build the inspector's step list from a marble: one entry per trail hop with
// dwell, the context snapshot as the marble LEFT that node (live context for
// the open hop), and which keys changed vs the previous step's snapshot.
export function trailSteps(marble) {
  const trail = marble.trail ?? []
  return trail.map((h, i) => {
    const live = !h.leftAt
    const context = live ? (marble.context ?? {}) : (h.context ?? null)
    const prev = i > 0 ? (trail[i - 1].context ?? null) : null
    const changes = context && prev ? diffContext(prev, context) : []
    const changedKeys = changes.map((c) => c.key)
    return {
      node: h.node,
      enteredAt: h.enteredAt,
      leftAt: h.leftAt ?? null,
      dwellMs: h.leftAt ? new Date(h.leftAt).getTime() - new Date(h.enteredAt).getTime() : null,
      context,
      changedKeys,
      changes,
      live,
    }
  })
}

// Structured diff between two context snapshots, for the inspector's
// per-step diff view: added / removed / changed keys with their values.
export function diffContext(prev, cur) {
  const out = []
  const keys = new Set([...Object.keys(prev), ...Object.keys(cur)])
  for (const k of keys) {
    const b = JSON.stringify(prev[k])
    const a = JSON.stringify(cur[k])
    if (b === a) continue
    if (b === undefined) out.push({ key: k, kind: "added", after: cur[k] })
    else if (a === undefined) out.push({ key: k, kind: "removed", before: prev[k] })
    else out.push({ key: k, kind: "changed", before: prev[k], after: cur[k] })
  }
  return out
}
