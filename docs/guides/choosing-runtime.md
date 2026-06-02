---
title: "Choose an Agent Runtime for a Mesh Member"
sidebarTitle: "Choose a Runtime"
description: "Choose which agent runtime backs a Monad Mesh member: Monad Agent Runtime, a third-party agent, ACP, or peer federation."
keywords: ["Monad Mesh", "Agent Runtime", "third-party agent", "ACP", "peer federation"]
---
Monad Mesh owns team identity, session bindings, observation, and policy. Each member of a mesh is backed by an agent runtime that actually executes its turns. Choose that runtime according to where the work should execute and which provider behavior you need — the member's identity and history stay with the mesh either way.

## Monad Agent Runtime (first-party)

Use Monad's bundled agent runtime when you want the simplest setup, Monad-native tools and memory, consistent approval behavior, and direct model-provider configuration. It is the default member for general chat, research, operations, and tool-driven work — and it is optional: a mesh can be made entirely of the runtimes below.

## Third-party agent

Use a third-party agent when a provider-native coding runtime such as Codex or Claude Code should execute inside a durable Monad session. The provider keeps its model loop, authentication, provider session, and provider-specific behavior. Monad provides project membership, session binding, observation, collaboration, and recovery.

Choose this for repository work that benefits from a provider's native coding harness.

## Agent Client Protocol

Use ACP in either direction:

- Run Monad as an Agent inside an ACP-compatible editor.
- Let Monad delegate a bounded subtask to another ACP Agent.

ACP is a protocol bridge, not a replacement for the daemon's durable team state. Choose it when editor-native interaction or protocol-level delegation matters.

## Peer federation

Use peer federation to delegate work between Monad daemons owned by the same operator. It is suitable for another machine or environment under the same trust boundary. It does not establish cross-owner identity, trust, or billing.

## Decision table

| Need | Choose |
|---|---|
| Fastest path to a working mesh member | Monad Agent Runtime |
| Provider-native coding behavior | Third-party agent |
| Editor integration or protocol delegation | ACP |
| Another operator-owned machine | Peer federation |
| Independent organizations and trust domains | Monadix, not local peer federation |

One mesh may use several paths at once. Stable project-member identity lets a member's agent runtime change without turning that change into a new team member.
