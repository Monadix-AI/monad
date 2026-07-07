#!/usr/bin/env bash
# Self-contained install simulation inside dist/test-install/.
# Tests three flows: fresh install, upgrade (overwrite binary), overwrite-install (full re-run).
# Nothing outside the project directory is touched.
#
# Usage:  bun run install:test
#         bun run install:test --clean   # wipe dist/test-install before running

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DIST="${ROOT}/dist"
INSTALLER="${ROOT}/scripts/install.sh"

ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }
step() { echo ""; echo "[install-test] $*"; }

if [ ! -d "$DIST" ]; then
  echo "[install-test] dist/ not found — run 'bun run build:release' first."
  exit 1
fi

# TARBALL_GLOB can be set by CI (e.g. "monad-*-linux-x64.tar.gz") to pick the
# right platform when dist/ contains multiple tarballs from all OS builds.
GLOB="${TARBALL_GLOB:-monad-*.tar.gz}"
TARBALL=$(ls -t "${DIST}"/${GLOB} 2>/dev/null | grep -v test-install | head -1 || true)
if [ -z "$TARBALL" ]; then
  echo "[install-test] No tarball matching '${GLOB}' found in dist/ — run 'bun run build:release' first."
  exit 1
fi

TEST_DIR="${DIST}/test-install"
INSTALL_DIR="${TEST_DIR}/install"
BIN_DIR="${TEST_DIR}/bin"
HOME_DIR="${TEST_DIR}/home"

if [[ "${1:-}" == "--clean" ]]; then
  step "Cleaning dist/test-install/…"
  rm -rf "$TEST_DIR"
fi

echo "[install-test] tarball : $(basename "$TARBALL")"
echo "[install-test] install : ${INSTALL_DIR}"

# Common installer env — no network, no PATH changes, no daemon auto-start.
run_installer() {
  MONAD_TARBALL="$TARBALL" \
  MONAD_SKIP_VERIFY=1 \
  MONAD_INSTALL_DIR="$INSTALL_DIR" \
  MONAD_BIN_DIR="$BIN_DIR" \
  MONAD_HOME="$HOME_DIR" \
  MONAD_NO_PATH_MODIFY=1 \
  MONAD_NO_DAEMON=1 \
  bash "$INSTALLER"
}

MONAD="${BIN_DIR}/monad"

smoke_test() {
  "$MONAD" --help | head -4
  ok "monad --help"
  [ -f "${HOME_DIR}/config.json" ] && grep -q '"sample-openai-compatible"' "${HOME_DIR}/config.json" \
    && ok "config.json provider sample" || true
}

# ── Flow 1: Fresh install ──────────────────────────────────────────────────────
step "Flow 1: fresh install"
rm -rf "$INSTALL_DIR" "$BIN_DIR" "$HOME_DIR"
run_installer
[ -f "$MONAD" ] || fail "binary not found after fresh install"
smoke_test
MTIME_1=$(stat -c '%Y' "$MONAD" 2>/dev/null || stat -f '%m' "$MONAD")

# ── Flow 2: Upgrade (re-run installer over existing install) ──────────────────
step "Flow 2: upgrade (overwrite existing install)"
sleep 1  # ensure mtime changes if binary is replaced
run_installer
[ -f "$MONAD" ] || fail "binary missing after upgrade"
smoke_test
MTIME_2=$(stat -c '%Y' "$MONAD" 2>/dev/null || stat -f '%m' "$MONAD")
[ "$MTIME_2" -ge "$MTIME_1" ] || fail "binary mtime did not advance — upgrade may not have replaced it"
ok "binary replaced (mtime advanced)"

# ── Flow 3: Overwrite-install with pre-existing home data ─────────────────────
step "Flow 3: overwrite-install (home data must survive)"
echo '{"_test":"sentinel"}' >> "${HOME_DIR}/config.json"
run_installer
grep -q '"_test":"sentinel"' "${HOME_DIR}/config.json" \
  && ok "home data preserved across overwrite-install" \
  || fail "home data was wiped by overwrite-install"

# ── Daemon + web smoke test (flow 1 install, reused) ─────────────────────────
step "Runtime smoke tests"
DPORT=4399; WPORT=3099
DAEMON_URL="https://127.0.0.1:${DPORT}"
WEB_URL="http://127.0.0.1:${WPORT}"
MONAD_HOME="$HOME_DIR" MONAD_MOCK_MODEL=1 MONAD_PORT=$DPORT "$MONAD" daemon >/tmp/it-daemon.log 2>&1 &
DPID=$!
WEB_PORT=$WPORT MONAD_URL="$DAEMON_URL" "$MONAD" web >/tmp/it-web.log 2>&1 &
WPID=$!
cleanup() { kill $DPID $WPID 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 40); do curl -k -fsS "${DAEMON_URL}/health" >/dev/null 2>&1 && break; sleep 0.1; done
for _ in $(seq 1 40); do curl -fsS "${WEB_URL}/" >/dev/null 2>&1 && break; sleep 0.1; done

curl -k -fsS "${DAEMON_URL}/health" >/dev/null && ok "daemon /health"
curl -fsS "${WEB_URL}/" | grep -q '<html' && ok "web / serves embedded SPA"
curl -fsS "${WEB_URL}/api/daemon/health" >/dev/null && ok "web → daemon proxy"

echo ""
echo "[install-test] All outputs inside dist/test-install/ — nothing outside the project was touched."
