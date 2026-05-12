#!/usr/bin/env bash
#
# Devnet regression test for the wallet-prefix curator fallback added
# in PR #448 round-6 (`deriveCuratorDidFromCgId`).
#
# Background: any V10 CG whose RDF `_meta` graph never received the
# canonical curator triple — typically because on-chain registration
# failed mid-create (no funded identity, RPC blip, daemon crash between
# SQLite and triple-store writes) — used to silently reject every
# inbound PROTOCOL_JOIN_REQUEST with `unknown CG`. The joiner saw only
# "no reachable curator". On a live laptop pair this looked exactly
# like a network bug; root-causing it required hand-instrumenting the
# server code.
#
# This test reproduces that exact stale state on the curator (N1) and
# verifies that:
#   1. PROTOCOL_JOIN_REQUEST is now ACCEPTED (the fallback derives the
#      curator from the cgId prefix, not the missing RDF triple).
#   2. The curator logs the accept line (observability assertion).
#   3. The pending request is persisted and visible to the curator.
#
# Drives 2 devnet nodes:
#   N1 (port 9201) — curator on a wallet-scoped cgId, no RDF metadata
#   N2 (port 9202) — joiner
#
# Assumes `./scripts/devnet.sh start 5` is running.

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$SCRIPT_DIR/../.devnet"
N1_LOG="$DEVNET_DIR/node1/daemon.log"

if [[ -n "${DEVNET_TOKEN:-}" ]]; then
  TOKEN="$DEVNET_TOKEN"
elif [[ -n "${DKG_AUTH:-}" ]]; then
  TOKEN="$DKG_AUTH"
elif [[ -f "$SCRIPT_DIR/../.devnet/node1/auth.token" ]]; then
  TOKEN="$(grep -v '^#' "$SCRIPT_DIR/../.devnet/node1/auth.token" 2>/dev/null | tr -d '[:space:]')"
else
  echo "ERROR: No auth token. Export DEVNET_TOKEN or run ./scripts/devnet.sh start" >&2
  exit 2
fi

N1=http://127.0.0.1:9201
N2=http://127.0.0.1:9202

N1_ADDR=""
N2_ADDR=""
N1_PEER_ID=""

hr()   { printf '\n\033[1;34m── %s ──\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; exit 1; }
note() { printf '  \033[0;90m· %s\033[0m\n' "$*"; }

api() {
  local node="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "${node}${path}" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" --data "$body"
  else
    curl -sS -X "$method" "${node}${path}" -H "Authorization: Bearer $TOKEN"
  fi
}

urlenc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }

