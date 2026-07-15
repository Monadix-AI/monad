# Monad — Product Concepts

A reference glossary of every first-class concept in monad, organized by layer. Read this before diving into any feature area; each entry cross-links the deeper doc where one exists.

---

## Agent Runtime

The core machinery that runs an agentic session end-to-end.

### Daemon

The single long-running process (`apps/monad/`) that owns all state. It binds loopback-only by default (TCP `127.0.0.1:52749` **and** a Unix-domain socket at `~/.monad/run/monad.sock`) and exposes a REST + SSE API. All clients — CLI, web UI, TUI, editor ACP bridge, IM channels — talk to the daemon; they carry no agent logic themselves. State lives under `~/.monad/` (config, sessions DB, memory, atom packs, credentials).

See [`docs/internals/runtime.md`](internals/runtime.md) and [`docs/internals/daemon-architecture.md`](internals/daemon-architecture.md).

### Session

One conversation thread between a user and the agent. A session has an immutable **origin** (which surface created it, which transports may write/fork it) and a mutable transcript of messages and events. Sessions persist across daemon restarts; they can be branched (forked at any turn) for experimentation.

See [`docs/internals/session-origin.md`](internals/session-origin.md).

### Session Origin

The immutable provenance record stamped on every session at creation. It has three layers:

- **identity** — `surface` (closed enum: `editor`, `web`, `tui`, `im`, `api`, `automation`), `client` (open string: `telegram`, `zed`, …), `instanceId`.
- **access** — `writableBy` and `branchableBy` (which transports may send into / fork the session). Derived from `surface` at creation, then stored and enforced immutably.
- **environment** — `ip`, `userAgent`, `locale`, `workspace`, etc. Audit/telemetry only; never forwarded to the model.

See [`docs/internals/session-origin.md`](internals/session-origin.md).

### Agent

The AI reasoning core that lives inside a session. It runs a **tool loop**: receive a message → call the model → execute any tool calls → stream events → repeat. The agent reads from its context window (system prompt + transcript + injected skill/memory content) and dispatches tool calls through the **Approval Gate** before execution. One daemon can run many agent instances concurrently, one per session.

### Model Router

The routing layer that picks the concrete model for each agent turn. It resolves a **role** (e.g. `primary`, `fast`, `background`, `embed`) through the active **profile** to a `(provider, modelId)` pair. Profiles let operators swap entire model stacks with one config change. The router hot-reloads when `config.json` changes.

### Approval Gate

The oversight layer that sits between the agent and tool execution. When a tool is marked `highRisk` or its `scopes` require it, the gate pauses execution and presents an approval card in the UI. The user can approve, deny, or edit the call. Approval policies can be configured per tool and per session surface (e.g. an API session may auto-approve shell; a channel session may not).

### Memory

The agent's persistent knowledge store, layered by scope:

- **Static core** — `USER.md` (durable user facts), `SOUL.md` (persona), `AGENT.md` (operating rules). Always injected into the system prompt. Human-curated; hot-reloaded.
- **Dynamic facts** — machine-written Markdown files under `~/.monad/memory/` keyed by scope (`global`, `agent_<id>`, `session_<id>`). The agent reads/writes them through the `memory` tool (`view` / `record` / `update` / `delete`). Global facts are inlined into the system prompt; agent-private facts are read on demand. Auto-consolidation triggers when a scope exceeds ~2000 chars; manual `/consolidate` runs an LLM dedup/merge pass.
- **Semantic recall (mem0)** — an optional layer using a daemon-managed local Qdrant vector store for per-turn observation and semantic retrieval.
- **Knowledge graph and laws (L2/L3)** — `/consolidate` extracts entities and relations from transcripts into a local graph and infers general rules ("laws") that guide recall; `/why` traces a belief back to its sources.

See [`docs/internals/memory.md`](internals/memory.md).

### Workspace

