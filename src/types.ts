export type NodeKind = string

export interface ChartNode {
  id: string
  type: NodeKind
  name?: string
  color?: string
  on_leave?: string
  retry?: { max: number }
  timeout?: number // milliseconds
  position?: { x: number; y: number }
  config: Record<string, unknown>
}

export interface ChartEdge {
  from: string
  to: string
  name?: string
  on_traversal?: string
  default?: boolean
}

export interface Chart {
  name: string
  nodes: ChartNode[]
  edges: ChartEdge[]
}

export type MarbleStatus = "queued" | "running" | "blocked" | "done" | "failed"

export interface Marble {
  id: string
  chart: string
  node: string
  context: Record<string, unknown>
  workpiece?: string
  history: string[]
  status: MarbleStatus
  error?: string
  createdAt: string
  updatedAt: string
}

export interface NodeResult {
  next?: string // edge name (or target node id) to take
  merge?: Record<string, unknown> // merged into marble.context
  end?: boolean
  endOutcome?: "success" | "fail" | "warning"
  block?: boolean // wait for an external event
  failed?: boolean // activity reported failure (engine resolves routing)
}

export interface RunCtx {
  chart: Chart
  marble: Marble
  node: ChartNode
  outgoing: ChartEdge[]
}
