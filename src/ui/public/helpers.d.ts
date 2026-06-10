// Type declarations for the plain-ESM client helpers (unit-tested from bun).
export function hue(id: string): string
export function ringFor(status: string): [string, number]
export function fmtAge(sec: number): string
export function fmtMs(ms: number): string
export function ageSeconds(enteredAt: string, nowMs: number): number
export function slotPos(box: { x: number; y: number; w: number; h: number }, i: number, n: number): { x: number; y: number }
export function counterPos(box: { x: number; y: number; w: number; h: number }): { x: number; y: number }
export function enumWidget(options: string[]): "radio" | "select"
export function escHtml(s: unknown): string
