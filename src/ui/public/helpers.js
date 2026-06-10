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