assert_log_recent() {
  local log_path="$1" since_iso="$2" pattern="$3" label="$4"
  if [ ! -f "$log_path" ]; then fail "log file missing: $log_path (label=$label)"; return 1; fi
  local hit
  hit=$(awk -v since="$since_iso" '
    match($0, /(\[)?20[0-9]{2}-[0-9]{2}-[0-9]{2}T?[ ][0-9:]{8}/) {
      ts = substr($0, RSTART, RLENGTH); gsub(/[\[T]/, " ", ts); sub(/^ /, "", ts)
      if (ts >= since) print
    }
  ' "$log_path" | grep -E "$pattern" | head -1)
  if [ -n "$hit" ]; then
    ok "log assertion ($label): matched"
    note "  → $hit"
    return 0
  fi
  fail "log assertion ($label) failed: pattern '$pattern' not in $log_path since $since_iso"
  tail -n 8 "$log_path" | sed 's/^/    /'
  return 1
}

identify() {
  for i in 1 2; do
    local api_url
    api_url=$(eval echo "\$N${i}")
    local self_json self_addr self_peer
    self_json=$(api "$api_url" GET /api/agents | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('agents',[]):
    if a.get('connectionStatus')=='self':
        print(json.dumps({'addr': a.get('agentAddress',''), 'peer': a.get('peerId','')})); break
")
    self_addr=$(echo "$self_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('addr',''))")
    self_peer=$(echo "$self_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('peer',''))")
    [ -z "$self_addr" ] && fail "N$i: could not fetch agent address"
    eval "N${i}_ADDR=\"$self_addr\""
    eval "N${i}_PEER_ID=\"$self_peer\""
    ok "N$i: $self_addr (peer: $self_peer)"
  done
}

###############################################################################

hr "Step 0 — identify nodes"
identify

# Stale-state cgId construction:
#  * uses N1's wallet address as the prefix → fallback can derive curator
#  * unique suffix per run so we never collide with prior test runs
#  * we deliberately DO NOT call /api/context-graph/create on N1 — that
#    would write the canonical RDF metadata and our fallback wouldn't
#    fire. Instead we rely on signJoinRequest (which doesn't validate
#    CG existence) on N2's side and the wallet-prefix fallback on N1's.
CG_ID="${N1_ADDR}/stale-cg-test-$(date +%s)"
hr "Step 1 — fabricate a stale-state cgId on N1: '$CG_ID'"
note "Skipping /api/context-graph/create on purpose — this simulates the"
note "OLD-slot bug where SQLite/RDF writes diverged on failed on-chain reg."

hr "Step 2 — N2 signs a join-delegation against the stale cgId"
ENC_CG=$(urlenc "$CG_ID")
sign_resp=$(api "$N2" POST "/api/context-graph/$ENC_CG/sign-join" "{}")
delegation=$(echo "$sign_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('delegation') or {}))")
[ -z "$delegation" ] || [ "$delegation" = "{}" ] && fail "sign-join failed: $sign_resp"
ok "N2 produced a signed delegation"

hr "Step 3 — N2 forwards the delegation to N1 (the test moment)"
submit_body=$(python3 -c "
import sys,json
print(json.dumps({
  'delegation': json.loads('''$delegation'''),
  'curatorPeerId': '$N1_PEER_ID',
}))
")
JOIN_REQUEST_TS=$(date -u +'%Y-%m-%d %H:%M:%S')
submit_resp=$(api "$N2" POST "/api/context-graph/$ENC_CG/request-join" "$submit_body")
note "request-join response: $submit_resp"
delivered=$(echo "$submit_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('delivered',''))")
status_field=$(echo "$submit_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")

# The pre-fix behaviour: status='no-curator-found', delivered=0,
# top-level error="Could not deliver join request to curator…".
# The post-fix behaviour: status='pending', delivered=1.
if [ "$status_field" = "pending" ] && [ "$delivered" = "1" ]; then
  ok "request delivered to N1 — wallet-prefix fallback resolved curator"
else
  fail "request-join did not deliver despite stale-CG fallback (status=$status_field delivered=$delivered) — fallback regression?"
fi

hr "Step 4 — assert N1 logged the accept (observability)"
sleep 1
# Pattern matches the cgId verbatim; we deliberately quote it because
# cgIds with `/` chars must round-trip cleanly through the log line.
assert_log_recent "$N1_LOG" "$JOIN_REQUEST_TS" \
  "PROTOCOL_JOIN_REQUEST from .* for \"$CG_ID\": accepted" \
  "N1 accepted inbound request via wallet-prefix fallback" \
  || fail "N1 did not log accept — fallback may have returned null"
assert_log_recent "$N1_LOG" "$JOIN_REQUEST_TS" \
  "Stored pending join request from $N2_ADDR for \"$CG_ID\"" \
  "N1 persisted the request" \
  || fail "N1 accepted but did not persist"

hr "Step 5 — N1 lists pending requests (expect N2 present)"
reqs=$(api "$N1" GET "/api/context-graph/$ENC_CG/join-requests")
found=$(echo "$reqs" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if any(r.get('agentAddress','').lower()=='$N2_ADDR'.lower() for r in d.get('requests',[])) else 'no')
")
[ "$found" = "yes" ] && ok "N1 sees N2's pending request" || fail "N1 missing pending request: $reqs"

hr "Done — stale-CG fallback is functional"
echo "CG id used: $CG_ID"
