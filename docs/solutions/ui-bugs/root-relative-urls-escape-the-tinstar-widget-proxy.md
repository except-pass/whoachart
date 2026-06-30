---
module: collection-view
date: 2026-06-30
problem_type: ui_bug
component: frontend_stimulus
severity: high
symptoms:
  - "Toggling the collection combined-canvas spun up ~12 copies of the Tinstar canvas (\"Infinite Canvas\") booting at once, crawling the machine"
  - "The embedded tiles loaded the Tinstar SPA, not whoachart chart pages — what the user saw was N nested Tinstars, not N whoacharts"
  - "Symptom only appears when the page is viewed INSIDE a Tinstar browser widget; served directly at localhost:5330 it worked fine"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - frontend_stimulus
tags:
  - tinstar-widget-proxy
  - root-relative-url
  - spa-fallback
  - iframe-src
  - proxy-escape
  - whoachart-ui
---

# Root-relative URLs in embedded whoachart pages escape the Tinstar widget proxy and boot the Tinstar SPA

*Found in production on the live Tinstar canvas, immediately after shipping chart collections. whoachart, `src/ui/public/collection.js` (the combined-canvas tiles + member-card links). Related: [tiled live-view iframes keep polling when hidden](tiled-live-view-iframes-keep-polling-when-hidden.md) — a different bug in the same canvas feature.*

## Problem

A whoachart UI page is served two ways: **directly** (`http://localhost:5330/ui/...`) and **inside a Tinstar browser widget**, where Tinstar serves it through its own proxy on the **Tinstar origin** (`localhost:5273/api/proxy/<wid>/...`). Any **root-relative** URL (`/ui/charts/foo`) in that page resolves against whatever origin the document is on — and inside the proxy that is the *Tinstar* origin, not whoachart. Tinstar's SPA **falls back to its canvas app for every unknown path**, so a root-relative link or iframe does not 404 — it loads a full copy of the Tinstar "Infinite Canvas." The collection canvas tiled 12 such iframes, so one toggle booted 12 nested Tinstars and melted the browser.

## Symptoms

- Opening the combined canvas inside Tinstar spawned ~12 Tinstar-canvas instances booting simultaneously; the machine crawled.
- The tiles were Tinstar, not whoachart — `curl localhost:5273/ui/charts/prod-health-sweep` returns `<title>Tinstar — Infinite Canvas</title>` / `<div id="root">` (SPA fallback), confirming any unknown path on the Tinstar origin serves the canvas app.
- Served **directly** (`localhost:5330/ui/collections/srena`) the same page worked — the root-relative URL happened to resolve to the right origin, so the bug was invisible outside the proxy.

## What Didn't Work

The first instinct (and the first explanation given) was that the crawl came from **12 heavy whoachart chart apps** polling at once — a scaling problem with iframe-tiling. That was wrong: the user reported seeing *Tinstar* canvases, not whoacharts. The real failure was URL resolution under the proxy, not render cost. A 10-agent code review also missed it because every reviewer reasoned about the page served directly / about iframe lifecycle — **none tested it inside the Tinstar widget proxy**, which is the only context where the bug fires.

## Solution

Use **relative** URLs, never root-relative, in any whoachart page that can be embedded in Tinstar — exactly the rule `src/ui/page.ts` already follows for its `<script src="../app.js">` (and documents in a comment). From `/ui/collections/:name`, `../charts/:name` resolves to `/ui/charts/:name` when direct and stays inside the proxy when embedded:

```js
// WRONG — root-relative escapes the proxy to the Tinstar origin -> SPA fallback -> Tinstar canvas
`<iframe src="/ui/charts/${encodeURIComponent(m.name)}">`
`<a class="card" href="/ui/charts/${encodeURIComponent(m.name)}">`

// RIGHT — relative, stays on whoachart's origin both direct and proxied
`<iframe src="../charts/${encodeURIComponent(m.name)}">`
`<a class="card" href="../charts/${encodeURIComponent(m.name)}">`
```

## Why This Works

Inside the proxy the document lives at `…/api/proxy/<wid>/ui/collections/srena`; a relative `../charts/foo` resolves to `…/api/proxy/<wid>/ui/charts/foo`, staying on the Tinstar origin **but under the proxy path**, which forwards to whoachart. Served directly at `localhost:5330/ui/collections/srena`, the same `../charts/foo` resolves to `localhost:5330/ui/charts/foo`. Root-relative `/ui/charts/foo` instead anchors at the origin root — fine direct, fatal proxied, because it drops the `/api/proxy/<wid>` prefix and hits Tinstar's own SPA.

## Prevention

- **Never use root-relative (`/…`) URLs in a page that can be served through the Tinstar widget proxy** — links, iframe/img/script srcs, fetch paths. Use relative paths anchored at the page's own location. `src/ui/page.ts` documents this for `<script>`; the rule applies to **every** URL the page emits.
- **A whoachart page that hosts iframes/links is far more dangerous than one that only fetches** — a bad fetch path 404s loudly; a bad navigational URL hits the Tinstar SPA fallback and *silently boots the whole canvas*, which looks like success until it multiplies.
- **Test embedded, not just direct.** A reviewer or test that only loads `localhost:5330/ui/...` will never see this class of bug. Add a unit assertion that emitted URLs are relative (`not startsWith("/")`) — see `tests/uiCollection.test.ts` "Tinstar-proxy regression."
- **When an SPA is the fallback for unknown paths, "it loaded something" is not "it loaded the right thing."** A 200 from the wrong origin is worse than a 404.
