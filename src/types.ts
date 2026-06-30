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
  // Who may resolve this gate. The supervisor session acts ONLY on `agent`
  // gates; `human` (the default when unset) gates are left for a person.
  decider?: "human" | "agent"
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

export interface ChartTrigger {
  // Exactly one of these three is set (enforced in schema.ts).
  cron?: string          // 5-field cron, local time (e.g. "0 9 * * 1-5")
  every?: string         // interval form (e.g. "15m"); <n>s|m|h
  webhook?: string       // inbound hook id -> POST /api/hooks/:chart/:webhook
  start: string          // a source node id; the marble entry point
  context?: Record<string, unknown> // static context (cron/every); merged under a webhook body
}

export interface SupervisorSpec {
  brief: string
  cli_template?: string
  project?: string
}

// Lifecycle events a hook can subscribe to. All seven are points the engine
// already reaches in step(); `start` is a derived "first enter" and `leave` has
// no EngineEvent of its own (see engine.fireHooks).
export type HookEvent = "start" | "enter" | "leave" | "traverse" | "blocked" | "failed" | "end"

// One chart-level hook: an arbitrary shell command run as a pure side-effect when
// `on` fires. Observational only — its exit code never changes a marble's path.
// `node` scopes node-events (and `start`) to one node id; `edge` scopes `traverse`
// to one edge name; omit either to match all. `timeout` (ms) bounds the run.
export interface ChartHook {
  on: HookEvent
  node?: string
  edge?: string
  run: string
  timeout?: number
}

export interface Chart {
  name: string
  nodes: ChartNode[]
  edges: ChartEdge[]
  triggers?: ChartTrigger[]
  supervisor?: SupervisorSpec
  hooks?: ChartHook[]
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
  // True once the marble's `start` hook has fired. `history` length is NOT a
  // reliable "first entry" signal — it is only pushed on a successful traverse, so
  // a marble that blocks or fails at its FIRST node and then re-enters (signal /
  // retry) still has length 1. This persisted flag makes `start` fire exactly once.
  started?: boolean
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
