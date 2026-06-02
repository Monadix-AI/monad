---
title: "Understand Monad's Product Concepts"
sidebarTitle: "Concepts"
description: "Understand Monad's core concepts: daemon, Monad Mesh, agent runtimes, session, project, task, approval, and client."
keywords: ["Monad concepts", "Monad Mesh", "agent team runtime", "agent runtime", "project session"]
---
This conceptual guide defines the runtime-owned objects that users, operators, and developers share. Read the [developer reference](/internals/reference) for implementation and extension terminology.

## Agent team runtime

Monad is a daemon-first agent team runtime with headless architecture. The runtime keeps a team available independently of clients and owns the identity, capabilities, permissions, work state, artifacts, approvals, and audit history required to operate it.

Headless means the Web UI, command-line interface (CLI), terminal user interface (TUI), editors, application programming interfaces (APIs), messaging channels, and custom Web experiences are clients. They can close, reconnect, or be replaced without taking ownership of the team or its work.

## Daemon

The daemon is the single long-running Monad process. It stores durable state, applies policy, exposes public contracts, coordinates the team, and connects clients with agent runtimes.

The daemon binds to local interfaces by default. See [runtime, configuration, and security](/internals/infra/runtime) for transport and remote-access behavior.

## Monad Mesh

Monad Mesh is the agent team runtime the daemon exposes. It owns team identity, session bindings, roles, delegation, shared work, observation, approvals, and recovery.

A mesh is the unit users work with. Agents from different runtimes join the same mesh and keep their own execution behavior while the mesh keeps one durable record of who participates and what happened. A one-agent setup uses the same runtime and grows into a team without moving its work.

## Agent and team member

An agent is a reasoning and execution participant in a team. A project member is its durable team identity, which can outlive a specific provider process or execution session.

The team runtime uses that identity for capability, policy, work assignment, session binding, observation, and recovery. It does not infer identity from a display name.

## Agent runtime

An agent runtime runs an agent turn. It receives input, invokes a model or provider-specific loop, performs allowed actions, and returns events or results.

Any of these can be a mesh member:

| Runtime | What it is | Attaches through |
|---|---|---|
| **Monad Agent Runtime** | Monad's first-party agent runtime, bundled and used by default | Built in |
| **Third-party agent provider** | A provider-native runtime such as Codex, Claude Code, Gemini CLI, or Qwen Code | Third-party agent adapter |
| **ACP agent** | An agent reached over the Agent Client Protocol, including editor-side agents | ACP delegation |
| **Peer daemon** | Another Monad daemon owned by the same operator | Peer federation |

Monad Agent Runtime has no privileged position beyond being bundled: it is one member among many. No agent runtime owns team identity, collaboration state, or client presentation — the mesh does.

## Session

A session is one durable work thread. It contains messages, events, approvals, and execution state that survive client closure and daemon restart.

A standalone session has no project. A project session binds participating project members to the same work thread while preserving their stable identities and runtime-specific state.

## Project

A project is a durable collaboration environment with a title, workspace root, member roster, configuration, and zero or more sessions. A project is not itself a transcript.

Each project session owns its messages, member bindings, deliveries, runtime sessions, approvals, and optional plan. See [project sessions](/internals/agent-team-runtime/project-sessions) for workspace and identity rules.

## Task and plan

A task is a durable unit of intent assigned to an agent or coordinated across a team. It should remain inspectable, interruptible, resumable, and linked to participants, activity, approvals, and outputs.

Current implementations use sessions, project task state, delegation records, and optional session plans. Monad does not yet define one universal distributed task schema.

## Collaboration state

Collaboration state records who participates, what each member is doing, which decisions have been made, what remains blocked, and how work relates across agents.

The daemon owns this state. Every client presents it according to its surface.

## Artifact

An artifact is a durable output such as a patch, file, report, source collection, plan, or review result. It remains associated with the task and activity that produced it so people and agents can inspect provenance instead of relying only on transcript text.

## Approval and audit

Approval is the human decision boundary before a gated action executes. Audit is the durable record of requests, decisions, actions, and outcomes needed to understand what happened.

Together, approval and audit make progressive autonomy accountable.

## Client

A client renders and controls daemon-owned state. Monad clients include the Web UI, CLI, TUI, editor bridges, APIs, and messaging channels.

A client may provide surface-specific interaction, but it must not become the only owner of a cross-client capability.

## Workplace Experience

A Workplace Experience is a Web-only projection of daemon-owned agents, tasks, artifacts, approvals, and collaboration state. It can organize browser interaction for coding, research, operations, content, or another domain without creating another source of truth.

Experience selection and rendering stay inside the Web client. The CLI, TUI, editors, and messaging channels use the same runtime contracts without rendering that experience.

## Capability and extension

A capability defines what an agent or client can do under runtime policy. Monad can add capability through model providers, skills, Model Context Protocol servers, Atom Packs, hooks, channels, agent adapters, and Workplace Experiences.

Extensions do not bypass daemon authority. Their inputs remain untrusted, and their registered behavior must follow the relevant manifest, schema, approval, and sandbox boundaries.

## Federation

Peer federation delegates work between Monad daemons owned by the same operator, so a peer daemon can act as a mesh member on another machine. Cross-owner collaboration with independent trust and billing belongs to Monadix.

## Current boundaries

Monad does not currently claim arbitrary distributed scheduling, a universal task and artifact schema, or cross-owner identity and trust inside the local runtime.

Read [What Monad is](/product) for the product boundary, [usage guides](/usage/index) for operations, and [developer architecture](/internals/index) for implementation details.
