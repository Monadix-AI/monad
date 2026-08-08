---
title: "Install or Remove Monad"
description: "Install Monad on macOS, Linux, or Windows; upgrade, roll back, or remove it safely."
keywords: ["install Monad", "macOS Linux Windows install", "uninstall", "upgrade", "single binary"]
---
Monad installs as a single binary on macOS, Linux, and Windows and runs as one local daemon.
The release installer verifies the download, adds `monad` to your `PATH`, starts the daemon,
and opens the Web UI.

This guide covers system requirements, the release installer, manual installation, upgrades, and removal. Use [getting started](/getting-started) after installation to connect a model and run your first session.

## Check system requirements

Monad publishes self-contained releases for these platforms:

| Platform | Supported targets |
|---|---|
| macOS | Apple Silicon (`arm64`) and Intel (`x64`) |
| Linux | `arm64` and `x64`, with glibc and musl variants |
| Windows | 64-bit Windows 10 1803 or later; Windows on ARM uses `windows-x64` emulation |

You need outbound HTTPS access to your chosen model provider. Monad does not bundle a local inference engine.

## Install a release

Run the installer for your platform. It selects the release archive, verifies its SHA256 checksum, installs launchers where supported, updates `PATH`, and starts the daemon.

On macOS or Linux:

```bash
curl -fsSL https://release.monadix.ai/monad/install.sh | bash
```

If `curl` is unavailable, use:

```bash
wget -qO- https://release.monadix.ai/monad/install.sh | bash
```

On Windows PowerShell 5.1 or later:

```powershell
irm https://release.monadix.ai/monad/install.ps1 | iex
```

The macOS and Linux installer starts the daemon and opens the Web UI. The Windows installer
initializes Monad; run `monad up` afterwards to start the daemon and open the Web UI.

### Force a clean reinstall

Use `--force` only to recover from a damaged or incomplete installation. It removes the entire installation directory before extracting the release and skips SHA256 verification. The default installation directory is `~/.monad`, so back up any local sessions, configuration, credentials, memory, or installed extensions that you need before continuing. Prefer the regular installer for routine installs and upgrades.

On macOS or Linux, pass installer arguments after `bash -s --`:

```bash
curl -fsSL https://release.monadix.ai/monad/install.sh | bash -s -- --force
```

Without `curl`:

```bash
wget -qO- https://release.monadix.ai/monad/install.sh | bash -s -- --force
```

On Windows, download the script before passing `--force`:

```powershell
$installer = Join-Path $env:TEMP "monad-install.ps1"
irm https://release.monadix.ai/monad/install.ps1 -OutFile $installer
& $installer --force
```

## Install an archive manually

Download the archive and matching `.sha256` file from [GitHub Releases](https://github.com/Monadix-AI/monad/releases). Release names use `monad-version-os-arch.tar.gz`.

For Apple Silicon macOS:

```bash
release_version=release_version_here
asset="monad-${release_version}-darwin-arm64"
release_url="https://github.com/Monadix-AI/monad/releases/download/v${release_version}"

curl -fSLO "${release_url}/${asset}.tar.gz"
curl -fSLO "${release_url}/${asset}.tar.gz.sha256"
shasum -a 256 -c "${asset}.tar.gz.sha256"
tar -xzf "${asset}.tar.gz"
"./${asset}/bin/monad" --help
```

Without `curl`, download the archive and checksum with:

```bash
wget -q "${release_url}/${asset}.tar.gz"
wget -q "${release_url}/${asset}.tar.gz.sha256"
```

Use `sha256sum -c` on Linux when `shasum` is unavailable. On Windows, compare the archive with its checksum by running `Get-FileHash -Algorithm SHA256`, then extract it with `tar`.

Use the regular `linux-arch` build on glibc distributions such as Debian, Ubuntu, and Fedora. Use `linux-arch-musl` on Alpine and other musl-based distributions.

## Upgrade or roll back

Running `monad` updates the daemon when the installed client requires it. See [releases and upgrading](/usage/releases) for release channels, compatibility, explicit upgrade commands, and rollback.

## Remove Monad

Stop the daemon before removing installed files:

```bash
monad stop
```

Run `monad purge all` only when you also want to delete local sessions, configuration, credentials, memory, and installed extensions under `~/.monad`. Narrower scopes are `monad purge sessions`, `monad purge config`, and `monad purge auth`.

Remove the `monad` binary from the directory reported by `command -v monad`. Remove the application launcher from `~/Applications/Monad.app` on macOS or `~/.local/share/applications/monad.desktop` on Linux. On Windows, remove the Monad directory under `%APPDATA%`, the Start Menu shortcut, and its `PATH` entry.

The installer marks any shell configuration change with `# Added by monad installer`. Remove that marked entry if you no longer need the installed binary directory on `PATH`.
