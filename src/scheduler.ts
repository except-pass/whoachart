import { nextRun, everyToMs } from "./cron"
import type { ChartTrigger } from "./types"

export interface Clock {
  now(): number
  // Run fn after ms; return a cancel function.
  setTimer(ms: number, fn: () => void): () => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => {
    const t = setTimeout(fn, ms)
    ;(t as unknown as { unref?: () => void }).unref?.() // never hold the process open
    return () => clearTimeout(t)
  },
}

// Arms one self-rescheduling timer per time-based trigger (cron/every). Webhook
// triggers are not time-based and are ignored here. `fire` is called per tick;
// it may reject — onError is notified and the schedule continues (fire-forward).
export class Scheduler {
  private cancels = new Map<string, Array<() => void>>()
  constructor(
    private clock: Clock = realClock,
    private onError?: (chart: string, err: unknown) => void,
  ) {}

  arm(chart: string, triggers: ChartTrigger[], fire: (t: ChartTrigger) => Promise<void> | void): void {
    this.disarm(chart)
    const cancels: Array<() => void> = []
    for (const t of triggers) {
      if (t.cron) {
        cancels.push(this.repeat(chart, t, fire, () =>
          Math.max(0, nextRun(t.cron!, new Date(this.clock.now())).getTime() - this.clock.now())))
      } else if (t.every) {
        const ms = everyToMs(t.every)
        cancels.push(this.repeat(chart, t, fire, () => ms))
      }
      // webhook: handled by the inbound route, not the scheduler
    }
    if (cancels.length) this.cancels.set(chart, cancels)
  }

  disarm(chart: string): void {
    for (const c of this.cancels.get(chart) ?? []) c()
    this.cancels.delete(chart)
  }

  disarmAll(): void {
    for (const chart of [...this.cancels.keys()]) this.disarm(chart)
  }

  // Schedule `fire` after delayMs(), then reschedule from delayMs() again. Cancel
  // is idempotent and stops further reschedules.
  private repeat(
    chart: string,
    t: ChartTrigger,
    fire: (t: ChartTrigger) => Promise<void> | void,
    delayMs: () => number,
  ): () => void {
    let cancelled = false
    let cancelTimer: () => void = () => {}
    const tick = (): void => {
      if (cancelled) return
      // delayMs() can throw for a cron with no occurrence in the search horizon
      // (e.g. "0 0 30 2 *"). It runs inside a timer callback, so an uncaught
      // throw would crash the daemon — route it to onError and stop THIS
      // trigger's schedule gracefully instead.
      let ms: number
      try {
        ms = delayMs()
      } catch (err) {
        this.onError?.(chart, err)
        return
      }
      cancelTimer = this.clock.setTimer(ms, () => {
        if (cancelled) return
        // Route BOTH a synchronous throw and a rejected promise from fire() to
        // onError (a sync throw escapes the .catch since it happens before
        // Promise.resolve attaches), and always tick() so the schedule survives.
        try {
          Promise.resolve(fire(t)).catch((err) => this.onError?.(chart, err))
        } catch (err) {
          this.onError?.(chart, err)
        }
        tick()
      })
    }
    tick()
    return () => { cancelled = true; cancelTimer() }
  }
}
