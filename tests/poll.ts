// Deadline-based polling for async settle points, replacing fixed setTimeout
// sleeps that flake under CI load. waitFor calls fn() repeatedly until it
// returns a truthy value (which it returns) or the timeout elapses (it throws).
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<NonNullable<T>> {
  const timeout = opts.timeout ?? 2000
  const interval = opts.interval ?? 10
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeout}ms${opts.label ? `: ${opts.label}` : ""}`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

// Convenience: poll a marble fetcher until it reaches one of the given statuses.
export async function waitForStatus<M extends { status: string } | null>(
  get: () => Promise<M>,
  status: string | string[],
  label?: string,
): Promise<NonNullable<M>> {
  const want = Array.isArray(status) ? status : [status]
  return waitFor(async () => {
    const m = await get()
    return m && want.includes(m.status) ? m : null
  }, { label: label ?? `status ${want.join("|")}` }) as Promise<NonNullable<M>>
}
