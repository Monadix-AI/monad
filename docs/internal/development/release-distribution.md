---
title: "Release Distribution"
audience: "internal-developer"
description: "Build, package, and locally verify Monad release artifacts with dist."
---
# Release distribution

Monad releases are built and packaged by `dist` 0.32.0. The generic package adapter calls the existing Bun compiler for one target and stages its executable for `dist`.

```sh
dist plan --allow-dirty
MONAD_DIST_VERSION=0.1.3 dist build --target=aarch64-apple-darwin --allow-dirty
```

`scripts/build-dist.ts` receives `CARGO_DIST_TARGET`, builds the exact requested version, and copies
`monad` into the root `out/` staging directory. The shell and PowerShell installers only install
that application binary; CLI and Web upgrades use Monad's shared release verification and worker.

Stable and beta releases use a release PR as the immutable quality boundary. Release Please keeps
the version files and `CHANGELOG.md` on that branch; CI regenerates the PR body with `git-cliff` on
every `opened`, `labeled`, `reopened`, and `synchronize` event. A new commit therefore cancels the
superseded run, regenerates the notes for the new head SHA, and runs the complete cross-platform
quality gate again. The `merge gate` check must be required on both `main` and `beta`.

Merging the release PR creates a draft GitHub release whose body is the reviewed PR body. The
post-merge workflow verifies that draft and its version, builds every target, attests and uploads
the archives and installers, then publishes it. It deliberately does not rerun lint, typecheck,
unit, integration, E2E, installer, or upgrade tests: those belong to the release PR's required
check. Failed build or upload jobs can be rerun against the same tag and SHA, and `release.yml` is
also manually dispatchable for that recovery path.

Nightly has no release PR. It runs the Linux unit and integration suites, then builds and publishes
directly; `git-cliff` generates its release body from the exact tag range. Live-provider E2E is
scheduled independently in `live-e2e.yml`, so its runtime and provider
availability do not delay the nightly artifact path. Native Windows ARM installer compatibility
runs after a successful publication in `release-smoke.yml`; it reports release health without
turning an already-published artifact into a hidden prepublication gate.

Repository setup is part of the release contract:

- Create and retain the `beta` channel branch.
- Require pull requests and the `merge gate` status on `main` and `beta`; prevent direct/bypass
  merges for release PRs.
- Configure `RELEASE_PLEASE_TOKEN` with Contents and Pull Requests write access. A PR created by the
  default `GITHUB_TOKEN` does not trigger the `pull_request` CI workflow.
- Keep Actions allowed to create and approve pull requests, and grant only the per-job permissions
  declared in the workflows.

Release tags remain the source of truth for stable, beta, and nightly builds.

For local development, mise pins the same dist version used by CI:

```sh
mise run release:build
mise run release:deploy-local
```

`release:deploy-local` builds the current host target, serves the generated assets only on a
temporary loopback port, stops the installed daemon, runs `install.sh` on macOS/Linux or
`install.ps1` on Windows, verifies the installed `monad`/`monad.exe` binary, and starts it. Set
`MONAD_INSTALL_DIR` to override `~/.monad/bin`; pass `--no-start` to install without starting the
daemon.

Windows source builds require MSVC Build Tools with the **Desktop development with C++** workload.
The build discovers a standard Visual Studio installation through `vswhere`; alternatively, run
mise from a Developer PowerShell where `cl.exe` is already active.
