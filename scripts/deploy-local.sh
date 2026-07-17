#!/usr/bin/env bash
# Build main and deploy it to this machine: build:release (host platform only), then
# hand the produced tarball to install.sh — same stop -> overwrite -> start flow as a
# real install, just skipping the network download.
#
# Usage: bun run deploy:local
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="${ROOT}/dist"

echo "[deploy-local] Building release binary for host platform…"
bun run --cwd "$ROOT" build:release

TARBALL=$(ls -t "${DIST}"/monad-*.tar.gz 2>/dev/null | grep -v test-install | head -1 || true)
[ -n "$TARBALL" ] || { echo "[deploy-local] No tarball found in dist/ after build:release" >&2; exit 1; }

echo "[deploy-local] Installing $(basename "$TARBALL") to this machine…"
# Run from outside the repo and with the dev env vars cleared: this checkout's
# .env.local sets MONAD_HOME/MONAD_PORT for `bun run dev`, and Bun auto-loads it from
# cwd — inside the repo the installed binary would silently attach to the dev home
# instead of the real ~/.monad install.
( cd /tmp && env -u MONAD_HOME -u MONAD_PORT -u WEB_PORT \
    MONAD_TARBALL="$TARBALL" bash "${ROOT}/scripts/install.sh" )
