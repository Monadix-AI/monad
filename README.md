<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/monad-logo-dark.svg">
    <img src="apps/web/public/monad-logo-vector-solid.svg" alt="Monad" width="520">
  </picture>
</p>

<h1 align="center">Monad</h1>

<p align="center"><strong>Monad is a daemon-first agent team runtime with headless architecture.</strong></p>

<p align="center">
  <a href="https://github.com/Monadix-AI/monad/actions/workflows/ci.yml"><img src="https://github.com/Monadix-AI/monad/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-6e56cf.svg" alt="macOS, Linux, and Windows">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#monad-agent-and-monad-mesh">Agent &amp; Mesh</a> ·
  <a href="#workspace-experiences">Workspace Experiences</a> ·
  <a href="#features">Features</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

**Models can reason. Agents can act. A team needs a runtime.**

Monad runs agents in one long-lived local daemon, from a focused individual agent
to a coordinated team. The daemon owns their identities, capabilities, permissions,
tasks, collaboration state, artifacts, approvals, and audit history. Web UI, CLI,
TUI, editors, APIs, messaging channels, and custom workspaces are interchangeable
ways to operate the same durable runtime.

Monad stores its own state on your machine and binds to loopback only by default.
Requests to the model provider you configure still leave the machine; everything
around those calls stays under your control. Read the
[runtime security model](docs/internals/runtime.md#security-model) before enabling
remote access.

## Quick start

### macOS and Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Monadix-AI/monad/main/scripts/install.sh | bash
monad
```

### Windows

Run in PowerShell 5.1 or later:

```powershell
irm https://raw.githubusercontent.com/Monadix-AI/monad/main/scripts/install.ps1 | iex
monad
```

The installer downloads the right release, verifies its SHA256 checksum, adds
`monad` to your `PATH`, and starts the local daemon. Running bare `monad` starts or
updates the daemon when needed and opens the Web UI.

Prefer to inspect every step or install offline? See
[manual installation](#manual-installation).

## The runtime behind the team

Agent teams create operational questions that a model or chat window cannot answer
on its own:

- **Who keeps the agents running?** The Monad daemon outlives any client window and
  restores durable work after reconnects and restarts.
- **Who gives them identity, capabilities, and permissions?** The runtime resolves
  each agent's role, models, skills, tools, credentials, and policy boundaries.
- **Who assigns and recovers work?** Tasks and sessions remain runtime-owned so work
  can be delegated, paused, resumed, branched, or inspected.
- **Who preserves collaboration state, artifacts, and audit history?** Agents and
  humans work from one local source of truth instead of isolated chat transcripts.
- **Who brings humans into approval decisions?** Risky actions stop at explicit
  approval gates before tools execute.
- **Who shapes the work experience?** Workspace Experiences project the same team
  and state into interfaces tailored to the job.

This is what daemon-first and headless mean in Monad: clients render and control the
runtime, but no client owns the agents or their work.

## Monad Agent and Monad Mesh

Monad provides two product forms over the same runtime:

| Product form | Designed for |
|---|---|
| **Monad Agent** | Focused work with one agent, backed by persistent context, controlled capabilities, approvals, recovery, and every client surface. |
| **Monad Mesh** | Multi-agent teamwork with explicit roles, delegation, parallel work, shared context and artifacts, human approvals, and recoverable collaboration state. |

Monad Agent is not a lightweight runtime beside Monad Mesh. Both use the same
daemon, policies, capabilities, task state, storage, and audit trail. You can begin
with one agent and compose a team without moving the work into another system.

## Workspace Experiences

A **Workspace Experience** is a scenario-specific projection of the same agents,
tasks, artifacts, approvals, and collaboration state. A coding workspace can center
repositories, diffs, and terminals; a research workspace can center sources,
evidence, and reports; operations and content workflows can expose their own views
and controls.

Experiences are composable and switchable. Atom packs can contribute them, while
the daemon remains the source of truth underneath. Changing the experience changes
how a team works with its state, not where that state lives.

## Why Monad

**Local-first by design.** Sessions, configuration, credentials, approvals, and
history live under `~/.monad/`. The daemon listens on loopback or a local Unix-domain
socket instead of exposing an unauthenticated service to your network.

**One daemon, every experience.** Start with Monad Agent in the browser, inspect its
work from the CLI, coordinate a team through Monad Mesh, or reach the same runtime
through an editor, API, or messaging channel. Every surface shares one source of
truth.

**Progressive autonomy.** Monad makes agent actions, tool calls, and approval requests
visible. You can begin with close supervision and grant broader autonomy only where
the task and environment justify it.

**Extensible and contained.** Skills, atom packs, Workspace Experiences, MCP
servers, external agent runtimes, and peer delegation expand how agents work.
Approval gates and native OS sandbox backends constrain how those capabilities
execute.

## Features

| Capability | What it gives you |
|---|---|
| [Sessions](docs/usage/sessions.md) | Persistent conversations that stream across clients and can branch or restore at any turn. |
| [Models](docs/usage/model-providers.md) | One model gateway for hosted and local providers, with profiles and per-role selection. |
| [Skills](docs/usage/skills.md) | Portable `SKILL.md` capability packets that agents can discover and follow. |
| [Atom packs](docs/internals/atoms.md) | Installable extensions for channels, providers, skills, MCP servers, commands, and hooks. |
| [Workspace Experiences](docs/concepts.md#workspace-experience) | Tailored interfaces for coding, research, operations, content, and other workflows over shared runtime state. |
| [Monad Mesh](docs/concepts.md#monad-mesh) | Compose multiple agents into a team with shared tasks, artifacts, approvals, and collaboration state. |
| [Channels](docs/usage/channels.md) | Reach the same agent or team through Telegram, Discord, Slack, and other adapters. |
| [Sandboxing](docs/usage/sandbox-backends.md) | Native process isolation and controlled network egress on macOS, Linux, and Windows. |
| [Editor agents](docs/internals/acp.md) | Use Monad as an ACP agent in editors, or delegate work to another ACP runtime. |
| [Peer federation](docs/internals/peer-federation.md) | Delegate a task to another Monad daemon that uses its own tools and credentials. |

## How it works

```text
 Web UI      CLI      TUI      Editors      APIs      IM channels
    │         │        │          │          │             │
    └─────────┴────────┴──────────┴──────────┴─────────────┘
                                │
               Workspace Experiences
           coding · research · operations · content
                                │
                  ┌─────────────▼─────────────┐
                  │       Monad Runtime       │
                  │   long-running daemon     │
                  ├───────────────────────────┤
                  │ Monad Agent │ Monad Mesh  │
                  ├───────────────────────────┤
                  │ Identity & permissions    │
                  │ Tasks, state & artifacts  │
                  │ Approvals & audit history │
                  │ Models, skills & tools    │
                  │ Local storage             │
                  └─────────────┬─────────────┘
                                │
                    Configured model providers
```

The daemon is the single owner of runtime state. Clients and Workspace Experiences
connect over REST, SSE, WebSocket, or a local Unix-domain socket; the daemon runs
agents, coordinates work, streams events, applies policy, and calls the model
providers selected by the user.

For the complete startup graph and transport boundaries, see
[daemon architecture](docs/internals/daemon-architecture.md) and
[runtime, configuration, and security](docs/internals/runtime.md).

## Installation

### Recommended installer

The [Quick start](#quick-start) installers detect your platform, verify the release
checksum, install application launchers where supported, and preserve your existing
configuration during upgrades.

Pre-built releases are self-contained: Bun and Node.js are not required at runtime.
Release archives are also available from the
[GitHub Releases](https://github.com/Monadix-AI/monad/releases) page.

### Manual installation

Choose an asset named `monad-<version>-<os>-<arch>.tar.gz` and download its matching
`.sha256` file. For example, on Apple Silicon macOS:

```bash
VERSION=<version>
ASSET="monad-${VERSION}-darwin-arm64"

curl -fSLO "https://github.com/Monadix-AI/monad/releases/download/v${VERSION}/${ASSET}.tar.gz"
curl -fSLO "https://github.com/Monadix-AI/monad/releases/download/v${VERSION}/${ASSET}.tar.gz.sha256"
shasum -a 256 -c "${ASSET}.tar.gz.sha256"
tar -xzf "${ASSET}.tar.gz"

"./${ASSET}/bin/monad" --help
```

On Linux, use `sha256sum -c` when `shasum` is unavailable. On Windows, use
`Get-FileHash -Algorithm SHA256` to compare the archive with its checksum file, then
extract it with the `tar` included in current Windows releases.

Linux publishes both glibc and musl archives. Use the regular `linux-<arch>` build on
Debian, Ubuntu, Fedora, and similar distributions; use `linux-<arch>-musl` on Alpine
or another musl-based system.

### System requirements

- **macOS:** Apple Silicon (`arm64`) or Intel (`x64`).
- **Linux:** `arm64` or `x64`, with glibc and musl release variants.
- **Windows:** 64-bit Windows 10 1803 or later; Windows on ARM currently runs the
  `windows-x64` release through the operating system's emulation layer.
- **Network:** outbound HTTPS access to the model provider you choose.

Monad orchestrates model providers; it does not bundle a local inference engine.

## Using Monad

```bash
# Start the daemon and open the Web UI
monad

# Inspect the runtime
monad status
monad doctor

# Create a session and send it work
monad session new "my session"
monad session send <sessionId> "hello"
monad session watch <sessionId>

# Explore models and choose the local client transport
monad model list
monad config set network.transport uds   # or tcp
```

Commands support script-friendly output, stable exit codes, and structured formats
such as `--json`. See the [complete CLI reference](docs/usage/cli.md) for command
groups, aliases, global flags, streaming behavior, and configuration examples.

## Development

Monad uses Bun workspaces and Turbo. From a source checkout:

```bash
bun install
bun run dev
```

`bun install` performs the idempotent worktree setup. `bun run dev` keeps development
state under `.dev/`, so it does not touch your normal `~/.monad/` data.

```bash
bun run dev:doctor      # read-only environment diagnosis
bun run quality:check   # canonical read-only quality gate
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Engineering
architecture, conventions, testing, security, and DX guidance live under
[`docs/engineering/`](docs/engineering/).

## Documentation

| Start here | Description |
|---|---|
| [Documentation map](docs/README.md) | Every user, internals, engineering, and design document. |
| [Concepts](docs/concepts.md) | Runtime, Agent, Mesh, Workspace Experience, capability, and federation concepts by layer. |
| [Product](docs/product.md) | Agent Team Runtime positioning, product forms, experience principles, boundaries, audiences, and brand. |
| [CLI reference](docs/usage/cli.md) | Commands, flags, aliases, outputs, and scripting contracts. |
| [Runtime internals](docs/internals/runtime.md) | Transport, configuration, remote access, and security boundaries. |
| [Changelog](CHANGELOG.md) | Notable changes across releases. |

## Community and security

- [Contributing guide](CONTRIBUTING.md)
- [Security policy and vulnerability reporting](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Issue tracker](https://github.com/Monadix-AI/monad/issues)

## License

[MIT](LICENSE) © Monadix Labs, Inc.

Bundled third-party components retain their own licenses. See
[`packages/sandbox-vm/vendor/THIRD_PARTY_LICENSES.md`](packages/sandbox-vm/vendor/THIRD_PARTY_LICENSES.md)
and run `monad licenses` for the generated runtime dependency inventory.
