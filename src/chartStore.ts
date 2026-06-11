import { mkdir, readdir, readFile, writeFile, rename, unlink } from "node:fs/promises"
import { join } from "node:path"

// HTTP-shaped error for the chart-store CRUD path. The control API maps `status`
// to the response code and folds `detail` into the JSON body (e.g. the list of
// marbles blocking a hot-reload).
export class ChartError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = "ChartError"
  }
}

// Chart names become filenames inside the store dir, so they MUST be constrained
// before any fs op or a `../` / `/` name would escape the directory (path
// traversal). Mirrors the marble store's "disk is the source of truth" stance:
// the on-disk *.yaml set IS the registry — no separate index to drift.
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export function assertSafeChartName(name: string): void {
  // Reject empties, traversal (`.`/`..`/`/`), and a leading dot (hidden files)
  // up front. The leading-char class above already forbids a leading `.`.
  if (!SAFE_NAME.test(name)) {
    throw new ChartError(`invalid chart name: ${JSON.stringify(name)} (allowed: A-Za-z0-9._-, no leading dot)`, 400)
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8")
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err // a real read error (perms, I/O) must not masquerade as "absent"
  }
}

// Atomic publish of arbitrary file content via tmp+rename, so a half-written
// chart file is never visible to a concurrent boot/reload. Shared by ChartStore
// (register) and the daemon's update path (writes back to a chart's own file,
// which may live outside the store dir for boot-loaded charts).
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(tmp, content)
  try {
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {}) // don't orphan the tmp file if the rename fails
    throw err
  }
}

// Server-owned directory of chart *.yaml files. Separate concern from the marble
// store (src/store.ts) — this owns chart definitions; that owns run state.
export class ChartStore {
  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  // Canonical write target. New charts are always written as .yaml; a legacy
  // .yml in the dir is honored on read (see resolvePath) but never created here.
  path(name: string): string {
    assertSafeChartName(name)
    return join(this.dir, `${name}.yaml`)
  }

  // The actual on-disk path for a chart, honoring a legacy .yml; falls back to
  // the canonical .yaml when neither exists (so a missing chart surfaces ENOENT
  // on the expected path). listNames() accepts both extensions, so read/path
  // MUST too or a .yml chart crashes boot.
  async resolvePath(name: string): Promise<string> {
    assertSafeChartName(name)
    const yaml = join(this.dir, `${name}.yaml`)
    if (await fileExists(yaml)) return yaml
    const yml = join(this.dir, `${name}.yml`)
    if (await fileExists(yml)) return yml
    return yaml
  }

  // Chart names of every *.yaml/*.yml currently on disk (the registry listing).
  async listNames(): Promise<string[]> {
    await this.init()
    return (await readdir(this.dir))
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""))
  }

  async exists(name: string): Promise<boolean> {
    assertSafeChartName(name)
    return (await fileExists(join(this.dir, `${name}.yaml`))) || (await fileExists(join(this.dir, `${name}.yml`)))
  }

  async read(name: string): Promise<string> {
    return readFile(await this.resolvePath(name), "utf8")
  }

  // Note: the daemon's delete path unlinks the chart's own file directly (which
  // may live outside this dir for boot-loaded charts), so there is no remove()
  // here — the on-disk *.yaml set is the registry and the daemon owns its paths.

  // Atomic publish: a half-written chart file is never visible to a concurrent
  // boot/reload (same tmp+rename trick as MarbleStore.save).
  async write(name: string, yamlText: string): Promise<void> {
    await this.init()
    await atomicWrite(this.path(name), yamlText)
  }
}
