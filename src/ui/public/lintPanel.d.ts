// Type declarations for the lint panel client module (DOM-tested from bun).
export interface LintWarning {
  level: "warn" | "info"
  code: string
  message: string
  node?: string
  edge?: { from: string; to: string }
}
export function mountLintPanel(
  def: { lint?: LintWarning[]; nodes: { id: string }[] },
  opts?: { host?: Element; onNodeClick?: (id: string) => void },
): Element | null
