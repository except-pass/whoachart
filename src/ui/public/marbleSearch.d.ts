// Type declarations for the marble history search module (roadmap 3c).
// The pure helpers are unit-tested from bun; mountMarbleSearch does the DOM work.
export function marbleHaystack(m: {
  id?: string
  node?: string
  workpiece?: string
  context?: Record<string, unknown>
}): string
export function fuzzyScore(query: string, text: string): number
export function searchMarbles<T extends { status: string; createdAt: string }>(
  marbles: T[],
  query: string,
  statuses: Set<string> | null,
): T[]
export function statusCounts(marbles: { status: string }[]): Record<string, number>
export function fmtAgeFull(iso: string, nowMs: number): string
export function mountMarbleSearch(opts: { chart: string; openMarble: (id: string) => void }): void
