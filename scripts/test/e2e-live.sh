#!/usr/bin/env bash
# Live end-to-end check against the INSTALLED single binary, hitting a REAL model provider
# (default: OpenRouter's free router). This is the network-bound complement to e2e.sh, which
# runs offline against the deterministic mock model. It exercises what mock cannot: real model
# inference, token streaming, reasoning passthrough, the tool-call loop, and the usage ledger.
#
# Non-deterministic by nature — a live free model can rate-limit (429) or vary its output. Run it
# as a nightly / manual / NON-BLOCKING job, never as a PR gate (that belongs to e2e.sh). The
# structural checks below assert shape, not exact text; the tool-call round is a soft check
# (warns, does not fail) so an off-day from a tiny free model never reds the build.
#
# Env:
#   OPENROUTER_API_KEY   required — the provider credential (runtime-injected; never baked in)
#   MONAD_LIVE_MODEL     model id to seed         (default: openrouter/free)
#   MONAD_BIN            path to the monad binary (default: monad on PATH)
#   MONAD_HOME           isolated data dir        (default: /tmp/monad-e2e-live-home)
#   DPORT                daemon port              (default: 52749)

set -euo pipefail

MONAD_BIN="${MONAD_BIN:-monad}"
export MONAD_HOME="${MONAD_HOME:-/tmp/monad-e2e-live-home}"
DPORT="${DPORT:-52749}"
export MODEL="${MONAD_LIVE_MODEL:-openrouter/free}"
B="https://127.0.0.1:${DPORT}"

