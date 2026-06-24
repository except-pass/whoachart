import { registerNodeType, hasNodeType } from "../registry"
import { endNode } from "./end"
import { sourceNode } from "./source"
import { shellNode } from "./shell"
import { decisionNode } from "./decision"
import { apiNode } from "./api"
import { humanNode } from "./human"

// Idempotent: registering the builtins a second time is a no-op, not a crash.
// The daemon already assumes this (`if (!hasNodeType("end")) registerBuiltins()`),
// and some tests call it unguarded — so guarding each registration here removes
// a whole class of order-dependent "already registered" failures. registerNodeType
// still throws for genuine duplicate CUSTOM types.
export function registerBuiltins(): void {
  for (const nt of [sourceNode, shellNode, decisionNode, apiNode, endNode, humanNode]) {
    if (!hasNodeType(nt.type)) registerNodeType(nt)
  }
}
