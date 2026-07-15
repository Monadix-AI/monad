<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/monad-logo-dark.svg">
    <img src="apps/web/public/monad-logo-vector-solid.svg" alt="Monad" width="520">
  </picture>
</p>

<h1 align="center">Monad</h1>

<p align="center"><strong>Your local AI agent runtime — one daemon, every interface, your data.</strong></p>

<p align="center">
  <a href="https://github.com/Monadix-AI/monad/actions/workflows/ci.yml"><img src="https://github.com/Monadix-AI/monad/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-6e56cf.svg" alt="macOS, Linux, and Windows">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

Monad is a local runtime for AI agents. One long-lived daemon keeps your sessions,
configuration, approvals, and history together while the Web UI, CLI, TUI, editors,
and messaging channels give you different ways to work with the same agent.

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

## Why Monad

**Local-first by design.** Sessions, configuration, credentials, approvals, and
history live under `~/.monad/`. The daemon listens on loopback or a local Unix-domain
socket instead of exposing an unauthenticated service to your network.

**One daemon, every interface.** Start a session in the browser, inspect it from the
CLI, continue in the TUI, or reach the same agent through an editor or messaging
channel. Each surface shares one source of truth.

**Progressive autonomy.** Monad makes agent actions, tool calls, and approval requests
visible. You can begin with close supervision and grant broader autonomy only where
the task and environment justify it.

**Extensible and contained.** Skills, atom packs, MCP servers, external agent
runtimes, and peer delegation expand what an agent can do. Approval gates and native
OS sandbox backends constrain how those capabilities execute.

## Features

| Capability | What it gives you |
|---|---|
| [Sessions](docs/usage/sessions.md) | Persistent conversations that stream across clients and can branch or restore at any turn. |
| [Models](docs/usage/model-providers.md) | One model gateway for hosted and local providers, with profiles and per-role selection. |
| [Skills](docs/usage/skills.md) | Portable `SKILL.md` capability packets that agents can discover and follow. |
| [Atom packs](docs/internals/atoms.md) | Installable extensions for channels, providers, skills, MCP servers, commands, and hooks. |
| [Channels](docs/usage/channels.md) | Reach the same local agent through Telegram, Discord, Slack, and other adapters. |
| [Sandboxing](docs/usage/sandbox-backends.md) | Native process isolation and controlled network egress on macOS, Linux, and Windows. |
| [Editor agents](docs/internals/acp.md) | Use Monad as an ACP agent in editors, or delegate work to another ACP runtime. |
| [Peer federation](docs/internals/peer-federation.md) | Delegate a task to another Monad daemon that uses its own tools and credentials. |

## How it works

```text
 Web UI       CLI        TUI       Editors       IM channels
    │          │          │           │               │
    └──────────┴──────────┴───────────┴───────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Local Monad      │
                    │  daemon           │
                    ├───────────────────┤
                    │ Sessions          │
                    │ Approvals & tools │
                    │ Models & skills   │
                    │ Local storage     │
                    └─────────┬─────────┘
                              │
                    Configured model provider
```

The daemon is the single owner of runtime state. Clients connect over REST, SSE,
WebSocket, or a local Unix-domain socket; the daemon coordinates sessions, streams
events, applies policy, and calls the model provider selected by the user.

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
| [Concepts](docs/concepts.md) | A layer-by-layer glossary of Monad's first-class concepts. |
| [Product](docs/product.md) | Product purpose, audiences, principles, and brand direction. |
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
