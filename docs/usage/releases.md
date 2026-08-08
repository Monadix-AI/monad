---
title: "Releases, Channels, and Upgrading"
description: "Choose a Monad release channel, upgrade or roll back safely, and understand client-daemon compatibility."
sidebarTitle: "Releases and Upgrading"
keywords: ["release channels", "stable beta nightly", "upgrade Monad", "version compatibility"]
---
Monad publishes the daemon, CLI, and Web UI together as one versioned build, on three
channels: `stable` by default, `beta` for prereleases, and `nightly` for the tip of `main`.

Which build to run, how to move between channels, and what compatibility you can expect.
The contributor-facing side of this — how releases are cut — is in
[CONTRIBUTING.md](https://github.com/Monadix-AI/monad/blob/main/CONTRIBUTING.md#branching--releases).

## Channels

| Channel | Who it is for | Cadence | Version shape |
|---|---|---|---|
| `stable` (default) | Everyone | Cut from `main` through a human-reviewed release PR | `v0.2.0` |
| `beta` | Early adopters who will report bugs | Same gate, prerelease line | `v0.2.0-beta.1` |
| `nightly` | Developers tracking `main` | Automatic daily build of `main`'s tip, no human gate | `v0.2.0-nightly.<date>+<sha>` |

Nightly has no release PR and no changelog entry. It is `main` as it stands — use it when
you want the newest work and can tolerate a broken day.

Install a specific channel:

```bash
curl -fsSL https://release.monadix.ai/monad/install.sh | bash -s -- --channel beta
```

Without `curl`, use `wget -qO- https://release.monadix.ai/monad/install.sh | bash -s -- --channel beta`.

Switch an existing install:

```bash
monad upgrade --channel beta
```

## Upgrading

```bash
monad upgrade --check         # report only, changes nothing
monad upgrade                 # apply the latest release on the current channel
monad upgrade --notes         # show release notes alongside version info
monad upgrade rollback        # restore the previous binary
monad upgrade --prune-backups # keep only the 3 most recent binary backups
```

The upgrade contacts GitHub Releases **only when you run it** — there is no background
update check and no auto-update. The previous binary is kept under `~/.monad/backup/binaries/`,
which is what `rollback` restores.

Your configuration and data are untouched by an upgrade: the installer leaves an existing
`~/.monad` in place.

## Versioning and compatibility

Monad is **pre-1.0**. Versions follow [Semantic Versioning](https://semver.org), which
before `1.0.0` means a minor bump may carry a breaking change. Conventional Commits drive
the version bump and the generated [changelog](https://github.com/Monadix-AI/monad/blob/main/CHANGELOG.md), so a breaking change
is always marked with `!` and a `BREAKING CHANGE:` footer in history and release notes.

Practical expectations while pre-1.0:

- **Read the release notes before a minor upgrade.** That is where a required migration
  is announced (for example the `auth.json` v1 → v2 credential change, which fails startup
  rather than guessing).
- **The daemon and its clients should match.** The CLI warns on a daemon/client version
  mismatch; `--force` continues past it on remote connections at your own risk.
- **On-disk formats may move.** Settings files are versioned and validated at load; a
  format the running daemon does not understand is rejected loudly, never silently
  reinterpreted.
- **The wire contracts are the stable-ish part.** Every method and stream is declared once
  in `@monad/protocol` and covered by parity tests, so a client built on those packages
  moves with the daemon. See [api.md](/usage/api).

## Supported versions

Security fixes go to `main` and the latest release only; older releases are not patched.
Upgrade before reporting a vulnerability. Full policy: [SECURITY.md](https://github.com/Monadix-AI/monad/blob/main/SECURITY.md).

## Verifying a download

The installer verifies the release SHA256 checksum before installing; `--no-verify` skips
that and should only be used when you have verified the artifact another way. For manual
installation and checksum verification, see
[the README](https://github.com/Monadix-AI/monad/blob/main/README.md#manual-installation).
