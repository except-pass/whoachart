import { writeFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface ArtifactPlacement {
  name?: string
  sessionId?: string
  spaceId?: string
  color?: string
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  nearNodeId?: string
  slot?: number | string
  snapToSession?: boolean
}

export interface ArtifactRef {
  artifactId: string
  widgetId: string
}

export interface ArtifactSink {
  postArtifact(html: string, placement?: ArtifactPlacement): Promise<ArtifactRef>
  putArtifact(artifactId: string, html: string): Promise<boolean>
  deleteArtifact(artifactId: string): Promise<void>
}

export class TinstarClient implements ArtifactSink {
  constructor(private baseUrl = "http://localhost:5273") {}

  private async writeTemp(html: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "whoachart-art-"))
    const path = join(dir, "view.html")
    await writeFile(path, html)
    return path
  }

  async postArtifact(html: string, placement: ArtifactPlacement = {}): Promise<ArtifactRef> {
    const path = await this.writeTemp(html)
    const res = await fetch(`${this.baseUrl}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...placement }),
    })
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok || !body?.ok) {
      throw new Error(`postArtifact failed: ${res.status} ${JSON.stringify(body)}`)
    }
    return { artifactId: body.data.artifactId, widgetId: body.data.widgetId }
  }

  async putArtifact(artifactId: string, html: string): Promise<boolean> {
    const path = await this.writeTemp(html)
    const res = await fetch(`${this.baseUrl}/api/artifacts/${artifactId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })
    if (!res.ok) return false
    const body = (await res.json().catch(() => ({}))) as any
    return body?.ok !== false
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/artifacts/${artifactId}`, { method: "DELETE" }).catch(() => {})
  }
}
