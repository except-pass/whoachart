import type { Chart, Marble } from "../types"
import type { ArtifactSink, ArtifactPlacement } from "../tinstar"
import { layoutChart, type Layout } from "./layout"
import { renderChart } from "./render"

export class ViewBridge {
  private marbles = new Map<string, Marble>()
  private layout: Layout
  private artifactId?: string
  private timer?: ReturnType<typeof setTimeout>
  private dirty = false

  constructor(
    private sink: ArtifactSink,
    private chart: Chart,
    private placement: ArtifactPlacement = {},
    private debounceMs = 120,
  ) {
    this.layout = layoutChart(chart)
  }

  seed(marbles: Marble[]): void {
    for (const m of marbles) this.marbles.set(m.id, m)
  }

  update(m: Marble): void {
    this.marbles.set(m.id, m)
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.dirty) void this.flush()
    }, this.debounceMs)
  }

  private html(): string {
    return renderChart(this.chart, [...this.marbles.values()], this.layout)
  }

  async start(): Promise<void> {
    const ref = await this.sink.postArtifact(this.html(), {
      name: `whoachart-${this.chart.name}`,
      size: { width: this.layout.width + 40, height: this.layout.height + 90 },
      ...this.placement,
    })
    this.artifactId = ref.artifactId
  }

  async flush(): Promise<void> {
    this.dirty = false
    if (!this.artifactId) {
      await this.start()
      return
    }
    const ok = await this.sink.putArtifact(this.artifactId, this.html())
    if (!ok) {
      const ref = await this.sink.postArtifact(this.html(), {
        name: `whoachart-${this.chart.name}`,
        ...this.placement,
      })
      this.artifactId = ref.artifactId
    }
  }
}
