import type { Chart, Marble } from "../types"
import type { ArtifactSink, ArtifactPlacement } from "../tinstar"
import { layoutChart, type Layout } from "./layout"
import { renderShell } from "./render"
import { ViewState, type ViewSnapshot } from "./viewState"

// Posts the stable view shell to Tinstar ONCE, then maintains an in-memory
// aggregate of marble state. The shell's client polls the daemon's state
// endpoint (served from this.snapshot()) and animates marbles itself — so the
// artifact is never replaced (no flashing) and the payload stays bounded.
export class ViewBridge {
  private state: ViewState
  private layout: Layout
  private artifactId?: string

  constructor(
    private sink: ArtifactSink,
    private chart: Chart,
    private stateUrl: string,
    private placement: ArtifactPlacement = {},
  ) {
    this.state = new ViewState(chart)
    this.layout = layoutChart(chart)
  }

  // Pre-load marbles (e.g. from the store on boot) before the first snapshot.
  seed(marbles: Marble[]): void {
    this.state.seed(marbles)
  }

  // Called for every engine onChange snapshot — O(1), no I/O.
  update(m: Marble): void {
    this.state.apply(m)
  }

  // Served by the daemon's state endpoint; the client polls it.
  snapshot(): ViewSnapshot {
    return this.state.snapshot()
  }

  async start(): Promise<void> {
    const html = renderShell(this.chart, this.layout, this.stateUrl)
    const ref = await this.sink.postArtifact(html, {
      name: `whoachart-${this.chart.name}`,
      size: { width: this.layout.width + 40, height: this.layout.height + 110 },
      ...this.placement,
    })
    this.artifactId = ref.artifactId
  }
}