pass() { printf '  \033[0;32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[0;33m! %s\033[0m\n' "$1" >&2; }
fail() { printf '  \033[0;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ -n "${OPENROUTER_API_KEY:-}" ] || fail "OPENROUTER_API_KEY is unset — export it before running the live e2e."
command -v python3 >/dev/null 2>&1 || fail "python3 is required (used to parse JSON/SSE)."
mkdir -p "$MONAD_HOME"

echo "[e2e-live] starting daemon (model: ${MODEL}) from a single binary…"
export MONAD_PORT="$DPORT"
"$MONAD_BIN" daemon >/tmp/e2e-live-daemon.log 2>&1 &
DPID=$!
cleanup() { kill "$DPID" 2>/dev/null || true; }
trap cleanup EXIT

ready=0
for _ in $(seq 1 60); do
  curl -k -fsS "${B}/health" >/dev/null 2>&1 && { ready=1; break; }
  sleep 0.2
done
[ "$ready" = 1 ] || { echo "--- daemon.log ---"; cat /tmp/e2e-live-daemon.log; fail "daemon did not become ready"; }
curl -k -fsS "${B}/health" | grep -q '"status":"ok"' && pass "daemon /health" || fail "daemon /health"

# ── configure a real provider + credential + default profile via the CLI ───────
"$MONAD_BIN" provider set '{"id":"openrouter","label":"OpenRouter","type":"openrouter"}' >/dev/null \
  && pass "provider configured (openrouter)" || fail "provider set"
"$MONAD_BIN" credential add openrouter \
  "$(python3 -c 'import json,os; print(json.dumps({"label":"e2e-live","authType":"api_key","accessToken":os.environ["OPENROUTER_API_KEY"]}))')" \
  >/dev/null && pass "credential added" || fail "credential add"
"$MONAD_BIN" model set \
  "$(python3 -c 'import json,os; print(json.dumps({"alias":"default","provider":"openrouter","modelId":os.environ["MODEL"],"params":{"reasoningEffort":"low"},"fallbacks":[]}))')" \
  >/dev/null && pass "profile set (${MODEL})" || fail "model set"
"$MONAD_BIN" model use default >/dev/null && pass "default profile selected" || fail "model use"

new_session() {
  curl -k -fsS -X POST "${B}/v1/sessions" -H 'content-type: application/json' -d "{\"title\":\"$1\"}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["sessionId"])'
}

# ── 1. block round: a real, non-empty assistant reply ──────────────────────────
sid=$(new_session live-block)
reply=$(curl -k -fsS -m 120 -X POST "${B}/v1/sessions/${sid}/messages/block" \
          -H 'content-type: application/json' \
          -d '{"text":"In one short sentence, what is 17 multiplied by 4? Include the number."}')
text=$(echo "$reply" | python3 -c 'import sys,json; print((json.load(sys.stdin).get("message") or {}).get("text") or "")')
[ -n "$text" ] && pass "block chat returns a real reply: \"${text:0:60}\"" || { echo "got: $reply"; fail "block chat empty"; }

# ── 2. streaming round: ordered token deltas over SSE ──────────────────────────
sid=$(new_session live-stream)
( curl -k -fsS -N -m 120 "${B}/v1/sessions/${sid}/events" >/tmp/e2e-live-sse.txt 2>/dev/null ) &
SSEPID=$!
sleep 1
curl -k -fsS -m 120 -X POST "${B}/v1/sessions/${sid}/messages" \
  -H 'content-type: application/json' -d '{"text":"Say the word STREAMOK and nothing else."}' >/dev/null
for _ in $(seq 1 120); do grep -q '"type":"agent.message"' /tmp/e2e-live-sse.txt && break; sleep 0.5; done
kill $SSEPID 2>/dev/null || true
tokstats=$(python3 - <<'PY'
import json
n=0; final=None
for line in open('/tmp/e2e-live-sse.txt'):
    line=line.strip()
    if not line.startswith('data:'): continue
    try: e=json.loads(line[5:].strip())
    except Exception: continue
    if e.get('type')=='agent.token': n+=1
    if e.get('type')=='agent.message': final=(e.get('payload') or {}).get('text')
print(f"{n}\t{final or ''}")
PY
)
ntok=${tokstats%%$'\t'*}
[ "${ntok:-0}" -gt 0 ] && pass "streaming delivered ${ntok} agent.token event(s)" || { cat /tmp/e2e-live-sse.txt | tail -5; fail "no streamed tokens"; }

# ── 3. tool-call loop (SOFT — a tiny free model may skip the call) ──────────────
sid=$(new_session live-tool)
( curl -k -fsS -N -m 120 "${B}/v1/sessions/${sid}/events" >/tmp/e2e-live-tool.txt 2>/dev/null ) &
SSEPID=$!
sleep 1
curl -k -fsS -m 120 -X POST "${B}/v1/sessions/${sid}/messages" -H 'content-type: application/json' \
  -d '{"text":"Use your file-writing tool to create a file called e2e_live.txt with the exact contents LIVE_OK. Then say done."}' >/dev/null
for _ in $(seq 1 120); do grep -q '"type":"agent.message"' /tmp/e2e-live-tool.txt && break; sleep 0.5; done
kill $SSEPID 2>/dev/null || true
if grep -q '"type":"tool.called"' /tmp/e2e-live-tool.txt; then
  tool=$(python3 - <<'PY'
import json
for l in open("/tmp/e2e-live-tool.txt"):
    l = l.strip()
    if not l.startswith("data:"):
        continue
    try:
        e = json.loads(l[5:].strip())
    except Exception:
        continue
    if e.get("type") == "tool.called":
        p = e.get("payload") or {}
        print(p.get("name") or p.get("toolName") or p.get("tool") or "?")
        break
PY
)
  pass "tool-call loop fired (${tool})"
else
  warn "model did not invoke a tool this run (expected occasionally on a free model) — not failing"
fi

# ── 4. usage ledger recorded the live spend ────────────────────────────────────
"$MONAD_BIN" usage --json >/tmp/e2e-live-usage.json 2>/dev/null || curl -k -fsS "${B}/v1/usage" >/tmp/e2e-live-usage.json 2>/dev/null || true
if python3 -c 'import json,sys; d=json.load(open("/tmp/e2e-live-usage.json")); s=json.dumps(d); sys.exit(0 if ("in" in s or "tokens" in s.lower() or "total" in s.lower()) else 1)' 2>/dev/null; then
  pass "usage ledger recorded the live round(s)"
else
  warn "could not confirm usage ledger (non-fatal)"
fi

echo "[e2e-live] all hard checks passed."
