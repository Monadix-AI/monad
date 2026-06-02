---
title: "What Monad Is"
sidebarTitle: "Product"
description: "Learn what Monad owns as a daemon-first agent team runtime and where its product boundaries sit."
keywords: ["agent team runtime", "daemon-first", "headless architecture", "progressive autonomy"]
---

# Product

{/* impeccable:product-schema 1 */}

## Platform

web

## Users

Monad is primarily for individual developers who want to build, run, and supervise a persistent team of agents from their own machine. They may use different model providers and agent runtimes for coding, research, operations, or content work, but they need one durable place to manage the team instead of treating each client or provider as a separate workspace.

## Product Purpose

Monad is a daemon-first agent team runtime with a headless architecture. It keeps a team available, preserves its work, applies policy, and lets a developer operate the same state through different clients.

Success means a developer can assemble the right agents, give each one a stable identity and bounded capabilities, continue work across client closures and reconnects, observe what the team is doing, and increase autonomy without giving up control or migrating work between provider-specific silos.

## Positioning

Monad combines three product distinctions that must remain visible together:

- **Daemon-owned continuity:** the long-lived `monad` daemon, rather than a UI or model provider, owns identity, capabilities, permissions, sessions, collaboration state, approvals, and audit history.
- **Provider-neutral teams:** Monad Mesh admits third-party agent providers, Agent Client Protocol (ACP) agents, peer daemons, and Monad's own first-party agent runtime into one team, each retaining its provider-specific execution behavior.
- **Local-first governance:** Monad-owned state stays on the developer's machine by default, with sandboxing, observation, approval gates, and explicit capability boundaries supporting progressive autonomy.
- **One daemon, not a platform:** the product installs as a single binary and runs as one local process. It requires no cluster, message server, gateway, or object store, which keeps the runtime available to an individual developer rather than to a team with platform infrastructure.

A neighboring product cannot truthfully copy this position merely by presenting multiple chat tabs or model choices. The durable team, policy, session bindings, and shared state belong to Monad Mesh independently of any client or agent runtime.

## Operating Context

A developer typically runs Monad on a local development machine and works through the Web UI, command-line interface (CLI), terminal user interface (TUI), editor integrations, APIs, or messaging channels. These clients present controls suited to their surface while operating the same daemon-owned state.

A common workflow is:

1. Configure model providers, external runtimes, tools, sandboxes, and approval policy.
2. Create a Project and one or more Sessions for an ongoing body of work.
3. Add reusable Project members or spawn a member that exists only in one Session.
4. Direct work, inspect activity, respond to approvals or clarification, and preserve outcomes.
5. Close or change clients and later resume from the same durable team state.

Monad is local-first, not offline-only. Requests to configured model providers follow the network and credential settings the developer chooses.

## Capabilities and Constraints

The `monad` daemon is the product's long-lived authority. It currently provides persistent sessions, Project collaboration, identity and capability controls, external-runtime hosting, ACP delegation, peer federation, approval gates, activity records, observation, recovery, and Workplace Experience extensions.

Monad Mesh is the Agent Team Runtime the daemon exposes and the product's primary capability. It coordinates first-party and external agents through durable membership, session bindings, shared work, observation, approvals, and recovery. Every other capability is described in terms of what it contributes to a mesh.

Monad Agent Runtime is Monad's first-party agent runtime and the default mesh member. It supplies the model and tool loop, context management, memory, approval-aware tool execution, and sandbox integration. It is an attached capability, not the product boundary: a mesh can be assembled entirely from third-party agent providers, ACP agents, or peer daemons.

Web Workplace Experiences are projections of daemon-owned agents, tasks, artifacts, approvals, and collaboration state. They may reorganize a browser workflow, but they must not become the only place a cross-client runtime capability exists.

Product boundaries remain explicit:

- Replaceable clients must not become owners of team state.
- Provider adapters perform provider-specific execution; the daemon owns membership, session binding, observation, policy, and collaboration state.
- Platform-specific behavior stays behind a uniform interface rather than leaking across the product.
- Agent-reachable prompts, tools, atom packs, MCP servers, skills, channel payloads, and persisted state are treated as hostile inputs.
- Peer federation covers machines owned by the same operator. Cross-owner identity and trust remain Monadix territory.
- Current capabilities do not imply arbitrary distributed scheduling or a universal task and artifact schema.

## Brand Commitments

The product name is **Monad**. **Monad Mesh** names its Agent Team Runtime, and **Monad Agent Runtime** names its bundled first-party agent runtime — one mesh member, never a synonym for the product. **Monadix** names the separate cross-owner collaboration boundary and must not be used as a synonym for Monad or Monad Mesh.

Product language is direct, technical, and specific about ownership and boundaries. Terms such as daemon, Project, Session, member, provider, third-party agent, ACP, approval, observation, and Workplace Experience have defined meanings and should not be replaced with looser chat-product terminology.

## Evidence on Hand

The repository contains working source and test evidence for the product's current capabilities:

- `apps/monad` implements the daemon, stores, handlers, transports, agent loop, providers, channels, policy, and observability.
- `apps/web`, `apps/cli`, and `apps/tui` demonstrate replaceable clients over shared runtime state.
- `packages/protocol` defines the wire and domain contracts shared across clients and runtime layers.
- `docs/concepts.md`, `docs/internals/infra/runtime.md`, and the usage guides document the product vocabulary and operational model.
- Unit and end-to-end tests cover daemon behavior, Web flows, and transport parity.

The repository does not currently provide confirmed customer testimonials, public adoption benchmarks, pricing claims, or independent comparative studies. Future product work must not fabricate them.

## Product Principles

1. **The daemon owns the team.** Identity, policy, continuity, and collaboration state survive any one client or provider.
2. **One developer can compose the right team.** First-party and external runtimes participate without forcing work into provider-specific silos.
3. **Autonomy grows with control.** Stable identity, bounded capabilities, sandboxing, observation, approvals, and recovery make additional autonomy understandable and reversible.
4. **Clients project shared truth.** Web, CLI, TUI, editors, APIs, and messaging channels may differ in interaction but must operate the same canonical state.
5. **Boundaries stay explicit.** Local ownership, security containment, protocol contracts, and the distinction between Monad and Monadix are product behavior, not implementation trivia.

## Read next

- [Product concepts](/concepts) define the shared vocabulary.
- [Getting started](/getting-started) takes a developer from installation to a working Session.
- [Usage guides](/usage/index) explain operational tasks.
- [Developer architecture](/internals/index) explains contracts and implementation boundaries.
- [Product principles](/design/product-principles) record internal design and brand constraints.
