---
title: "Install or Remove Monad"
description: "Install Monad on macOS, Linux, or Windows; upgrade or remove it safely."
keywords: ["install Monad", "macOS Linux Windows install", "uninstall", "upgrade", "single binary"]
---
Monad installs as a single binary on macOS, Linux, and Windows and runs as one local daemon.
The release installer downloads the matching archive and installs `monad`. The CLI and Web UI use
the same built-in verified upgrade flow.

This guide covers system requirements, the release installer, manual installation, upgrades, and removal. Use [getting started](/getting-started) after installation to connect a model and run your first session.

## Check system requirements

Monad publishes self-contained releases for these platforms:

| Platform | Supported targets |
|---|---|
| macOS | Apple Silicon (`arm64`) and Intel (`x64`) |
| Linux | `arm64` and `x64`, with glibc and musl variants |
| Windows | Native `arm64` and `x64` builds for 64-bit Windows 10 1803 or later |

You need outbound HTTPS access to your chosen model provider. Monad does not bundle a local inference engine.

## Install a release

Run the installer for your platform. It selects the release archive, installs Monad under
`~/.monad/bin`, and updates `PATH`.

On macOS or Linux:

```bash
curl -fsSL https://release.monadix.ai/monad/install.sh | sh
```

If `curl` is unavailable, use:

```bash
wget -qO- https://release.monadix.ai/monad/install.sh | sh
```

On Windows PowerShell 5.1 or later:

```powershell
irm https://github.com/Monadix-AI/monad/releases/latest/download/install.ps1 | iex
```

In an interactive terminal, a successful install starts the daemon and opens the Web UI automatically.
Automated, JSON, and quiet installs only install the binaries; run `monad up` afterwards when you are
ready to start Monad.

The interactive installer shows download size, speed, and ETA when terminal width permits. For
automation, set `MONAD_OUTPUT=json` to emit newline-delimited stage and summary events instead of
animation. Downloads retry transient failures three times.

## Install an archive manually

Download the archive from [GitHub Releases](https://github.com/Monadix-AI/monad/releases). Release names use dist target triples such as `monad-aarch64-apple-darwin.tar.gz`. GitHub signs immutable releases and records every asset digest in the release attestation.

For the latest immutable release on Apple Silicon macOS:

```bash
release_tag="$(gh release view --repo Monadix-AI/monad --json tagName --jq .tagName)"
asset="monad-aarch64-apple-darwin"
gh release download "${release_tag}" --repo Monadix-AI/monad --pattern "${asset}.tar.gz"
gh release verify-asset "${release_tag}" "${asset}.tar.gz" --repo Monadix-AI/monad
tar -xzf "${asset}.tar.gz"
"./${asset}/monad" --help
```

The verification command checks both the release attestation and the downloaded asset digest. The same `gh` command works on Windows; extract the verified archive with `tar`.

Use the regular `linux-arch` build on glibc distributions such as Debian, Ubuntu, and Fedora. Use `linux-arch-musl` on Alpine and other musl-based distributions.

## Upgrade

Use `monad update` or the Web UI upgrade action. See [releases and upgrading](/usage/releases) for release channels and explicit update commands.

## Remove Monad

Stop the daemon before removing installed files:

```bash
monad stop
```

Run `monad purge all` only when you also want to delete local sessions, configuration, credentials, memory, and installed extensions under `~/.monad`. Narrower scopes are `monad purge sessions`, `monad purge config`, and `monad purge auth`.

Remove the `monad` binary from the directory reported by `command -v monad`. Remove the application launcher from `~/Applications/Monad.app` on macOS or `~/.local/share/applications/monad.desktop` on Linux. On Windows, remove the Monad directory under `%APPDATA%`, the Start Menu shortcut, and its `PATH` entry.

The installer marks any shell configuration change with `# Added by monad installer`. Remove that marked entry if you no longer need the installed binary directory on `PATH`.
