import { join } from "node:path"

const PUBLIC_DIR = join(import.meta.dir, "public")

// Serve /ui/<file>.js from src/ui/public — basename only, no traversal.
export async function serveStatic(filename: string): Promise<Response | null> {
  if (!/^[a-z0-9._-]+\.js$/i.test(filename)) return null
  const f = Bun.file(join(PUBLIC_DIR, filename))
  if (!(await f.exists())) return null
  return new Response(f, { headers: { "Content-Type": "application/javascript; charset=utf-8" } })
}
