# Documentation map

`docs/` is organized by audience: start with the two entry docs, then pick the
section that matches what you're here for — using monad ([usage/](usage/)),
understanding how it works inside ([internals/](internals/)), working in this repo
([engineering/](engineering/)), or design ([design/](design/)).

Agent *rules* have a separate home: the single source of truth is
`.rulesync/rules/`, compiled by [rulesync](https://github.com/dyoshikawa/rulesync)
into the per-tool agent files (`AGENTS.md`, `CLAUDE.md`, …), which are generated
locally and gitignored — never edit or commit them. Deep contributor knowledge
lives here in `docs/`; the compiled rules link into it, so the two stay connected
by reference rather than duplication.

## Entry points

| Doc | What it covers |
|---|---|
| [concepts.md](concepts.md) | Glossary of every first-class concept in monad, organized by layer, cross-linked to the deeper docs. |
| [product.md](product.md) | Product positioning: core idea, target users, and brand. |

## Usage — user documentation

How to use monad's features as an operator or end user.

| Doc | What it covers |
|---|---|
| [usage/sessions.md](usage/sessions.md) | Sessions, agents, and approvals: creating, branching, restoring, and watching sessions across clients. |
| [usage/cli.md](usage/cli.md) | CLI reference: every command group, global flags, aliases, exit codes, and scripting patterns. |
| [usage/model-providers.md](usage/model-providers.md) | Connecting a model provider: first-run wizard, web settings, CLI, credentials, and provider-specific notes. |
| [usage/channels.md](usage/channels.md) | Connecting IM channels (Telegram walkthrough): access control, pairing, group rules, and in-chat commands. |
| [usage/mcp.md](usage/mcp.md) | Adding MCP servers: stdio and http transports, secrets, OAuth, trust controls, and troubleshooting. |
| [usage/tui.md](usage/tui.md) | TUI scope, responsive layouts, keyboard/mouse controls, and Web UI degradation rules. |
| [usage/skills.md](usage/skills.md) | The skills system (`SKILL.md` / agentskills.io standard): using, writing, gating, and managing skills. |
| [usage/computer-use.md](usage/computer-use.md) | Computer use and browser use through off-the-shelf MCP servers, and when to pick which. |
| [usage/mo.md](usage/mo.md) | Mo, the desktop sprite: drop a file on the floating pixel cat to start a session. |
| [usage/sandbox-backends.md](usage/sandbox-backends.md) | Configuring sandbox backends: built-in and contributed launchers, settings, and hot switching. |
| [usage/native-cli-approvals.md](usage/native-cli-approvals.md) | The per-agent autopilot switch for native CLI agent approvals (Codex, Claude Code, Gemini, …). |

## Internals — how the system works

For contributors and the curious: architecture and behavior of the running system.

| Doc | What it covers |
|---|---|
| [internals/runtime.md](internals/runtime.md) | How the daemon binds: transport (TCP/UDS), configuration, env vars, and the security model. |
| [internals/daemon-architecture.md](internals/daemon-architecture.md) | The daemon as the one long-lived process: startup graph, lifecycle modules, hot reload, extension boundaries. |
| [internals/realtime-channels.md](internals/realtime-channels.md) | Which realtime channel carries which events: WS control plane vs SSE generation stream. |
| [internals/session-origin.md](internals/session-origin.md) | Session provenance: the immutable `origin` snapshot — identity, access policy, environment. |
| [internals/acp.md](internals/acp.md) | ACP both ways: monad as an editor agent, and delegating to other ACP agents. |
| [internals/peer-federation.md](internals/peer-federation.md) | Daemon-to-daemon task delegation: a peer runs the subtask on its own machine and streams the result back. |
| [internals/host-interactions.md](internals/host-interactions.md) | Schema-driven user input requested by built-ins and atom packs across Web, TUI, CLI, and ACP. |
| [internals/memory.md](internals/memory.md) | The memory system as built: L1 Markdown facts, L2 knowledge graph, L3 laws, and the consolidation pipeline. |
| [internals/tools.md](internals/tools.md) | The built-in tool set: registry layout, the uniform `register` contract, and authoring/security rules. |
| [internals/model-providers.md](internals/model-providers.md) | The model gateway: the provider catalog as source of truth, native vs OpenAI-compatible strategies, auth. |
| [internals/atoms.md](internals/atoms.md) | The atom pack system: one pack contributes declared, manifest-gated extension kinds. |
| [internals/hooks.md](internals/hooks.md) | Lifecycle hooks: events, the value contract, command and atom-pack hooks, dispatch semantics. |
| [internals/channel-conformance.md](internals/channel-conformance.md) | The IM channel conformance contract every adapter is pinned to. |
| [internals/web-router.md](internals/web-router.md) | The web UI router: a Next.js App Router SPA shipped as a static export embedded in the binary. |
| [internals/third-party-commands.md](internals/third-party-commands.md) | Slash commands contributed by atom packs via `defineCommand()`; the daemon owns parsing and execution. |

## Engineering — working in this repo

Norms shared by human contributors and coding agents.

| Doc | What it covers |
|---|---|
| [engineering/architecture.md](engineering/architecture.md) | Package and app boundaries, dependency direction, recorded decisions, anti-patterns. |
| [engineering/conventions.md](engineering/conventions.md) | Code style (comments, file length, abstraction) and typing rules, plus audited exceptions. |
| [engineering/testing.md](engineering/testing.md) | Test runners, directory layout, isolation, mock model, smoke tests, transport loop, coverage expectations. |
| [engineering/worktree.md](engineering/worktree.md) | The development workflow: worktree-per-feature, quality gates, squash-merge, environment reference. |
| [engineering/parallel-agents.md](engineering/parallel-agents.md) | Driving multiple coding agents at once: decomposition, coordination, conflict prevention, integration. |
| [engineering/security-guidelines.md](engineering/security-guidelines.md) | Code-level rules for security-sensitive changes, the threat model, and the PR security checklist. |
| [engineering/performance-guidelines.md](engineering/performance-guidelines.md) | Performance budgets, hot-path rules, and profiling procedure for backend and frontend. |
| [engineering/cli-design.md](engineering/cli-design.md) | CLI conventions: command naming, aliases, global flags, output/scriptability, XDG paths. |
| [engineering/design-principles.md](engineering/design-principles.md) | The two governing design principles: cross-platform parity and security-first agent containment. |
| [engineering/dx.md](engineering/dx.md) | Developer experience: keeping the edit→verify loop fast and what to do when a loop degrades. |
| [engineering/tech-stack.md](engineering/tech-stack.md) | Quick-reference map of every tool and library in the repo, by concern. |
| [engineering/philosophy.md](engineering/philosophy.md) | Engineering philosophy: make correct code the path of least resistance. |
| [engineering/model-provider-test-status.md](engineering/model-provider-test-status.md) | End-to-end manual coverage status for every built-in model provider type. |

## Design

| Doc | What it covers |
|---|---|
| [design/design-system.md](design/design-system.md) | The UI token design system: Stitch-derived surface system, color tokens, theming. |
| [design/ui-guidelines.md](design/ui-guidelines.md) | Visual rules for `apps/web`: tokens and theming, `@monad/ui` component conventions, icons, accessibility, motion. |
| [design/ux-guidelines.md](design/ux-guidelines.md) | Interaction conventions: core interaction model, state requirements, keyboard, touch, cursor and selection, i18n scope. |
| [design/ux-writing-guidelines.md](design/ux-writing-guidelines.md) | Product voice, microcopy, sentence-style capitalization, accessibility text, review checklist. |

## Proposals and examples

| Doc | What it covers |
|---|---|
| [proposals/](proposals/) | Design proposals not yet (or never) implemented. |
| [proposals/backlog-ideas.md](proposals/backlog-ideas.md) | Ideas worth remembering with no current commitment, and why each was deferred. |
| [examples/](examples/README.md) | Example skills to copy into `~/.monad/skills/`, plus pointers to the runnable atom pack examples in `packages/sdk-atom/examples/`. |

## Root governance docs

| Doc | What it covers |
|---|---|
| [README.md](../README.md) | What monad is, quick start, pointers. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Local setup, required checks, commit and PR workflow. |
| [SECURITY.md](../SECURITY.md) | How to report a vulnerability; scope. |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Community standards. |
| [CHANGELOG.md](../CHANGELOG.md) | Notable changes per release. |
| [LICENSE](../LICENSE) | License terms. |
