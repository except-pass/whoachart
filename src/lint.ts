import type { Chart } from "./types"

// Result of static-analysing a chart at registration time. `errors` would block
// a register/update; `warnings` are surfaced in the response but don't block.
export interface LintResult {
  errors: string[]
  warnings: string[]
}

// REGISTRATION SEAM for roadmap task 3b (chart lint — unreachable nodes, edges
// to nowhere, dangling defaults, etc.). The chart-store CRUD path calls this
// right after `parseChart` so 3b can hook real analysis in here without touching
// the store. Today it is intentionally a no-op: structural validation
// (dup ids, edge endpoints, typed config) already lives in `parseChart`.
export function lintChart(_chart: Chart): LintResult {
  return { errors: [], warnings: [] }
}
