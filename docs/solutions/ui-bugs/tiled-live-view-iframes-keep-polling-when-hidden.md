---
module: collection-view
date: 2026-06-30
problem_type: ui_bug
component: frontend_stimulus
severity: medium
symptoms:
  - "Opening the collection combined-canvas once permanently adds N full chart clients to the tab, each polling /state every 600ms for the page lifetime"
  - "Closing the canvas with display:none stops nothing — the hidden iframes keep their timers running"
  - "Toggling the canvas open before the first data poll lands leaves it permanently blank"
  - "Tiles are a one-shot snapshot: a member that loads after first open never appears; a deleted member becomes a 404 iframe"
root_cause: memory_leak
resolution_type: code_fix
related_components:
  - frontend_stimulus
tags:
  - iframe-tiling
  - poll-loop-leak
  - component-lifecycle
  - hidden-not-unmounted
  - live-view
  - teardown-on-close
---

# Tiled live-view iframes keep polling when hidden — unmount, don't hide

*Found by multi-agent code review (adversarial + correctness) on whoachart PR for chart collections, commit `625cf18`, `src/ui/public/collection.js`.*

## Problem

A "combined canvas" that tiles N live sub-views by embedding each as an `<iframe>` of a self-polling page leaks one poll loop per tile when the canvas is closed by hiding it (`display:none`) instead of unmounting it. Each iframe is a full page running its own `setTimeout`-chained `/state` poll; hiding the container leaves every iframe mounted and ticking for the rest of the tab's lifetime. Two adjacent lifecycle bugs travel with it: opening the canvas before the first data poll leaves it blank forever, and building the tiles once (a latch) freezes them against later membership changes.

## Symptoms

- Opening the canvas once permanently added N chart clients to the tab, each polling every 600ms — closing it freed none of them.
- An early toggle (before the first `/api/collections/:name` poll returned) left `lastView` null, so the tiles were never built and the canvas stayed empty even after data arrived.
- A `renderedTiles` latch meant the tiles reflected membership as of the *first* open only: a chart that loaded later never appeared; a removed chart lingered as a 404 iframe.

## What Didn't Work

The first implementation treated the canvas like a cheap show/hide panel:

```js
// WRONG: hide on close, build once.
let renderedTiles = false
export function setCanvas(open, view) {
  $("cards").classList.toggle("hidden", open)
  $("tiles").classList.toggle("hidden", !open)   // display:none — iframes stay mounted
  if (open && !renderedTiles && view) renderTiles(view) // one-shot; view may be null
}
```

`display:none` does not unload an iframe — its document, timers, and fetches keep running. And the `!renderedTiles && view` guard silently no-ops when the canvas is opened before the first poll (`view` is null), with nothing to build it later.

## Solution

Tie the iframes' existence to the open/closed state: build fresh from the latest data on open, tear down on close, and build on the first poll if the canvas was opened early.

```js
let tilesBuilt = false
let lastView = null

export function renderTiles(view) { /* ...innerHTML = tiles... */ tilesBuilt = true }

function teardownTiles() {
  $("tiles").innerHTML = ""   // unmount iframes -> their poll loops stop
  tilesBuilt = false
}

export function setCanvas(open, view) {
  $("cards").classList.toggle("hidden", open)
  $("tiles").classList.toggle("hidden", !open)
  if (open) { if (view) renderTiles(view) }  // fresh each open -> current membership
  else teardownTiles()                        // close -> stop the polls
}

// in the poll tick, after refreshing the index:
if (canvasOpen && !tilesBuilt) renderTiles(view) // opened-before-first-poll recovery
```

## Why This Works

An iframe's timers live in *its* document, not the parent's — so the only way to stop them from the parent is to remove the element (clearing `innerHTML` detaches it and unloads the document). Hiding is a visual operation, not a lifecycle one. Rebuilding fresh on each open (rather than latching) makes the canvas reflect current membership for free, since the parent already polls the membership list. The `canvasOpen && !tilesBuilt` check in the poll tick closes the early-toggle gap: whichever happens second — the toggle or the first data — triggers the build.

## Prevention

- **Embedded live sub-views must be unmounted, not hidden.** Any time a panel hosts `<iframe>`s, `<video>`, `WebSocket`s, or `setInterval`/`setTimeout`-chained pollers, closing it must remove those nodes. `display:none` keeps every background loop alive.
- **Never gate a one-time build on data that may not have arrived yet.** A `built && data` guard silently fails on early open. Pair it with a poll-tick fallback (`open && !built`) so the build fires whenever both conditions are eventually true.
- **Prefer "rebuild from latest" over "build once" for views derived from polled state.** A latch trades a tiny amount of rework for staleness bugs; rebuilding on open keeps the view honest against membership/data changes at no real cost.
- A DOM test pins it: open the canvas, assert N iframes; close it, assert **zero** iframes remain (`tests/uiCollection.test.ts`).
