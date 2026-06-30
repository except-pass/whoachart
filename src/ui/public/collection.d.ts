// Type declarations for the collection client (index cards + canvas toggle).
export interface MemberStatus {
  name: string
  missing: boolean
  inFlight?: number
  blocked?: number
  failed?: number
  ended?: number
  lastOutcome?: "done" | "failed" | null
}
export interface CollectionView {
  name: string
  title: string
  description: string
  members: MemberStatus[]
}
export function badges(m: MemberStatus): string
export function card(m: MemberStatus): string
export function renderIndex(view: CollectionView): void
export function buildCells(view: CollectionView): void
export function refreshCells(): Promise<void>
export function setCanvas(open: boolean, view?: CollectionView | null): void
export function __resetCanvasState(): void
