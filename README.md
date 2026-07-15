# Monad

> A local, single-user daemon for running agentic sessions — with a CLI, web UI, and TUI.

[![CI](https://github.com/Monadix-AI/monad/actions/workflows/ci.yml/badge.svg)](https://github.com/Monadix-AI/monad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

monad runs as a local daemon and serves a REST + SSE API over loopback and a
Unix-domain socket. It ships with a CLI, a browser web UI, and a terminal UI, and
keeps all state under `~/.monad/`. It binds **loopback only by
default** — see the [security model](docs/internals/runtime.md#security-model) before exposing it.

## What it does

- **Local-first** — one long-lived daemon owns all state under `~/.monad/`; nothing leaves your machine except the calls to your model provider.
- **Many clients, one session** — CLI, web UI, and TUI drive the same daemon; sessions persist across restarts, stream live to every client, and can be branched at any turn.
- **Model gateway** — 24 built-in providers (Anthropic, OpenAI, Google, Ollama, …) behind one router, with per-role model selection and hot-swappable profiles ([model providers](docs/internals/model-providers.md)).
- **Skills** — portable `SKILL.md` capability packets following the [agentskills.io](https://agentskills.io) standard, the same format used by Claude Code, Codex, and other agents ([skills](docs/usage/skills.md)).
- **Atom packs** — drop-in extensions that contribute channels, model providers, skills, MCP servers, slash commands, and hooks ([atoms](docs/internals/atoms.md)).
- **IM channels** — talk to the agent from Telegram, Discord, Slack, and other messaging platforms ([channel conformance](docs/internals/channel-conformance.md)).
- **OS-level sandboxing** — agent-spawned processes are confined with Seatbelt (macOS), bwrap/Landlock (Linux), or AppContainer (Windows), plus domain-filtered network egress ([sandbox backends](docs/usage/sandbox-backends.md)).
- **Editor integration** — monad acts as an ACP agent inside editors like Zed, and can itself delegate subtasks to other ACP agents ([ACP](docs/internals/acp.md)).
- **Peer federation** — delegate a task to another monad daemon you own; it runs on that machine's own tools and credentials and streams the result back ([peer federation](docs/internals/peer-federation.md)).

**Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md) ·
**Reporting a vulnerability:** see [SECURITY.md](SECURITY.md) ·
**Community standards:** see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Install

Pre-built, self-contained binaries (no Bun or Node needed at runtime) are published
on the [Releases](https://github.com/Monadix-AI/monad/releases) page for macOS,
Linux, and Windows. Each asset is named `monad-<version>-<os>-<arch>.tar.gz` with a
matching `.sha256`. Linux ships two libc flavours: the plain `linux-<arch>` build for
glibc distros (Debian/Ubuntu/Fedora…) and a `linux-<arch>-musl` build for musl systems
(Alpine and most embedded/Buildroot rootfs) — pick `-musl` if `ldd --version` mentions musl.

**System requirements:** a 64-bit OS on **arm64 or x64** (32-bit ARM, RISC-V, and
microcontrollers are not supported — the bundled Bun runtime needs a 64-bit host); ~100 MB
free disk for the binary; **≥1 GB RAM** recommended (the idle daemon resides around ~300 MB);
and outbound HTTPS to your model provider (monad orchestrates remote models, it does not run
inference locally). This makes 64-bit Linux SBCs (e.g. Raspberry Pi 4/5) a viable target via
the `linux-arm64`/`linux-arm64-musl` builds; bare-metal/RTOS embedded devices are out of scope.

```bash
# macOS (Apple Silicon) — swap the asset name for your os/arch (darwin|linux, arm64|x64)
ASSET=monad-<version>-darwin-arm64
curl -fsSL "https://github.com/Monadix-AI/monad/releases/latest/download/$ASSET.tar.gz" -o "$ASSET.tar.gz"
curl -fsSL "https://github.com/Monadix-AI/monad/releases/latest/download/$ASSET.tar.gz.sha256" | shasum -a 256 -c -
tar -xzf "$ASSET.tar.gz"

./$ASSET/bin/monad --help
./$ASSET/bin/monad up        # start the daemon + web UI together
```

On **Windows** (PowerShell), grab the `windows-x64` asset (`tar` ships with Windows 10 1803+ / 11):

```powershell
$ASSET = "monad-<version>-windows-x64"
Invoke-WebRequest "https://github.com/Monadix-AI/monad/releases/latest/download/$ASSET.tar.gz" -OutFile "$ASSET.tar.gz"
tar -xzf "$ASSET.tar.gz"

.\$ASSET\bin\monad.exe --help
.\$ASSET\bin\monad.exe up        # start the daemon + web UI together
```

**Scripted install** — downloads the right asset, verifies the SHA256, and adds monad to your `PATH`:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Monadix-AI/monad/main/scripts/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/Monadix-AI/monad/main/scripts/install.ps1 | iex
```

To run from source instead, see [Setup](#setup).

## Setup

```bash
bun install
bun run dev
```

`bun install` performs the idempotent worktree setup: environment, ports, local CLI
shim, generated inputs, and optional shared development services. If startup fails,
run `bun run dev:doctor` for a read-only diagnosis with repair commands.

## Running the daemon

```bash
bun run apps/monad/src/main.ts
```

The daemon writes all state to `~/.monad/` by default (created automatically on first run).

## Local development isolation

`bun run dev` automatically redirects all daemon state to `.dev/.monad/` (gitignored) — it never touches your real `~/.monad`. No configuration needed.

To use a different home when running the daemon directly (e.g. to test a separate config):

```bash
MONAD_HOME=~/.monad-dev bun run apps/monad/src/main.ts
```

## Configuration

Most settings live in `~/.monad/config.json` (created on first run) — daemon port,
bind address, client transport, and remote-access token. No env vars are needed for
normal use.

For the daemon startup architecture, hot reload, extension boundaries, transport
model, bootstrap environment variables, and security posture, see
**[docs/internals/daemon-architecture.md](docs/internals/daemon-architecture.md)** and
**[docs/internals/runtime.md](docs/internals/runtime.md)**.

## CLI

```bash
monad status
monad session new "my session"
monad session send <sessionId> "hello"
monad session watch <sessionId>
monad config set network.transport uds   # tcp | uds (see docs/internals/runtime.md)
```

## Documentation

See **[docs/](docs/README.md)** for architecture, design principles, conventions,
and contributor docs.

## License

[MIT](LICENSE) © Monadix Labs, Inc.

Bundled third-party components retain their own licenses; see
[`packages/sandbox-vm/vendor/THIRD_PARTY_LICENSES.md`](packages/sandbox-vm/vendor/THIRD_PARTY_LICENSES.md)
and run `monad licenses` for the full runtime dependency list.
