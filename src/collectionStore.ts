import { mkdir, readdir, readFile, symlink } from "node:fs/promises"
import { join } from "node:path"
import { assertSafeChartName, atomicWrite } from "./chartStore"

// Server-owned directory of collection manifest *.yaml files — the same
// disk-is-the-registry stance as ChartStore (src/chartStore.ts), for a different
// concern: this owns COLLECTION manifests (which charts group together), not
// chart definitions and not run state. Kept a SEPARATE directory from the chart
// store on purpose: a manifest dropped into the chart dir would be parsed as a
// chart at boot and land in the daemon's bootErrors. Reuses ChartStore's safe-name
// guard and atomic-write helper rather than duplicating them — a manifest name
// becomes a filename, so the same path-traversal guard applies before any fs op.
export class CollectionStore {
  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  // Canonical write target. New manifests are always written as .yaml; a legacy
  // .yml in the dir is honored on read (resolvePath) but never created here.
  path(name: string): string {
    assertSafeChartName(name)
    return join(this.dir, `${name}.yaml`)
  }

  // Actual on-disk path, honoring a legacy .yml; falls back to the canonical
  // .yaml when neither exists so a missing manifest surfaces ENOENT on the
  // expected path. listNames() accepts both extensions, so this MUST too.
  async resolvePath(name: string): Promise<string> {
    assertSafeChartName(name)
    const yaml = join(this.dir, `${name}.yaml`)
    if (await fileExists(yaml)) return yaml
    const yml = join(this.dir, `${name}.yml`)
    if (await fileExists(yml)) return yml
    return yaml
  }

  // Names of every *.yaml/*.yml currently on disk (the registry listing).
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

  // Atomic publish: a half-written manifest is never visible to a concurrent
  // boot/reload (same tmp+rename trick ChartStore.write uses).
  async write(name: string, yamlText: string): Promise<void> {
    await this.init()
    await atomicWrite(this.path(name), yamlText)
  }

  // Register an external manifest BY REFERENCE: a symlink <name>.yaml -> target.
  // listNames/resolvePath/read follow symlinks, so the dir stays the registry
  // with no side index. Returns the symlink path (the runtime's file).
  async link(name: string, target: string): Promise<string> {
    await this.init()
    const linkPath = this.path(name) // assertSafeChartName runs inside path()
    await symlink(target, linkPath)
    return linkPath
  }
}

// Local copy of ChartStore's private fileExists: a real read error (perms, I/O)
// must not masquerade as "absent". Kept private to this module rather than
// widening ChartStore's export surface for one helper.
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8")
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err
  }
}
