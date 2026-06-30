---
date: 2026-06-30
topic: chart-collections
---

# Chart Collections — Requirements

## Summary

Add a first-class **Collection**: a named set of thematically-related charts declared in a small manifest. A collection gets its own landing page that shows each member chart as a card with live status, and expands into a combined canvas where every member's node-graph animates together. Today related charts (e.g. SREna's `_srena` set) are individual charts linked only by convention, with no shared home and no way to see them at once.

## Problem Frame

A daemon already serves many charts at once, but each is an island: you reach it at `/ui/charts/:name` and there is no surface that says "these N charts are one thing." SREna lives this gap — roughly ten charts (`prod-health-sweep`, the `pdca-*` improvement loop, the health sweeps, `serena-heartbeat`) are symlinked into one chart dir and run under `WHOACHART_SPACE=_srena`, related only because the operator knows they are. To answer "is the SRE operating loop healthy right now?" the operator opens charts one at a time and reassembles the picture in their head. The cost is not a missing feature inside any chart; it is the absence of an identity and a single view for the set.

## Key Decisions

**Collection identity lives in a thin manifest, not a folder or a per-chart tag.** A small `collection.yaml` declares the collection's `name`, `title`, `description`, and an ordered list of member chart references (names, not copies). The folder-derived alternative gives only a folder name with no place to hang a title, description, or deliberate card order; the per-chart-tag alternative scatters identity across N files and leaves collection metadata homeless. The manifest is the only option that directly serves "named grouping + navigation," and its by-reference membership extends to multi-membership later without a schema tear-out.

**The default surface is an index with live status; the combined canvas is opt-in.** The cheap, always-useful glance — a card per member chart with health at a glance — is what loads first. The heavy view that renders and animates every member graph live on one screen sits behind a toggle, paid for only when the operator wants to watch the whole set move.

**Collections describe; they do not load.** A manifest references charts that the daemon already loads through its existing chart-loading paths. Adding a chart name to a manifest does not bring that chart live; it assumes the chart is (or will be) registered independently. This keeps the collection axis orthogonal to chart loading and to the runtime `space` concept.

**Single-membership now, by convention; the mechanism leaves room for more.** A chart is expected to appear in one manifest. The by-reference design permits the same chart name in two manifests later, but nothing in v1 enforces single-membership or de-dups overlap — "leave room" means do not preclude it, not build it.

## Requirements

### Manifest & membership

R1. A collection is declared in a manifest carrying a `name` (stable identifier), a human `title`, a `description`, and an ordered list of member chart references by chart name.

R2. The manifest is validated at parse time — a malformed manifest (missing required field, member reference that is not a string) is rejected before it can be served, consistent with how charts are validated before any runtime swap.

R3. Member references are by chart name only; the manifest never embeds or copies chart definitions.

R4. A member reference that names a chart not currently loaded in the daemon does not error the collection — its card renders in a missing/stale state (see R8), and the rest of the collection renders normally.

R5. Member order in the manifest is the display order on the index and the canvas; the collection does not re-sort members.

### Index view (default surface)

R6. A collection has a landing page reachable by its `name`, showing the collection's `title` and `description` and one card per member chart in manifest order.

R7. Each member card shows the chart's name plus live status derived from existing daemon state: count of marbles in flight, counts of blocked and failed marbles, and a last-run indicator.

R8. A card whose referenced chart is not loaded renders in a distinct missing/stale state rather than being omitted or crashing the page.

R9. A member card links to that chart's existing full view (`/ui/charts/:name`).

R10. Live status on the index refreshes on the same cadence the existing UI already polls at; no new streaming transport is introduced.

### Combined canvas (opt-in)

R11. The index page exposes a toggle that expands into a combined canvas rendering every loaded member chart's node-graph together (tiled and/or pan-zoom), reusing the existing per-chart graph renderer.

R12. On the combined canvas, marbles animate live across all member graphs simultaneously, using the same data the per-chart view uses.

R13. The canvas is opt-in: it is not the default surface and is entered only via the toggle.

### Serving & discovery

R14. The daemon discovers and serves registered collections, exposing the data the index and canvas need (the member list plus per-member status) over the control API, consistent with the existing chart-serving and loopback/Tailscale trust surface.

R15. Collection registration follows the existing register-by-reference pattern (a manifest at a path becomes discoverable without a separate side index), so collections survive restarts the same way charts do.

## Key Flows

F1. **Declare and view a collection.**
**Trigger:** operator writes a `collection.yaml` naming the `_srena` charts in order and registers it.
The daemon validates and serves the collection. The operator opens the collection's landing page and sees one card per member with live status, in manifest order. They click a card to drill into that chart's full view, then return.

F2. **Watch the whole set move.**
**Trigger:** operator is on the collection index and wants the live picture.
They flip the canvas toggle. Every loaded member graph renders together and marbles animate across all of them at once. They flip back to the index for the at-a-glance status view.

F3. **Stale member reference.**
**Trigger:** a manifest names a chart that is not currently loaded (renamed, not yet registered, or removed).
The collection still serves. That member's card renders in the missing/stale state; all other cards render normally and the canvas renders the loaded members.

## Acceptance Examples

AE1. **Covers R4, R8.** Given a manifest listing four charts where one is not loaded, when the operator opens the collection index, then three cards render with live status and the fourth renders in the missing/stale state — the page does not error.

AE2. **Covers R7, R10.** Given a member chart with two marbles running and one blocked, when the index is open, then that card shows two in-flight and one blocked, and the counts update on the existing poll cadence without a page reload.

AE3. **Covers R5, R11.** Given a manifest whose member order is C, A, B, when the operator expands the canvas, then the member graphs appear in order C, A, B — matching the index.

## Scope Boundaries

### Deferred for later
- **Multi-membership as working behavior.** v1 only avoids precluding it; it does not enforce single-membership, de-dup overlap, or handle a chart appearing on two collection indexes.
- **Collection-level acting on gates** — e.g. approving/blocking marbles across all member charts from the collection view.

### Outside this product's identity
- **Collection-level automation.** Triggers, hooks, or a supervisor that span members are not part of collections; automation stays a chart-level concern. A collection groups and displays; it adds no runtime behavior.
- **Cross-chart marble hand-off.** Wiring chart A's end into chart B's source (a macro-pipeline) is a different feature; a collection is not an execution graph.

## Dependencies / Assumptions

- Assumes the existing chart store / register-by-reference and chart-loading paths are the substrate; collections reference charts those paths already bring live.
- Assumes member status is derivable from existing daemon state (the chart list plus the marble store) — no new per-marble telemetry is required.
- Assumes the existing UI poll cadence is sufficient for index liveness; no SSE/websocket transport is added.
- The collection axis is orthogonal to `WHOACHART_SPACE` (a runtime/widget namespace), not a synonym for it.
- Trust surface is unchanged: loopback + Tailscale; collection writes are loopback-gated like chart writes.

## Outstanding Questions

### Deferred to Planning
- Where a manifest physically lives and how it is registered (drop-in dir vs explicit register-by-path) — settle against the existing chart-store layout during planning.
- Exact route shape for the collection index and combined-canvas data, and how much of the existing `renderPage` shell is reused vs extended.
- Combined-canvas layout mechanics (tiling vs single pan-zoom viewBox across N graphs) and any performance ceiling on member count.
- The precise "last-run" indicator semantics on a card (timestamp, status, or both).
