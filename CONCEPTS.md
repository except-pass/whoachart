# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Relationships

A Chart owns its Nodes and Edges. A Marble flows through one Chart, entering at a source Node and traversing one Edge at a time until it reaches an end. Hooks, Triggers, and a Supervisor are chart-level concerns: Triggers create Marbles, Hooks observe a Marble's lifecycle, and a Supervisor oversees the Chart's runs.

## Chart structure

### Chart
A whoachart pipeline declared as YAML — a set of Nodes connected by Edges, plus optional chart-level Triggers, Hooks, and a Supervisor. Each Chart renders as a live, visual node-graph that animates Marbles moving through it.

### Node
A single step in a Chart. A Node does real work when a Marble enters it — running a command, branching on a decision, or marking the Chart's entry or exit. Nodes connect to other Nodes through Edges.

### Edge
A directed, optionally-named connection from one Node to another. When a Marble leaves a Node it traverses exactly one outgoing Edge; a decision Node picks the Edge by name, routing the Marble down one branch.

## Work in flight

### Marble
A unit of work that flows through a Chart. A Marble is submitted with a context payload, enters at a source Node, and rolls Node-to-Node along Edges as each step runs and routes it onward.

A Marble carries context that steps merge into as it advances, and moves through the Marble status lifecycle below. It fires the Chart's Hooks as it crosses lifecycle events but is never redirected by them.

### Marble status
The lifecycle state of a Marble: *queued* (awaiting its next step), *running* (a step is executing), *blocked* (paused at a gate, awaiting an external signal to resume), *done* (reached an end successfully), or *failed* (a step errored or could not route).

## Chart-level automation

### Hook
A chart-level shell command that fires as a pure observer when a Marble crosses a lifecycle event — entering or leaving a Node, traversing an Edge, or the Chart starting, blocking, failing, or ending. A Hook receives the event and the Marble's context but its exit code never changes the Marble's path; it is observational, fire-and-forget, and bounded by a timeout.

### Trigger
A chart-level rule that creates a Marble automatically — on a schedule (cron or interval) or in response to an inbound webhook — rather than waiting for a manual submission. Triggers fire forward-only: ticks missed while the daemon was down are not replayed.

### Supervisor
An optional long-lived agent session that oversees one Chart's runs. A Supervisor acts only on the gates it is permitted to decide, leaving the rest for a human; the permission marker is advisory (honored by the agent's brief), not enforced where the decision is applied.
