// src/tinstar-plugin.tsx
import React, { useEffect, useRef, useState, useCallback } from "react";
var WHOACHART_BASE = "http://localhost:5330";
function parseChartName(url) {
  if (!url) return null;
  const m = url.match(/\/ui\/charts\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function makeWhoachartPane(api) {
  return function WhoachartPane() {
    const browser = api.primitives.useBrowser();
    const activeChart = parseChartName(browser.url);
    const nodeId = api.constellations.useMyNodeId();
    const proxyBase = `/api/proxy/${nodeId}`;
    const [charts, setCharts] = useState(null);
    const [down, setDown] = useState(null);
    const fetchCharts = useCallback(async () => {
      const r = await api.http.fetch(`${proxyBase}/api/charts`);
      if (!r.ok) throw new Error(`/api/charts ${r.status}`);
      return (await r.json()).charts;
    }, [proxyBase]);
    useEffect(() => {
      let cancelled = false;
      let inFlight = false;
      async function tick() {
        if (inFlight) return;
        inFlight = true;
        try {
          const next = await fetchCharts();
          if (!cancelled) {
            setCharts(next);
            setDown(null);
          }
        } catch (e) {
          if (!cancelled) setDown(e.message);
        } finally {
          inFlight = false;
        }
      }
      tick();
      const h = setInterval(tick, 2e3);
      return () => {
        cancelled = true;
        clearInterval(h);
      };
    }, [fetchCharts]);
    function openChart(name) {
      browser.navigate(`${WHOACHART_BASE}/ui/charts/${encodeURIComponent(name)}`);
    }
    const didAutoNav = useRef(false);
    useEffect(() => {
      if (didAutoNav.current || activeChart || !charts || charts.length === 0) return;
      didAutoNav.current = true;
      openChart(charts[0]);
    }, [activeChart, charts]);
    return /* @__PURE__ */ React.createElement("div", { "data-testid": "whoachart-pane", style: paneStyle }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600, marginBottom: 8 } }, "Whoachart"), down && /* @__PURE__ */ React.createElement("div", { "data-testid": "whoachart-down", style: errorStyle }, /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 4 } }, "Can't reach whoachart at ", /* @__PURE__ */ React.createElement("code", null, "localhost:5330"), "."), /* @__PURE__ */ React.createElement("div", { style: { opacity: 0.85, marginBottom: 4 } }, "Start it with:"), /* @__PURE__ */ React.createElement("pre", { style: commandStyle }, "cd ~/repo/whoachart && bun run src/main.ts")), !down && charts && charts.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { opacity: 0.7, fontSize: 12, lineHeight: 1.5 } }, "No charts registered. Drop a YAML in the charts dir or POST it to ", /* @__PURE__ */ React.createElement("code", null, "/api/charts"), "."), !down && charts && charts.map((name) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: name,
        onClick: () => openChart(name),
        style: name === activeChart ? activeChartStyle : chartStyle,
        "data-testid": `whoachart-open-${name}`
      },
      name
    )), !down && !charts && /* @__PURE__ */ React.createElement("div", { style: { opacity: 0.6, fontSize: 12 } }, "loading\u2026"));
  };
}
function activate(api) {
  api.logger.info("whoachart plugin activating");
  return [
    api.primitives.registerBrowserWidget({
      type: "whoachart-chart",
      defaultUrl: `${WHOACHART_BASE}/`,
      defaultSize: { width: 1100, height: 700 },
      minSize: { width: 560, height: 360 },
      accessory: { placement: "left", size: 180, component: makeWhoachartPane(api) }
    })
  ];
}
var paneStyle = {
  padding: 12,
  fontSize: 13,
  color: "#e5e7eb",
  background: "#111827",
  height: "100%",
  boxSizing: "border-box",
  overflowY: "auto"
};
var chartStyle = {
  display: "block",
  width: "100%",
  textAlign: "left",
  marginBottom: 4,
  background: "#1f2937",
  color: "#e5e7eb",
  border: "1px solid #374151",
  padding: "4px 10px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12
};
var activeChartStyle = {
  ...chartStyle,
  background: "#1e3a8a",
  borderColor: "#3b82f6",
  color: "#dbeafe"
};
var errorStyle = {
  padding: 8,
  background: "#7f1d1d",
  color: "#fecaca",
  borderRadius: 4,
  fontSize: 12,
  lineHeight: 1.4,
  marginBottom: 8
};
var commandStyle = {
  fontSize: 11,
  background: "#0b1220",
  color: "#e5e7eb",
  border: "1px solid #374151",
  borderRadius: 4,
  padding: 8,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  margin: 0
};
export {
  WHOACHART_BASE,
  activate,
  parseChartName
};
