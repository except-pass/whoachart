// src/teardown.ts — deterministic teardown of a Tinstar sandbox space (U6).
//
// Empties a space (default `_testing`) of the whoachart footprint: browser
// widgets whose title marks them as whoachart's, and the runs/sessions living
// in that space. Safe and idempotent:
//   - resolves the space by NAME without creating it — a missing space is
//     "nothing to do", never an accidental create;
//   - scopes widget deletion to the `whoachart-` title prefix so a human's own
//     widget parked in the space is left alone;
//   - a second run finds nothing and reports zeroes.
//
// Shared by `bin/whoachart-teardown` and available for tests. The daemon's
// own SIGTERM cleanup (Daemon.teardownWidgets) deletes by tracked id instead —
// this function is the by-space sweep for the CLI.
import type { TinstarClient } from "./tinstar"

export interface TeardownResult {
  found: boolean // did the space exist?
  spaceId: string | null
  widgets: number // browser widgets removed
  sessions: number // sessions stopped
}

export interface TeardownOpts {
  // Only delete widgets whose title starts with this prefix. "" disables the
  // filter (delete every widget in the space). Default scopes to whoachart's.
  widgetPrefix?: string
}

export async function teardownSpace(
  client: TinstarClient,
  spaceName: string,
  opts: TeardownOpts = {},
): Promise<TeardownResult> {
  const prefix = opts.widgetPrefix ?? "whoachart-"
  const spaceId = await client.ensureSpace(spaceName, false) // never create during teardown
  if (!spaceId) return { found: false, spaceId: null, widgets: 0, sessions: 0 }

  const state = await client.getState()
  if (!state) return { found: true, spaceId, widgets: 0, sessions: 0 }

  const widgets = (state.browserWidgets ?? []).filter(
    (w: any) => w?.spaceId === spaceId && (prefix === "" || String(w?.title ?? "").startsWith(prefix)),
  )
  let removedWidgets = 0
  for (const w of widgets) {
    if (await client.deleteBrowserWidget(w.id)) removedWidgets++
  }

  // Runs carry spaceId + sessionId; stop each session in the space. Best-effort
  // — stopSession swallows its own errors, so a dead session can't wedge teardown.
  const runs = (state.runs ?? []).filter((r: any) => r?.spaceId === spaceId && r?.sessionId)
  for (const r of runs) {
    await client.stopSession(r.sessionId)
  }

  return { found: true, spaceId, widgets: removedWidgets, sessions: runs.length }
}
