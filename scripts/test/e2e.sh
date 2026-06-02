#!/usr/bin/env bash
# End-to-end check against the INSTALLED single binary: boots the daemon and exercises
# health, the embedded SPA, and session persistence. Designed to run inside the disposable
# e2e container, but works
# anywhere the binary is installed.
#
# Env:
#   MONAD_BIN   path to the monad binary   (default: monad on PATH)
#   MONAD_HOME  isolated data dir          (default: /tmp/monad-e2e-home)
#   DPORT       daemon port                (default: 52749)

set -euo pipefail

MONAD_BIN="${MONAD_BIN:-monad}"
export MONAD_HOME="${MONAD_HOME:-/tmp/monad-e2e-home}"
DPORT="${DPORT:-52749}"
DAEMON_URL="http://127.0.0.1:${DPORT}"
mkdir -p "$MONAD_HOME"

pass() { printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[0;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

echo "[e2e] starting daemon with embedded web UI…"
MONAD_PORT="$DPORT" "$MONAD_BIN" daemon >/tmp/e2e-daemon.log 2>&1 &
DPID=$!
cleanup() { kill "$DPID" 2>/dev/null || true; }
trap cleanup EXIT

# ── wait for readiness ─────────────────────────────────────────────────────────
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "${DAEMON_URL}/health" >/dev/null 2>&1 \
     && curl -fsS "${DAEMON_URL}/" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
[ "$ready" = 1 ] || { echo "--- daemon.log ---"; cat /tmp/e2e-daemon.log; fail "service did not become ready"; }

# ── assertions ─────────────────────────────────────────────────────────────────
curl -fsS "${DAEMON_URL}/health" | grep -q '"status":"ok"' && pass "daemon /health" || fail "daemon /health"

curl --compressed -fsS "${DAEMON_URL}/" | grep -q '<html' && pass "daemon serves embedded SPA" || fail "web /"

# The SPA's JS/CSS assets resolve from the embedded filesystem
asset=$(curl --compressed -fsS "${DAEMON_URL}/" | grep -oE '/assets/[^"]+\.js' | head -1 || true)
[ -n "$asset" ] && curl -fsS "${DAEMON_URL}${asset}" >/dev/null && pass "embedded asset ${asset##*/}" || fail "embedded static asset"

# ── session persistence round-trip ─────────────────────────────────────────────
sid=$(curl -fsS -X POST "${DAEMON_URL}/v1/sessions" \
        -H 'content-type: application/json' -d '{"title":"e2e"}' \
      | grep -oE '"sessionId":"[^"]+"' | head -1 | cut -d'"' -f4)
[ -n "$sid" ] && pass "create session ($sid)" || fail "create session"

curl -fsS "${DAEMON_URL}/v1/sessions" |
  jq -e --arg sid "$sid" '.sessions[] | select(.id == $sid and .title == "e2e")' >/dev/null \
  && pass "created session reads back from list" \
  || fail "session persistence"

echo "[e2e] all checks passed."
