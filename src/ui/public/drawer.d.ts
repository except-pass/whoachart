// Type declarations for the marble-inspector drawer (DOM module; the pure
// rendering is exercised through showMarble in uiDrawer.test.ts).
export function showMarble(id: string, gateInfo: unknown, api: unknown): Promise<void>
export function selectedMarble(): string | null
export function deselectMarble(): void
export function clearDrawer(): void
