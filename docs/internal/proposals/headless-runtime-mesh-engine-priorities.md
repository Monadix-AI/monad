---
title: "Remaining Headless Runtime and Mesh Engine Priorities"
audience: "internal-developer"
description: "Propose the implementation order for strengthening Monad's headless runtime and managed Mesh execution engine."
tag: "Draft"
noindex: "true"
---
Status: **Proposed**

Last reviewed: 2026-08-01

P0 and P1 are implemented. Their contracts live in
[headless runtime contract](../../internals/infra/headless-runtime-contract.md) and
[Workplace Experiences](../../internals/agent-team-runtime/workplace-experiences.md); this
proposal keeps only what is still open.

Implementation still requires a separately reviewed design/plan identifying exact
contracts, migrations, regression evidence, and rollback boundaries. Nothing in P2
authorizes code.

## Invariants inherited from P0

- The daemon owns runtime behavior and durable state; clients and Experiences are
  projections.
- One accepted human-facing client acts for the same implicit local Operator.
- `OperationSource` is provenance, not an authorization identity.
- Public runtime contracts live in `@monad/protocol`; consumers derive rather than
  redeclare them.
- Every accepted runtime input is validated at its boundary.
- The current Mesh is one daemon, one machine, and a shared local filesystem.
- Projects coordinate Agents through Project Members and Session Bindings. They do not
  become workflow schedulers.

## Remaining Experience gaps

The P1 trusted-Experience contract shipped; see
[Workplace Experiences](../../internals/agent-team-runtime/workplace-experiences.md). Two
loose ends were never closed:

- **The browser-module contract does not exclude the client cache layer.**
  `checkExperienceBrowserChunk` rejects `node:`/`bun:` builtins, daemon-side `@monad/*`
  packages, `#/` host aliases, and React — but not `@monad/client-rtk`, so an experience can
  still bundle the host's Redux layer instead of consuming the published contract. One more
  rule closes it.
- **"Lifecycle metadata" on the Experience definition was never defined.** The original
  contract said one definition binds identity, entries, and lifecycle metadata; the schema
  binds everything but the last, and no design ever said what it should hold. Define it or
  drop the phrase.

## P2 — Distributed Agent Runtime design backlog

P2 remains future design work and authorizes no implementation.

Directional constraints:

- Project collaboration coordinates Agents; it does not provide an Agent Runtime or
  model a daemon, Gateway, Node, Provider, client, channel, or human as a member.
- A future Gateway owns Monad Agent loops, model calls, tool orchestration, approvals,
  and routing.
- A future Node is a Gateway-owned capability provider for terminal, filesystem, MCP,
  and device-local operations. It does not own an Agent loop.
- `RemoteDaemon` may later expose Agents to another daemon. Collaboration references the
  supplied Agents/Project Members, not the remote daemon as a participant.
- Tailscale, relay, or another network mechanism is connectivity plumbing. Monad still
  owns pairing, RPC, capability negotiation, approvals, and audit.
- Existing project-session fanout remains the routing baseline unless a future design
  explicitly replaces it.

Separate future specifications are required for:

- Gateway/Node RPC and capability negotiation;
- device identity, pairing, revocation, and key rotation;
- NAT traversal, relay, reconnect, and network partitions;
- remote capability invocation and approval;
- cross-machine data/artifact transfer;
- mutable Workspace synchronization and conflict handling;
- RemoteDaemon Agent discovery;
- cross-owner federation.

## Active decision log

| Date | Decision |
|---|---|
| 2026-07-16 | Restrict P1 to built-in/local/explicitly reviewed trusted Experiences using in-process React plus optional Elysia; defer third-party isolation. |
| 2026-07-16 | Keep P2 as a distributed Agent Runtime design backlog rather than part of the active local collaboration implementation. |
| 2026-07-16 | Future distributed collaboration starts from `RemoteDaemon -> Agents`; do not introduce a first-class Peer participant. |
| 2026-07-31 | Move verified P0 contracts to internals and keep this proposal limited to work not yet implemented. |
| 2026-08-01 | Move the shipped P1 Experience contract to internals on the same rule, leaving only the two gaps it never closed. |
| 2026-07-31 | Enforce the Experience action surface from manifest permissions at a single Web host chokepoint; deny by throwing stub rather than omitting the action. |
| 2026-07-31 | Derive per-pack acceptance for the Experience kind from install evidence rather than storing a trust flag; treat a recorded integrity hash, not an immutable ref, as the pinning requirement for remote sources. |
| 2026-07-31 | Make the rediscovery sweep build-then-swap into a candidate registry instead of clearing live registries up front, and drain experience workers on rebind. |
| 2026-08-01 | Express operator review of the Experience kind as an allow/deny policy in `config.json`, where `allow` is a per-pack human review that waives short install evidence and `deny` always wins. |
| 2026-08-01 | Give atom packs an optional `deactivate()` for resources the host cannot reclaim, called after swap and drain, keyed by pack identity so it runs once. |
| 2026-08-01 | Restrict React Host Components to first-party Experiences and make every third-party Experience a Web Component, dropping the official builder in favour of daemon-side artifact validation. |
| 2026-08-01 | Classify host Experience failures structurally and offer retry only where a retry can change the outcome; contain render failures in a boundary that resets on selection change. |
