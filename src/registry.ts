import type { ZodTypeAny } from "zod"
import type { RunCtx, NodeResult } from "./types"

export interface NodeType {
  type: string
  configSchema: ZodTypeAny
  run(ctx: RunCtx): Promise<NodeResult>
}

const registry = new Map<string, NodeType>()

export function registerNodeType(nt: NodeType): void {
  if (registry.has(nt.type)) {
    throw new Error(`node type already registered: ${nt.type}`)
  }
  registry.set(nt.type, nt)
}

export function getNodeType(type: string): NodeType {
  const nt = registry.get(type)
  if (!nt) throw new Error(`unknown node type: ${type}`)
  return nt
}

export function hasNodeType(type: string): boolean {
  return registry.has(type)
}

export function clearRegistry(): void {
  registry.clear()
}
