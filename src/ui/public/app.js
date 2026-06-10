// v0 client: proves the def/state pipeline end-to-end by rendering live JSON.
// Plan B replaces this file with the full control surface.
const chart = globalThis.WHOACHART.chart
const app = document.getElementById("app")

async function refresh() {
  try {
    const [def, state] = await Promise.all([
      fetch(`/api/charts/${chart}/def`).then((r) => r.json()),
      fetch(`/api/charts/${chart}/state`, { cache: "no-store" }).then((r) => r.json()),
    ])
    app.textContent = JSON.stringify({ def: { nodes: def.nodes.length, edges: def.edges.length }, state }, null, 2)
  } catch (err) {
    app.textContent = `unreachable: ${err}`
  }
}
setInterval(refresh, 1000)
refresh()