The agent's working directory — `~/.monad/workspace/` by default. All file operations are sandboxed to roots anchored at the workspace (and any explicitly allowed additional roots). Skills under `workspace/skills/` travel with the workspace and shadow personal skills of the same name.

---

## Built-in Capabilities

What ships with the daemon and is available to every agent out of the box.

### Tool

A first-party built-in capability the agent can invoke: filesystem ops, shell commands, web search/extract, code execution, email, todo, memory read/write, scheduling, delegation, image/vision, and the MCP adapter. Tools are not contributed by atom packs — they ship with the daemon. Every tool input is treated as hostile (prompt-injection containment); resource guards run at call time inside `invoke.ts`.

See [`docs/internals/tools.md`](internals/tools.md).

### Slash Commands

The `/command` dispatch system shared across all surfaces (CLI, TUI, web, IM channels). A unified registry parses `/name [args]` from any transport, routes to built-in handlers (e.g. `/model`, `/compact`, `/consolidate-memory`) or skill invocations, and enforces that built-in names are reserved. Plugin-registered commands extend the set without touching core code.

### Hooks

Lifecycle event handlers that run shell commands or atom-pack callbacks at named points in the agent loop. The seven events are: `pre-tool`, `post-tool`, `pre-turn`, `post-turn`, `pre-message`, `post-message`, and `session-end`. Hooks are configured per-event in `config.json` and hot-reload without daemon restart. Used for observability, auto-memory dogfooding, and custom automation.

---

## Extensibility

The plugin system that lets users and third parties extend the daemon without touching core code.

### Atom Pack

A bundled extension that ships multiple capabilities together. An atom pack is a directory (or `.zip`) with a `pack.json` manifest and one or more **atom kinds**:

| Atom kind | What it contributes |
|-----------|---------------------|
| **skill** | Additional skills (same `SKILL.md` format) |
| **channel** | An IM platform adapter |
| **mcp** | An MCP server (stdio or HTTP) |
| **provider** | A model provider plugin |

Atom packs are installed under `~/.monad/atoms/` and managed via `monad atoms` / the Atoms settings panel. Each kind has a dedicated installer; the daemon hot-reloads packs without restart.

### Skill

