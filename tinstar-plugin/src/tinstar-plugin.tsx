import React, { useEffect, useRef, useState, useCallback } from 'react'
import type { TinstarPluginAPI } from '@tinstar/plugin-api'

/** Where the whoachart daemon lives. The embedded browser navigates here
 *  directly; the accessory's API calls go through the Tinstar same-origin
 *  proxy instead (see WhoachartPane), so this only needs to be reachable
 *  from the Tinstar server, not from the viewer's machine. */
export const WHOACHART_BASE = 'http://localhost:5330'

/** Extracts the chart name from a browser URL like
 *  `http://localhost:5330/ui/charts/<name>`. Returns null otherwise. Pure. */
export function parseChartName(url: string | undefined | null): string | null {
  if (!url) return null
  const m = url.match(/\/ui\/charts\/([^/?#]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

function makeWhoachartPane(api: TinstarPluginAPI) {
  return function WhoachartPane() {
    const browser = api.primitives.useBrowser()
    const activeChart = parseChartName(browser.url)

    // Fetch whoachart via the Tinstar same-origin proxy, NOT raw localhost:5330
    // (unreachable when Tinstar is viewed remotely). Tinstar resolves the proxy
    // target from this widget's _browser.url origin and fetches it server-side.
    const nodeId = api.constellations.useMyNodeId()
    const proxyBase = `/api/proxy/${nodeId}`

    const [charts, setCharts] = useState<string[] | null>(null)
    const [down, setDown] = useState<string | null>(null)
    const fetchCharts = useCallback(async () => {
      const r = await api.http.fetch(`${proxyBase}/api/charts`)
      if (!r.ok) throw new Error(`/api/charts ${r.status}`)
      return (await r.json() as { charts: string[] }).charts
    }, [proxyBase])

    useEffect(() => {
      let cancelled = false
      let inFlight = false
      async function tick() {
        if (inFlight) return
        inFlight = true
        try {
          const next = await fetchCharts()
          if (!cancelled) { setCharts(next); setDown(null) }
        } catch (e) {
          if (!cancelled) setDown((e as Error).message)
        } finally { inFlight = false }
      }
      tick()
      const h = setInterval(tick, 2000)
      return () => { cancelled = true; clearInterval(h) }
    }, [fetchCharts])

    function openChart(name: string) {
      browser.navigate(`${WHOACHART_BASE}/ui/charts/${encodeURIComponent(name)}`)
    }

    // A freshly spawned widget sits at the daemon root (a 404). As soon as we
    // know the chart list, open the first chart. Fire once so we never yank a
    // user who navigated away on purpose.
    const didAutoNav = useRef(false)
    useEffect(() => {
      if (didAutoNav.current || activeChart || !charts || charts.length === 0) return
      didAutoNav.current = true
      openChart(charts[0])
    }, [activeChart, charts])

    return (
      <div data-testid="whoachart-pane" style={paneStyle}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Whoachart</div>
        {down && (
          <div data-testid="whoachart-down" style={errorStyle}>
            <div style={{ marginBottom: 4 }}>
              Can't reach whoachart at <code>localhost:5330</code>.
            </div>
            <div style={{ opacity: 0.85, marginBottom: 4 }}>Start it with:</div>
            <pre style={commandStyle}>cd ~/repo/whoachart && bun run src/main.ts</pre>
          </div>
        )}
        {!down && charts && charts.length === 0 && (
          <div style={{ opacity: 0.7, fontSize: 12, lineHeight: 1.5 }}>
            No charts registered. Drop a YAML in the charts dir or
            POST it to <code>/api/charts</code>.
          </div>
        )}
        {!down && charts && charts.map(name => (
          <button
            key={name}
            onClick={() => openChart(name)}
            style={name === activeChart ? activeChartStyle : chartStyle}
            data-testid={`whoachart-open-${name}`}
          >
            {name}
          </button>
        ))}
        {!down && !charts && <div style={{ opacity: 0.6, fontSize: 12 }}>loading…</div>}
      </div>
    )
  }
}

export function activate(api: TinstarPluginAPI) {
  api.logger.info('whoachart plugin activating')
  return [
    api.primitives.registerBrowserWidget({
      type: 'whoachart-chart',
      defaultUrl: `${WHOACHART_BASE}/`,
      defaultSize: { width: 1100, height: 700 },
      minSize: { width: 560, height: 360 },
      accessory: { placement: 'left', size: 180, component: makeWhoachartPane(api) },
    }),
  ]
}

const paneStyle: React.CSSProperties = {
  padding: 12, fontSize: 13, color: '#e5e7eb',
  background: '#111827', height: '100%', boxSizing: 'border-box', overflowY: 'auto',
}
const chartStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', marginBottom: 4,
  background: '#1f2937', color: '#e5e7eb', border: '1px solid #374151',
  padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}
const activeChartStyle: React.CSSProperties = {
  ...chartStyle, background: '#1e3a8a', borderColor: '#3b82f6', color: '#dbeafe',
}
const errorStyle: React.CSSProperties = {
  padding: 8, background: '#7f1d1d', color: '#fecaca',
  borderRadius: 4, fontSize: 12, lineHeight: 1.4, marginBottom: 8,
}
const commandStyle: React.CSSProperties = {
  fontSize: 11, background: '#0b1220', color: '#e5e7eb',
  border: '1px solid #374151', borderRadius: 4, padding: 8,
  whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0,
}
