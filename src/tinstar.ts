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

export interface SpawnSessionOpts {
  name: string
  prompt: string
  color?: string
  project?: string
  cliTemplate?: string
  worktree?: boolean
}

// Minimal surface for spawning/stopping agent sessions — injectable for tests.
export interface SessionLauncher {
  spawnSession(opts: SpawnSessionOpts): Promise<{ name: string }>
  stopSession(name: string): Promise<void>
}

export class TinstarClient implements ArtifactSink, SessionLauncher {
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

  async spawnSession(opts: SpawnSessionOpts): Promise<{ name: string }> {
    // tmux reads "." as a pane separator — session names must be [a-z0-9-]
    const name = opts.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The kickoff prompt MUST be in the creation request — a separate
      // prompt POST races CLI boot and is silently dropped.
      body: JSON.stringify({ ...opts, name, backend: "tmux" }),
    })
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok || body?.ok === false) {
      throw new Error(`spawnSession failed: ${res.status} ${JSON.stringify(body)}`)
    }
    return { name }
  }

  async stopSession(name: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(name)}/stop`, {
      method: "POST",
    }).catch(() => {})
  }
}