A portable, filesystem-based capability packet. A skill is a directory under `~/.monad/skills/` (or `~/.monad/workspace/skills/`) containing a `SKILL.md` with YAML frontmatter and free-prose instructions. Skills extend the agent with domain knowledge and procedures **without paying token cost until needed** — they are lazily loaded into context when invoked by `/name` or by the model. monad implements the [agentskills.io](https://agentskills.io) open standard (`SKILL.md`), a portable format shared across the agent ecosystem.

Skills can declare eligibility gates (`requires`), workspace activation globs (`paths`), allowed tools (`allowed-tools`), and a fork mode (`context: fork`) that runs the skill as an isolated subagent at a chosen capability tier.

See [`docs/usage/skills.md`](usage/skills.md).

### Channel

An IM platform adapter that lets external messaging apps reach the agent. A channel is declared as an atom (or built-in) with a `ChannelAdapter` implementation. Built-in channels include Telegram, WhatsApp, Feishu, Google Chat, Line, and Twilio. Each channel instance has an isolated `ChannelContext` (no direct access to the session store or agent tools) that normalizes inbound messages into `ChannelInbound` events and delivers outbound replies via `send`.

See [`docs/internals/realtime-channels.md`](internals/realtime-channels.md).

### Provider

A model backend monad can route requests to. Each provider is one entry in `PROVIDER_CATALOG` and uses one of two strategies:

- **native** — a dedicated AI SDK package (Anthropic, OpenAI, OpenRouter, Google, Mistral, Amazon Bedrock, Azure OpenAI).
- **openai-compatible** — a preset pointed at a known base URL (Groq, xAI, DeepSeek, Ollama, and ~15 others), with zero extra dependencies.

Providers are configured in `~/.monad/config.json`; credentials live in `~/.monad/auth.json` as secret refs. The **Model Router** dispatches each turn to the right provider/model based on the active profile and per-role overrides.

See [`docs/internals/model-providers.md`](internals/model-providers.md).

### MCP (Model Context Protocol)

The integration layer for external tool servers. MCP servers expose tools over stdio or HTTP; the daemon's MCP client discovers, connects, and proxies their tools into the agent's tool registry as first-class callables. MCP servers can be configured in `config.json` or contributed by atom packs.

---

## Multi-agent & Federation

Concepts that span more than one agent instance or daemon.

### Studio

A two-layer builder for authoring custom agents and capabilities: a **capability layer** (what the agent can do — skills, tools, MCP bindings) and an **agent layer** (persona, routing, delegation policy). Studio agents appear as delegation targets in the tool registry and can be invoked via the `delegate` tool.

### Peer Federation

Daemon-to-daemon task delegation between monad instances owned by the **same person** (e.g. home node ↔ work laptop). The `agent_peer_delegate` tool routes a subtask to a named peer daemon over its OpenAI-compatible HTTP endpoint; the peer runs a full agent session on its own filesystem and credentials and streams the answer back. Peers are configured in `config.json` with credentials in `auth.json`.

Cross-owner collaboration (different people, independent trust) is **Monadix** territory, not peer federation.

See [`docs/internals/peer-federation.md`](internals/peer-federation.md).

### Monadix

The cross-owner collaboration network. Where peer federation is same-person multi-machine, Monadix is A2A (agent-to-agent) across independent users and trust boundaries — with its own billing, routing, and identity model. monad integrates with the Monadix network via the `monadix` MCP connector.

---

## Client Surfaces

The interfaces through which humans and editors interact with the daemon.

### ACP (Agent Client Protocol)

The editor integration protocol. `monad acp` is a thin bridge: the editor spawns it over stdio, and it proxies to the already-running daemon over the local Unix socket. Editor sessions appear in the web UI and TUI and share one store, model config, and ledger. monad also acts as an ACP **client**, delegating subtasks to other ACP agents via the `agent_acp_delegate` tool.

See [`docs/internals/acp.md`](internals/acp.md).

### Mo

A pixel-art desktop sprite (a cat named Mochi) that floats always-on-top as a transparent frameless window. Drag a file or folder onto Mo → type a prompt → a new session is seeded. Mo is a thin native process (~5–20 MB, no webview) that talks only to the daemon's REST API. Its animation state tracks the agent lifecycle: idle → waving (file hovering) → jumping (dropped) → waiting (session seeded) → running (agent generating) → review (done).

See [`docs/usage/mo.md`](usage/mo.md).

### Workplace

A project-scoped multi-agent collaboration workspace in the web UI, reachable at `/workplace/projects/:projectId`. Each Workplace is backed by a monad session (stored as `"Workplace: <slug>"`); within it the user can invite ACP agents as participants, issue directives, watch a live activity log of tool calls, manage an approval queue, and view a shared chat transcript. Components: `ProjectHeader`, `ProjectRail` (session list), `AgentTasksRail` (per-agent task status), `ChatTranscript`, `Composer`, `ActivityLog`, `ApprovalStack`.

Designed for operators running multiple agents in parallel on a shared task — each agent sees the same session context and can be approved or steered independently.

### Transports

The three wire protocols the daemon speaks:

| Transport | Used by | Notes |
|-----------|---------|-------|
| **REST + SSE** | Web UI, CLI, TUI, API clients, peer delegate | Primary; TCP loopback + Unix socket |
| **WebSocket** | Web UI push (session events, approval cards) | Single multiplexed connection per client |
| **ACP (stdio)** | Editors (Zed, VS Code via bridge) | JSON-RPC over stdout; bridge proxies to daemon |

All behaviour must be identical across TCP loopback and Unix socket; every feature is tested on both.

See [`docs/internals/runtime.md`](internals/runtime.md).
