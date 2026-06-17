import type { CanvasControl, EnsureWidgetOpts, SessionLauncher, SpawnSessionOpts } from "../src/tinstar"

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
