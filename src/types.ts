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
  // `markdown` renders inline as real markdown; `markdown_file` treats the
  // value as a path the UI fetches + inlines. PRIMARY entries (primary:true or
  // the conventional `decision` key) render prominently at the top of the gate;
  // everything else demotes to the collapsible evidence footer.
  as: "markdown" | "markdown_file" | "json" | "text" | "link"
  primary?: boolean
}

export interface ChartNode {
  id: string
  type: NodeKind
  name?: string
  // Human-readable docs for what this step DOES, independent of the code it
  // runs. `description` is a markdown string (operator- and agent-facing);
  // `doc` is a link/path to an external runbook or skill. Both are surfaced in
  // the node drawer, the canvas hover card, and the /def API for agents.
  description?: string
  doc?: string
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
  // Aborted when the node's `timeout` elapses, so activities can kill their
  // underlying process / in-flight fetch instead of leaking it past the deadline.
  signal?: AbortSignal
  // Live output sink: an activity calls this per line to stream its execution
  // into the node inspector. Engine tags each line with (marble, node).
  log?: (stream: ActivityStream, line: string) => void
}

// The output stream a node activity writes to (process stdout/stderr). The log
// buffer adds a synthetic "event" stream on top for lifecycle lines.
export type ActivityStream = "stdout" | "stderr"
