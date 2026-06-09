export function genId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function now(): string {
  return new Date().toISOString()
}
