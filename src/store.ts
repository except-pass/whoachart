import { mkdir, readdir, readFile, writeFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Marble } from "./types"

export class MarbleStore {
  constructor(private dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  // Delete this chart's entire run-state directory. Used by DELETE ?purge=true;
  // without purge the daemon leaves these files on disk for post-mortem audit.
  async purge(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  async save(m: Marble): Promise<void> {
    const tmp = `${this.path(m.id)}.${process.pid}.${crypto.randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(m, null, 2))
    await rename(tmp, this.path(m.id)) // atomic replace
  }

  async load(id: string): Promise<Marble | null> {
    let raw: string
    try {
      raw = await readFile(this.path(id), "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null // genuinely no such marble
      throw err // a real read error (perms, I/O) must not masquerade as "unknown marble"
    }
    try {
      return JSON.parse(raw) as Marble
    } catch (err) {
      // Corrupt existing file — surface it loudly, matching all()'s behavior,
      // instead of reporting it to callers as a nonexistent marble.
      console.error(`[whoachart] unreadable marble file ${id}.json: ${err}`)
      throw new Error(`corrupt marble file: ${id}`)
    }
  }

  async all(): Promise<Marble[]> {
    await this.init()
    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"))
    const out: Marble[] = []
    for (const f of files) {
      try {
        out.push(JSON.parse(await readFile(join(this.dir, f), "utf8")) as Marble)
      } catch (err) {
        // A corrupt marble file must not silently vanish — surface it loudly.
        console.error(`[whoachart] skipping unreadable marble file ${f}: ${err}`)
      }
    }
    return out
  }
}
