---
title: "Headless Runtime Contract"
description: "Monad is a daemon-first Agent Team Runtime with headless architecture. The daemon owns team behavior and durable state. Web, CLI, TUI, Agent Client."
---
Monad is a daemon-first Agent Team Runtime with headless architecture. The daemon owns team behavior and durable state. Web, CLI, TUI, Agent Client Protocol, channels, agent runtimes, and other clients use public contracts without becoming authoritative. Monad Mesh is the agent team runtime those contracts expose, and Monad Agent Runtime is the first-party agent runtime behind them.

P0 of the Headless Runtime and Mesh Engine program was verified on 2026-07-30 by
`1043d610e`. This document retains the shipped invariants from that program. The Experience
contract shipped separately and lives in
[`workplace-experiences.md`](/internals/agent-team-runtime/workplace-experiences). Distributed scheduling remains outside the shipped contract described here.

## Runtime authority

- One accepted human-facing client acts for the same implicit local Operator. The
  runtime does not infer Principal, User, Owner, tenant, or per-client RBAC from the
  client surface.
- `OperationSource` is immutable provenance and routing context, not an authorization
  identity. See [operation-source.md](/internals/agent-runtime/operation-source).
- Method exposure defines which transports reach a method and which connections are admitted.
  It is connection-level admission, not domain permission. `METHOD_TABLE` decides
  reachability; it never decides what an Operator is allowed to do.
- Workspace Experiences project daemon-owned state in the Web UI. They do not own
  Agents, Project Members, Sessions, approvals, Plans, or collaboration history.
- Protocol/domain contracts have one producer in `@monad/protocol`; public clients
  derive from those contracts instead of importing daemon internals.
- Every boundary parses untrusted input. Atom packs, model output, provider records,
  tool arguments, and persisted data are not trusted merely because they are local.

The verified topology is one daemon, one machine, and multiple Agents supplied by
different Mesh Agent Providers over a shared local filesystem Workspace. It is not a
distributed scheduler or cross-machine runtime.

## Public contract catalog

Every mounted daemon route has one semantic owner:

```text
METHOD_TABLE + RUNTIME_STREAMS + adapter/resource/presentation registries
  -> exhaustive binding catalog
  -> Bootstrap / Runtime / Admin / Internal views
```

Bindings are categorized by `owner`: Method, Stream, Protocol Adapter, Resource,
Extension Gateway, Presentation, or Development. Each registry pins its owner at the
type level, and `binding-catalog.test.ts` rejects a mounted route that is not cataloged.
The registries live in
[`packages/protocol/src/rpc/runtime-streams.ts`](https://github.com/Monadix-AI/monad/blob/main/packages/protocol/src/rpc/runtime-streams.ts)
and [`route-owners.ts`](https://github.com/Monadix-AI/monad/blob/main/packages/protocol/src/rpc/route-owners.ts).

The `capability` tags carried by those bindings today are:

- `agent.generation`
- `runtime.events`
- `session.events`
- `session.presentation`
- `oversight.interaction`
- `runtime.adapter`
- `runtime.resource`
- `extension.gateway`
- `development`

They partition the surface by *kind* of binding, not yet by product domain. A finer
split (discovery, agent/session management, tool approval, admin configuration) is
future work, not a shipped contract. Cataloged bindings stay experimental until
promoted explicitly.

## Error, event, and retry boundaries

- Public failures use bounded `PublicErrorDescriptor` values. Agent execution failure
  terminates through canonical `session.message.failed`; there is no competing
  catch-all `agent.error`.
- Message Ingress owns durable message writes. Control, per-message generation, UI
  projection, and Mesh Agent observation are separate planes with their own payload,
  replay, and retention contracts.
- Generation reconnect uses event IDs and authoritative message snapshots. Session
  event/UI replay may use scope-bound opaque cursors. Unrelated planes do not share one
  universal cursor grammar.
- Mutating Methods accept request IDs. The bounded in-memory idempotency service
  deduplicates retries within one daemon lifetime; restart intentionally resets it.
- Shared mutable records use explicit expected-version compare-and-swap where lost
  updates are possible. Idempotency and optimistic concurrency solve different
  problems.

See [realtime-channels.md](/internals/infra/realtime-channels) and
[mesh-observation.md](/internals/agent-team-runtime/mesh-observation).

## Collaboration identity and recovery

The durable identity chain is:

```text
Profile -> ProjectMember -> SessionBinding -> native runtime session
```

Project Member identity outlives replaceable provider runtime sessions. Each
SessionBinding owns its own delivery/visibility cursors, current runtime reference,
participation lifecycle, and health. Message fanout creates durable Delivery records;
it is not task dispatch. Restart reconciliation resumes or replaces runtimes without
duplicating consumed deliveries.

See [project-sessions.md](/internals/agent-team-runtime/project-sessions).

## Optional Session Plan

A Session Plan is a lightweight shared Todo list, created lazily on the first mutation.
A Session that never uses it has no Plan record and loses no capability.

Each Todo has session ownership, text, explicit
`pending | in_progress | completed` status, optional Project Member assignee, version,
writer attribution, and timestamps.

- Humans and Agents state status explicitly; the daemon does not infer completion from
  process exit.
- Assignment does not start, wake, retry, or reassign an Agent.
- Per-Todo CAS allows unrelated Todos to change concurrently.
- Request-ID idempotency prevents duplicate Todos on retry.
- Changes emit Session-scoped events but never become scheduler triggers.
- Approval remains attached to the concrete tool/external action, not a Todo state.
- CLI, Web, TUI, and the agent-facing MCP server project the same daemon contract.

There is no Project-global Plan, Task DAG, TaskAttempt, autonomous assignment, work
stealing, scheduler lease, or heartbeat domain.

## Headless setup

The daemon starts without a configured model provider and exposes the minimum Admin
setup chain. Availability is reported per capability; there is no global Init gate.
Post-start configuration changes go through Admin Methods. Secrets enter through stdin
or control-access methods and never appear in argv, logs, structured output, or public
errors. Local `config path` and `config edit` remain explicit maintenance exceptions.

## Verification boundary

The verified P0 slice covers:

- no-Web discovery, setup, session operation, event observation, interactions, and
  approvals;
- one project with members backed by different providers collaborating in one project
  session over the shared Workspace;
- restart reconciliation without duplicate delivery;
- optional Plan mutations with CAS, idempotency, attribution, and no agent wakeup;
- equivalent supported behavior over TCP loopback and Unix socket;
- UI-stream resume, stale-cursor replacement, slow-consumer isolation, and
  order-independent settled-message projection.
