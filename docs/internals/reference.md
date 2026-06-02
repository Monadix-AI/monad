---
title: "Developer Terminology Reference"
description: "Map Monad runtime, execution, extension, collaboration, and client terminology to its owning architecture documentation."
---
This reference maps Monad's runtime, execution, extension, collaboration, and client terms to their owning documentation. Use [product concepts](/concepts) for the user-facing model.

## Runtime services

| Term | Meaning | Owner documentation |
|---|---|---|
| **Daemon** | Long-running authority for state, policy, transports, and coordination | [Runtime](/internals/infra/runtime) |
| **RuntimeKernel** | Topologically ordered daemon lifecycle graph | [Daemon architecture](/internals/infra/daemon-architecture) |
| **ConfigManager** | Runtime settings reader, writer, watcher, and reload coordinator | [Daemon architecture](/internals/infra/daemon-architecture) |
| **Session** | Durable work thread with transcript, events, approvals, and execution state | [Project sessions](/internals/agent-team-runtime/project-sessions) |
| **OperationSource** | Immutable provenance and routing context stamped by the server | [Operation source](/internals/agent-runtime/operation-source) |
| **Model router** | Resolves a role through the active profile to a provider and model | [Model providers](/internals/infra/model-providers) |
| **Approval gate** | Fail-closed policy boundary before gated actions execute | [Tools](/internals/agent-runtime/tools) |

## Agent execution

| Term | Meaning | Owner documentation |
|---|---|---|
| **Monad Agent Runtime** | Bundled first-party model and tool loop with context, memory, approvals, and sandbox integration | [Agent runtime](/internals/agent-runtime/index) |
| **Third-party agent** | External provider runtime operated through an adapter | [Mesh agents](/usage/mesh-agents) |
| **Agent adapter** | Atom kind that translates a provider runtime into Monad session events and controls | [Adapter authoring](/internals/agent-team-runtime/mesh-adapter-authoring) |
| **Raw observation** | Accepted provider frames retained for provenance and debugging | [Mesh observation](/internals/agent-team-runtime/mesh-observation) |
| **Convenience observation** | Provider-neutral projection used by clients | [Mesh observation](/internals/agent-team-runtime/mesh-observation) |
| **Context management** | Eviction, summarization, recitation, retrieval, and token limiting | [Context management](/internals/agent-runtime/context-management) |
| **Memory** | Durable facts, graph, laws, and recall used by the first-party engine | [Memory](/internals/agent-runtime/memory) |

## Extension surfaces

| Term | Meaning | Owner documentation |
|---|---|---|
| **Atom Pack** | Manifest-gated bundle of declared extension kinds | [Atoms](/internals/infra/atoms) |
| **Skill** | Portable `SKILL.md` capability loaded when needed | [Skills](/usage/skills) |
| **Model Context Protocol server** | External tool server connected over standard transport | [MCP](/usage/mcp) |
| **Hook** | Lifecycle callback or shell command at a named runtime event | [Hooks](/internals/infra/hooks) |
| **Channel** | Adapter that normalizes messaging platform input and output | [Channel conformance](/internals/infra/channel-conformance) |
| **Provider** | Hosted or local model backend used by the first-party engine | [Model providers](/internals/infra/model-providers) |
| **Workplace Experience** | Web-only projection over daemon-owned project state | [Workplace Experiences](/internals/agent-team-runtime/workplace-experiences) |

Atom Packs can declare skills, MCP servers, locales, channels, providers, commands, connectors, message types, hooks, sandbox launchers, agent adapters, and Workplace Experiences. File-based kinds use their documented discovery paths. JavaScript-registered kinds must be declared in the manifest before registration.

Built-in tools are not an Atom kind. They remain first-party so their schema, approval, guard, and sandbox boundaries stay under daemon control.

## Collaboration mechanisms

| Term | Trust boundary | Owner documentation |
|---|---|---|
| **Project member** | Stable team identity within one daemon | [Project sessions](/internals/agent-team-runtime/project-sessions) |
| **Session binding** | Relationship between a project member and one project session | [Project sessions](/internals/agent-team-runtime/project-sessions) |
| **ACP delegation** | Editor-side or spawned Agent Client Protocol runtime | [ACP](/internals/agent-team-runtime/acp) |
| **Peer federation** | Another Monad daemon owned by the same operator | [Peer federation](/internals/agent-team-runtime/peer-federation) |
| **Monadix** | Cross-owner collaboration with independent trust and billing | [Product concepts](/concepts#monad-mesh-and-federation) |

## Client and transport terms

| Term | Meaning | Owner documentation |
|---|---|---|
| **Physical transport** | How bytes travel, such as TCP or a Unix-domain socket | [Runtime](/internals/infra/runtime) |
| **Semantic transport** | Which class of client writes a session, such as HTTP, ACP, or channel | [Runtime](/internals/infra/runtime) |
| **Control WebSocket** | Low-volume lifecycle, task, and approval stream | [Realtime channels](/internals/infra/realtime-channels) |
| **Per-message SSE** | High-volume token and reasoning delta stream | [Realtime channels](/internals/infra/realtime-channels) |
| **CLI, Web, and TUI** | Replaceable clients over public daemon contracts | [Architecture hub](/internals/index) |

Public protocol and client packages are the supported integration boundary. Importing daemon implementation details into a client or extension violates the architecture.
