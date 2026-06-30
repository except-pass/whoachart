// Type declarations for the read-only mini-graph renderer (collection canvas).
export interface MiniBox { x: number; y: number; w: number; h: number }
export interface MiniDef {
  nodes: { id: string; type: string; name?: string; color?: string }[]
  edges: { from: string; to: string; name?: string }[]
  layout: { width: number; height: number; boxes: Record<string, MiniBox> }
}
export interface MiniState {
  live?: { id: string; node: string; status: string }[]
}
export function clearMiniChart(svg: SVGSVGElement): void
export function renderMiniChart(svg: SVGSVGElement, def: MiniDef, state: MiniState): void
