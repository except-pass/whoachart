// Type declarations for the shape legend (roadmap 2b).
export interface LegendEntry {
  shape: "stadium" | "diamond" | "rect"
  label: string
  types: string[]
}
export interface NodeLike { type: string; [k: string]: unknown }
export function legendEntries(def: { nodes?: NodeLike[] }): LegendEntry[]
export function swatchSvg(shape: string): string
export function legendHtml(def: { nodes?: NodeLike[] }): string
export function initLegend(canvas: HTMLElement, def: { nodes?: NodeLike[] }): HTMLElement | null
