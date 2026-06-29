// Self-contained 5-field cron + interval evaluator. No dependency.
//
// Fields: minute hour day-of-month month day-of-week (0=Sunday).
// Supported per field: `*`, value, `a-b` range, `a,b,c` list, `*/n` or `a-b/n`
// step. SIMPLIFICATION vs crontab(5): day-of-month and day-of-week are ANDed,
// not ORed — both must match. This is correct for the common "* dom + restricted
// dow" (weekday) and "restricted dom + * dow" cases; it only diverges when BOTH
// are restricted, which charts rarely need. Times are evaluated in LOCAL time.

interface Field { min: number; max: number }
const FIELDS: Field[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day of week (0=Sun)
]

function parseField(spec: string, { min, max }: Field): Set<number> {
  const out = new Set<number>()
  for (const part of spec.split(",")) {
    let step = 1
    let range = part
    const slash = part.indexOf("/")
    if (slash !== -1) { step = Number(part.slice(slash + 1)); range = part.slice(0, slash) }
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in cron field: "${part}"`)
    let lo: number, hi: number
    if (range === "*") { lo = min; hi = max }
    else if (range.includes("-")) { const [a, b] = range.split("-").map(Number); lo = a; hi = b }
    else { lo = hi = Number(range) }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron field out of range: "${part}" (allowed ${min}-${max})`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): Set<number>[] {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron must have 5 fields, got ${parts.length}: "${expr}"`)
  return parts.map((p, i) => parseField(p, FIELDS[i]))
}

// The next fire STRICTLY AFTER `after`, at minute resolution, in local time.
export function nextRun(expr: string, after: Date): Date {
  const [mins, hours, doms, months, dows] = parseCron(expr)
  const d = new Date(after.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1) // strictly after the current minute
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      months.has(d.getMonth() + 1) && doms.has(d.getDate()) && dows.has(d.getDay()) &&
      hours.has(d.getHours()) && mins.has(d.getMinutes())
    ) return d
    d.setMinutes(d.getMinutes() + 1)
  }
  throw new Error(`no cron match within a year for "${expr}"`)
}

// Interval form: <n>s|m|h -> milliseconds. Positive only.
export function everyToMs(spec: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(spec.trim())
  if (!m) throw new Error(`bad interval "${spec}" (expected <n>s|m|h, e.g. 15m)`)
  const mult = m[2] === "s" ? 1000 : m[2] === "m" ? 60_000 : 3_600_000
  const ms = Number(m[1]) * mult
  if (ms <= 0) throw new Error(`interval must be positive: "${spec}"`)
  return ms
}
