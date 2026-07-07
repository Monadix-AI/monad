#!/usr/bin/env bash
# End-to-end check against the INSTALLED single binary: boots daemon + web (offline mock
# model) and exercises the full path — health, embedded SPA, daemon proxy, and a real chat
# round through the web proxy. Designed to run inside the disposable e2e container, but works
# anywhere the binary is installed.
#
# Env:
#   MONAD_BIN   path to the monad binary   (default: monad on PATH)
#   MONAD_HOME  isolated data dir          (default: /tmp/monad-e2e-home)
#   DPORT       daemon port                (default: 52749)
#   WPORT       web port                   (default: 3000)

set -euo pipefail

MONAD_BIN="${MONAD_BIN:-monad}"
export MONAD_HOME="${MONAD_HOME:-/tmp/monad-e2e-home}"
DPORT="${DPORT:-52749}"
WPORT="${WPORT:-3000}"
DAEMON_URL="https://127.0.0.1:${DPORT}"
WEB_URL="http://127.0.0.1:${WPORT}"
mkdir -p "$MONAD_HOME"

pass() { printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[0;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

echo "[e2e] starting daemon (mock model) + web from a single binary…"
MONAD_MOCK_MODEL=1 MONAD_PORT="$DPORT" "$MONAD_BIN" daemon >/tmp/e2e-daemon.log 2>&1 &
DPID=$!
WEB_PORT="$WPORT" MONAD_URL="$DAEMON_URL" "$MONAD_BIN" web >/tmp/e2e-web.log 2>&1 &
WPID=$!
cleanup() { kill "$DPID" "$WPID" 2>/dev/null || true; }
trap cleanup EXIT

# ── wait for readiness ─────────────────────────────────────────────────────────
ready=0
for _ in $(seq 1 60); do
  if curl -k -fsS "${DAEMON_URL}/health" >/dev/null 2>&1 \
     && curl -fsS "${WEB_URL}/" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
[ "$ready" = 1 ] || { echo "--- daemon.log ---"; cat /tmp/e2e-daemon.log; echo "--- web.log ---"; cat /tmp/e2e-web.log; fail "services did not become ready"; }

# ── assertions ─────────────────────────────────────────────────────────────────
curl -k -fsS "${DAEMON_URL}/health" | grep -q '"status":"ok"' && pass "daemon /health" || fail "daemon /health"

curl -fsS "${WEB_URL}/" | grep -q '<html' && pass "web serves embedded SPA" || fail "web /"

# The SPA's JS/CSS assets resolve from the embedded filesystem
asset=$(curl -fsS "${WEB_URL}/" | grep -oE '/_next/static/[^"]+\.js' | head -1 || true)
[ -n "$asset" ] && curl -fsS "${WEB_URL}${asset}" >/dev/null && pass "embedded asset ${asset##*/}" || fail "embedded static asset"

curl -fsS "${WEB_URL}/api/daemon/health" | grep -q '"status":"ok"' && pass "web → daemon proxy" || fail "proxy"

# ── full chat round through the WEB proxy (mock model is deterministic) ─────────
sid=$(curl -fsS -X POST "${WEB_URL}/api/daemon/v1/sessions" \
        -H 'content-type: application/json' -d '{"title":"e2e"}' \
      | grep -oE '"sessionId":"[^"]+"' | head -1 | cut -d'"' -f4)
[ -n "$sid" ] && pass "create session via proxy ($sid)" || fail "create session"

reply=$(curl -fsS -X POST "${WEB_URL}/api/daemon/v1/sessions/${sid}/messages/block" \
          -H 'content-type: application/json' -d '{"text":"hi"}')
echo "$reply" | grep -q 'Hello from the mock model.' \
  && pass "chat round returns mock reply" \
  || { echo "got: $reply"; fail "chat round"; }

echo "[e2e] all checks passed."
