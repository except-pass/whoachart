# AGENTS.md

whoachart turns a YAML **chart** into a live, visual pipeline: you define **nodes** connected by **edges**, drop a **marble** (a unit of work) in at a source, and the daemon animates that marble rolling through the node-graph as each node runs and routes it onward. A small [Bun](https://bun.sh) daemon serves each chart as a browser widget (it pairs with Tinstar, but stands alone).

Use the project's own words for things — see **`CONCEPTS.md`** for the domain vocabulary (Chart, Node, Edge, Marble, Marble status, Hook, Trigger, Supervisor).

## Stack & commands

- **Runtime:** Bun (CI pins `1.3.11`). TypeScript, `strict`, ESM, no build step.
- **Test:** `bun test` — tests live in `tests/`, colocated by subject.
- **Typecheck:** `bunx tsc --noEmit`. CI (`.github/workflows/ci.yml`) runs this **and** `bun test`; both must be green.
- **Run the daemon:** `bun start` (serves `./examples` on `:5330`, prints a UI link per chart). CLI entry: `src/cli.ts` (the `whoachart` bin).
- No linter/formatter is configured — **match the surrounding code's style.**

## Where things live (`src/`)

| Path | Responsibility |
|------|----------------|
| `engine.ts` | the marble-flow engine — `step()` loop, edge routing, hook dispatch, `drain`/`signal`/`retry` |
| `daemon.ts` | HTTP control plane — runtimes, hot-reload, `/def`, widgets, triggers/supervisor wiring |
| `context.ts` | shell execution (`runShell`, `runHookCommand`) — env, JSON-stdin payload, live output streaming |
| `schema.ts` / `types.ts` | chart YAML parse + validate (zod) and the core types |
| `nodeTypes/` | node-type registry: `source`, `shell`, `decision`, `api`, `human`, `end`, `agent` |
| `lint.ts` | advisory static analysis (warnings; never blocks a register) |
| `store.ts` | marble persistence (disk is authoritative) |
| `cron.ts` · `scheduler.ts` · `supervisor.ts` | automation: triggers + supervisor sessions |
| `ui/` | the web UI — server-rendered shell (`page.ts`) + framework-free vanilla JS (`public/*.js`) |
| `view/` | `viewState`, `logBuffer`, `layout` (in-memory state the UI polls) |

## Conventions & invariants

- **Comments explain WHY.** The codebase is densely commented with the rationale and the non-obvious failure mode each line guards against. Match that bar; don't strip it.
- **Validate user config at parse time** (`parseChart`), not at runtime-arm time — a bad value must be rejected before any runtime swap, not throw later inside a timer/callback.
- **Hot-reload safety:** the marble store on disk is authoritative; the engine quiesces via `stop()` before a chart is swapped. Anything fired off the critical path (hooks, triggers) must be exception-safe and must not wedge a quiesce.
- **Trust surface:** loopback + Tailscale only. `/def` redacts secret-bearing config and never exposes a hook's `run` command; raw shell/hook stdout is **not** redacted — safe only on this surface. Revisit before multi-user.
- **Tests** build charts inline and drive a real `Engine`/`Daemon` rather than mocking. Cover the failure shape, not just the happy path.

## Documentation & knowledge store

- **`CONCEPTS.md`** (repo root) — shared domain vocabulary; relevant when orienting to the codebase or discussing domain concepts.
- **`docs/solutions/`** — documented solutions to past problems (bugs, best practices, architecture patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in a documented area — e.g. the subprocess-timeout gotcha under `performance-issues/` and the hot-reloadable-daemon patterns under `architecture-patterns/`.
- **`docs/plans/`** and **`docs/brainstorms/`** — implementation plans and requirements docs (decision artifacts; expected to go stale once a feature ships).
- **`README.md`** — user-facing overview, chart YAML reference, and environment variables.
