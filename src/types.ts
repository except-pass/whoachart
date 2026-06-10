export type NodeKind = string

export interface TrailHop {
  node: string
  enteredAt: string
  leftAt?: string
  // Context snapshot taken as the marble LEFT this node (after its merges) —
  // powers per-step state time-travel in the inspector.
  context?: Record<string, unknown>
}

export interface FormField {
  key: string
  type: "text" | "textarea" | "number" | "boolean" | "enum"
  label?: string
  required?: boolean
  default?: unknown
  options?: string[]
  min?: number
  max?: number
  step?: number
}

export interface PresentSpec {
  key: string
  as: "markdown" | "json" | "text" | "link"
}

export interface ChartNode {
  id: string
  type: NodeKind
  name?: string
  color?: string
  on_leave?: string
  retry?: { max: number }
  timeout?: number // milliseconds
  position?: { x: number; y: number }
  stuck_after?: number // seconds before a dwelling marble is flagged stuck
  present?: PresentSpec[]
  config: Record<string, unknown>
}

export interface ChartEdge {
  from: string
  to: string
  name?: string
  on_traversal?: string
  default?: boolean
  form?: FormField[]
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
  trail?: TrailHop[]
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
