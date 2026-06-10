// Type declarations for the plain-ESM form module (unit-tested from bun).
// `container` is a DOM element (the page runs in a browser; tests use happy-dom).
export function renderForm(fields: any[]): string
export function readForm(container: any, fields: any[]): Record<string, unknown>
export function showFieldErrors(container: any, fieldErrors: Record<string, string> | null | undefined): void
