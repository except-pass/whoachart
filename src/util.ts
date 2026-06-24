export function genId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function now(): string {
  return new Date().toISOString()
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// Recursively merge `patch` into `base`, returning a new object. Plain objects
// merge key-by-key; everything else (scalars, arrays) is replaced wholesale.
// Used by `annotate` so an agent can add e.g. {decision:{verdict:"go"}} without
// clobbering sibling keys already under `decision`.
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v
  }
  return out
}
