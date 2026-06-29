import type { CanvasControl, EnsureWidgetOpts, SessionLauncher, SpawnSessionOpts } from "../src/tinstar"
import type { Clock } from "../src/scheduler"

export class FakeCanvas implements CanvasControl {
  ensured: EnsureWidgetOpts[] = []
  panned: string[] = []
  deleted: string[] = []
  spaceRequests: string[] = []
  failEnsure = false
  panResult: "ok" | "no-run" | "unreachable" = "ok"
  // null models a space that couldn't be resolved/created (daemon falls back).
  spaceResult: string | null = "sp-fake"
  private nextWidget = 1
  async ensureBrowserWidget(opts: EnsureWidgetOpts): Promise<{ widgetId: string }> {
    if (this.failEnsure) throw new Error("tinstar down")
    this.ensured.push(opts)
    return { widgetId: `browser-fake-${this.nextWidget++}` }
  }
  async panToSession(name: string): Promise<"ok" | "no-run" | "unreachable"> {
    this.panned.push(name)
    return this.panResult
  }
  async ensureSpace(name: string, _create = true): Promise<string | null> {
    this.spaceRequests.push(name)
    return this.spaceResult
  }
  async deleteBrowserWidget(id: string): Promise<boolean> {
    this.deleted.push(id)
    return true
  }
}

export class FakeLauncher implements SessionLauncher {
  spawned: SpawnSessionOpts[] = []
  stopped: string[] = []
  async spawnSession(o: SpawnSessionOpts) {
    this.spawned.push(o)
    return { name: o.name }
  }
  async stopSession(n: string) {
    this.stopped.push(n)
  }
}

// Deterministic clock for scheduler tests. NOTE: advance(N*period) fires each
// periodic timer AT MOST ONCE — due timers are snapshotted before any callback
// re-arms, so a timer rescheduled during the advance lands past the new `t` and
// waits for a further advance. To simulate k firings, call advance(period) k
// times, not advance(k*period).
export class FakeClock implements Clock {
  private t = 0
  private seq = 0
  private timers: { at: number; fn: () => void; id: number }[] = []
  now(): number { return this.t }
  setTimer(ms: number, fn: () => void): () => void {
    const id = ++this.seq
    this.timers.push({ at: this.t + ms, fn, id })
    return () => { this.timers = this.timers.filter((x) => x.id !== id) }
  }
  // Advance time, firing every timer that comes due (earliest first). A timer the
  // callback re-arms lands past the new `t`, so it waits for a further advance.
  advance(ms: number): void {
    this.t += ms
    const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)
    this.timers = this.timers.filter((x) => x.at > this.t)
    for (const d of due) d.fn()
  }
}
