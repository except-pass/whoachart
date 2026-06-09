import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import type { Marble } from "./types"

export class MarbleStore {
  constructor(private dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
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
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as Marble
    } catch {
      return null
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
