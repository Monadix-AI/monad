# Monad distribution

Monad releases are built and packaged by `dist` 0.32.0. The generic package adapter calls the existing Bun compiler for one target and stages its executable for `dist`.

```sh
dist plan --allow-dirty
MONAD_DIST_VERSION=0.1.3 dist build --target=aarch64-apple-darwin --allow-dirty
```

`scripts/build-dist.ts` receives `CARGO_DIST_TARGET`, builds the exact requested version, and copies `monad` into `distribution/out/`. `install-updater = true` makes the shell and PowerShell installers install the sibling `monad-update` executable and write the dist receipt used by axoupdater.

The release workflow builds each configured target, smoke-tests both installer families on native runners, then publishes the archives, updaters, and installers together. Release tags are the source of truth for stable, beta, and nightly builds.

For local development, mise pins the same dist version used by CI:

```sh
mise run release:build
mise run release:deploy-local
```

`release:deploy-local` builds the current host target, serves the generated assets only on a temporary loopback port, stops the installed daemon, runs `install.sh`, verifies that `monad-update` was installed, and starts the new binary. Set `MONAD_INSTALL_DIR` to override `~/.monad/bin`; pass `--no-start` to install without starting the daemon.
