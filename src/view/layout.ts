import type { Chart } from "../types"

export interface NodeBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  boxes: Map<string, NodeBox>
  width: number
  height: number
  nodeW: number
  nodeH: number
}

const NODE_W = 150
const NODE_H = 60
const H_GAP = 60
const V_GAP = 70
const PAD = 40

function pushTo(map: Map<number, string[]>, key: number, val: string): void {
  const arr = map.get(key)
  if (arr) arr.push(val)
  else map.set(key, [val])
}

function rankNodes(chart: Chart): Map<string, number> {
  const incoming = new Map<string, number>()
  for (const n of chart.nodes) incoming.set(n.id, 0)
  for (const e of chart.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)

  const adj = new Map<string, string[]>()
  for (const e of chart.edges) {
    const a = adj.get(e.from)
    if (a) a.push(e.to)
    else adj.set(e.from, [e.to])
  }

  const rank = new Map<string, number>()
  const queue: string[] = []
  for (const n of chart.nodes) {
    if ((incoming.get(n.id) ?? 0) === 0) { rank.set(n.id, 0); queue.push(n.id) }
  }
  if (queue.length === 0 && chart.nodes.length > 0) {
    rank.set(chart.nodes[0].id, 0); queue.push(chart.nodes[0].id)
  }

  while (queue.length > 0) {
    const id = queue.shift()!
    const r = rank.get(id)!
    for (const to of adj.get(id) ?? []) {
      if (!rank.has(to)) { rank.set(to, r + 1); queue.push(to) }
    }
  }
  for (const n of chart.nodes) if (!rank.has(n.id)) rank.set(n.id, 0)
  return rank
}

export function layoutChart(chart: Chart): Layout {
  const rank = rankNodes(chart)

  const rows = new Map<number, string[]>()
  for (const n of chart.nodes) pushTo(rows, rank.get(n.id)!, n.id)

  const maxRank = Math.max(0, ...rank.values())
  const boxes = new Map<string, NodeBox>()
  let maxRowWidth = 0

  for (let r = 0; r <= maxRank; r++) {
    const ids = rows.get(r) ?? []
    const rowWidth = ids.length * NODE_W + Math.max(0, ids.length - 1) * H_GAP
    maxRowWidth = Math.max(maxRowWidth, rowWidth)
    ids.forEach((id, i) => {
      const node = chart.nodes.find((n) => n.id === id)!
      const autoX = PAD + i * (NODE_W + H_GAP)
      const autoY = PAD + r * (NODE_H + V_GAP)
      boxes.set(id, {
        id,
        x: node.position?.x ?? autoX,
        y: node.position?.y ?? autoY,
        w: NODE_W,
        h: NODE_H,
      })
    })
  }

  const width = PAD * 2 + Math.max(NODE_W, maxRowWidth)
  const height = PAD * 2 + (maxRank + 1) * NODE_H + maxRank * V_GAP
  return { boxes, width, height, nodeW: NODE_W, nodeH: NODE_H }
}
