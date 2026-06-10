import type { CanvasControl, EnsureWidgetOpts, SessionLauncher, SpawnSessionOpts } from "../src/tinstar"

export class FakeCanvas implements CanvasControl {
  ensured: EnsureWidgetOpts[] = []
  panned: string[] = []
  failEnsure = false
  async ensureBrowserWidget(opts: EnsureWidgetOpts): Promise<{ widgetId: string }> {
    if (this.failEnsure) throw new Error("tinstar down")
    this.ensured.push(opts)
    return { widgetId: "browser-fake" }
  }
  async panToSession(name: string): Promise<boolean> {
    this.panned.push(name)
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
