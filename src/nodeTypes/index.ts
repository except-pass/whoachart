import { registerNodeType } from "../registry"
import { endNode } from "./end"
import { sourceNode } from "./source"
import { shellNode } from "./shell"
import { decisionNode } from "./decision"
import { apiNode } from "./api"

export function registerBuiltins(): void {
  registerNodeType(sourceNode)
  registerNodeType(shellNode)
  registerNodeType(decisionNode)
  registerNodeType(apiNode)
  registerNodeType(endNode)
}
