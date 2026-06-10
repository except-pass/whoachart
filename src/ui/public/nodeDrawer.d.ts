// Type declarations for the node inspector drawer (unit-tested from bun).
export function selectedNode(): string | null
export function clearNodeDrawer(): void
export function renderNodeBody(
  node: {
    id: string
    type: string
    name?: string
    color?: string
    present?: { key: string; as: string }[]
    stuck_after?: number
    timeout?: number
    retry?: { max: number }
    on_leave?: string
    config?: Record<string, unknown>
  },
  stats: { runs: number; fails: number; dwellP50: number | null; dwellP95: number | null } | null,
  marbles: { id: string; node: string; status: string }[],
  ends: { total: number; recent: unknown[] } | null,
): string
export interface NodeLogDelta {
  lines: { seq: number; ts: string; marble: string; node: string; stream: string; line: string }[]
  nextSeq: number
}
export function showNode(
  id: string,
  def: { nodes: any[] },
  state: { live: any[]; stats: Record<string, any>; ends: Record<string, any> },
  api: {
    openMarble: (id: string) => void
    nodeLogs?: (nodeId: string, since: number) => Promise<NodeLogDelta | null>
  },
): void
