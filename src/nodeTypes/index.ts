import { registerNodeType } from "../registry"
import { endNode } from "./end"
import { sourceNode } from "./source"
import { shellNode } from "./shell"
import { decisionNode } from "./decision"
import { apiNode } from "./api"
import { humanNode } from "./human"

export function registerBuiltins(): void {
  registerNodeType(sourceNode)
  registerNodeType(shellNode)
  registerNodeType(decisionNode)
  registerNodeType(apiNode)
  registerNodeType(endNode)
  registerNodeType(humanNode)
}
