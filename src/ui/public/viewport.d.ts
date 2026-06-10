// Type declarations for the canvas viewport (zoom / pan / minimap, roadmap 2b).
export interface Base { w: number; h: number }
export interface View { x: number; y: number; w: number; h: number }
export function clamp(v: number, lo: number, hi: number): number
export function viewFor(scale: number, cx: number, cy: number, base: Base): View
export function clampCenter(cx: number, cy: number, base: Base): { cx: number; cy: number }
export function anchoredZoom(
  scale: number, cx: number, cy: number, base: Base,
  factor: number, anchor: { x: number; y: number }, minScale: number, maxScale: number,
): { scale: number; cx: number; cy: number }
export function initViewport(
  svg: SVGSVGElement, canvas: HTMLElement,
  def: { layout: { width: number; height: number; boxes?: Record<string, { x: number; y: number; w: number; h: number }> }; nodes?: { id: string; type: string; color?: string }[] },
): { zoomBy: (factor: number, anchor?: { x: number; y: number }) => void; reset: () => void }
