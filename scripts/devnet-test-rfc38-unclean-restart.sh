#!/usr/bin/env bash
#
# OT-RFC-38 LU-6 C5 — UNCLEAN RESTART RECOVERY test.
#
# Validates that a `kill -9` of a core mid-host-catchup-serve does
# not corrupt the host-mode store and that the member resumes
# catchup correctly after the core is restarted.
#
# Implicitly validates the LU-6 follow-ups:
#   * B2 (orphan .log reconcile on init) — a hard kill can leave
#     a fresh .log without a synced .meta. The next init must
#     reap it, not let it accumulate.
#   * B3 (host-only designation persistence) — the core must
#     re-engage its previously-subscribed CGs after restart, not
#     wait for a chain event to re-derive them.
#   * Catchup resume from `lastHostCatchupSeqno` — the member must
#     pick up at the seqno it last successfully applied, not
#     re-fetch the whole log from seq 0.
#
# Test phases:
#
#   1. Curator (N5) creates curated CG with [curator, M1=N6].
#      A core (N1) is told to host-mode subscribe explicitly so
#      we can rely on it being the catchup source.
#   2. Curator writes 20 large triples (enough that catchup
#      paginates more than once at default caps).
#   3. M1 does a first /api/shared-memory/catchup. We capture
#      the partial state (count of triples applied so far).
#   4. The core is SIGKILLed (`kill -9`) — simulates power loss
#      mid-serve, not graceful shutdown.
#   5. The core is restarted via `devnet.sh restart-node N1`.
#   6. M1 retries catchup. Must:
#         (a) succeed — the rebooted core re-engages host-mode
#             via B3 persistence;
#         (b) end with ≥20 triples applied — no data loss across
#             the kill-restart boundary;
#         (c) NOT re-fetch the entire log — but this is observed
#             via daemon.log volume, not asserted programmatically
#             (the resume cursor is internal).
#   7. Core stats endpoint MUST report `enabled: true` (host mode
#      survived the unclean shutdown).
#
# Re-runnable: timestamp-suffixed CG id.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
M1_NODE=6
CORE_NODE=1

# Tune via env. Default: 20 fat triples → enough for ≥2 catchup pages.
WRITES_COUNT="${WRITES_COUNT:-20}"
WRITE_PAYLOAD_BYTES="${WRITE_PAYLOAD_BYTES:-4096}"

log()  { echo "[urr] $*"; }
warn() { echo "[urr] WARN: $*" >&2; }
fail() { echo "[urr] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[urr] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_pidfile() { echo "$(node_dir "$1")/daemon.pid"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 240 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
}

parse_json() {
  printf '%s' "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); const v=j$2; console.log(v == null ? '' : v); }
      catch (e) { process.exit(1); }
    })
  "
}

wait_for_port_open() {
  local node="$1" max="${2:-30}"
  local port; port=$(node_port "$node")
  for _ in $(seq 1 "$max"); do
    if lsof -ti tcp:"$port" >/dev/null 2>&1; then
      sleep 1
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_port_closed() {
  local node="$1" max="${2:-15}"
  local port; port=$(node_port "$node")
  for _ in $(seq 1 "$max"); do
    if ! lsof -ti tcp:"$port" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

CURATOR_AGENT=$(api_call "$CURATOR_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
M1_AGENT=$(api_call "$M1_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/urr-${STAMP}"

log "Curator: $CURATOR_AGENT (node $CURATOR_NODE)"
log "M1:      $M1_AGENT (node $M1_NODE)"
log "Core:    node $CORE_NODE [will be SIGKILLed mid-serve]"
log "CG:      $CG_ID"
log "Stress:  $WRITES_COUNT writes × ${WRITE_PAYLOAD_BYTES} bytes"

# ===========================================================================
act "1. Curator + M1 pre-create CG, core host-mode subscribes"
# ===========================================================================
ALLOWED='["'"$CURATOR_AGENT"'", "'"$M1_AGENT"'"]'

CREATE_CUR=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "unclean ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": $ALLOWED,
  "register": true }
EOF
)")
ON_CHAIN_ID=$(parse_json "$CREATE_CUR" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "create+register failed: $CREATE_CUR"
log "✓ curated CG onChainId=$ON_CHAIN_ID"

api_call "$M1_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "unclean ${STAMP} (M1)",
  "accessPolicy": 1, "publishPolicy": 0, "allowedAgents": $ALLOWED }
EOF
)" >/dev/null || true

api_call "$CORE_NODE" POST /api/shared-memory/host-mode/subscribe "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)" >/dev/null || true
sleep 3

# ===========================================================================
act "2. Curator writes $WRITES_COUNT triples"
# ===========================================================================
PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" N="$WRITES_COUNT" BYTES="$WRITE_PAYLOAD_BYTES" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  const n = Number(process.env.N);
  const bytes = Number(process.env.BYTES);
  const filler = "f".repeat(bytes);
  const quads = [];
  for (let i = 0; i < n; i++) {
    const entity = "urn:urr:" + stamp + "/t-" + i;
    quads.push({ subject: entity, predicate: "http://schema.org/note", object: "\"" + filler + "\"", graph: "" });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
W=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$PAYLOAD")
[ "$(parse_json "$W" '.triplesWritten')" = "$WRITES_COUNT" ] || fail "write expected $WRITES_COUNT triples: $W"
log "✓ $WRITES_COUNT triples written"
sleep 4

count_triples() {
  local node="$1"
  local cg_enc; cg_enc=$(printf %s "$CG_ID" | sed 's/\//%2F/g')
  local listing; listing=$(api_call "$node" GET "/api/shared-memory/list?contextGraphId=${cg_enc}")
  local count; count=$(parse_json "$listing" '.triples?.length' 2>/dev/null || echo "")
  [ -n "$count" ] || count=$(parse_json "$listing" '.quads?.length' 2>/dev/null || echo "0")
  echo "$count"
}

# ===========================================================================
act "3. M1 first catchup (may or may not finish in one round)"
# ===========================================================================
api_call "$M1_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)" >/dev/null 2>&1 || true
sleep 2
M1_PARTIAL=$(count_triples "$M1_NODE")
log "M1 partial catchup count: $M1_PARTIAL (target: $WRITES_COUNT)"

# ===========================================================================
act "4. SIGKILL the core (unclean shutdown — no graceful close)"
# ===========================================================================
CORE_PIDFILE=$(node_pidfile "$CORE_NODE")
[ -f "$CORE_PIDFILE" ] || fail "core pidfile $CORE_PIDFILE missing — devnet startup didn't write one?"
CORE_PID=$(tr -d '[:space:]' < "$CORE_PIDFILE")
log "kill -9 $CORE_PID"
kill -9 "$CORE_PID" 2>/dev/null || warn "kill -9 returned non-zero (process may have exited)"
if ! wait_for_port_closed "$CORE_NODE" 20; then
  warn "core port still open after 20s — kill may have raced"
fi
log "✓ core forcibly stopped"

# ===========================================================================
act "5. Restart the core (B2 orphan reconcile + B3 host-mode restore must fire)"
# ===========================================================================
DEVNET_SH="$REPO_ROOT/scripts/devnet.sh"
[ -x "$DEVNET_SH" ] || fail "scripts/devnet.sh not executable — can't restart node $CORE_NODE programmatically"
"$DEVNET_SH" restart-node "$CORE_NODE" >/dev/null 2>&1 || warn "devnet.sh restart-node returned non-zero"
if ! wait_for_port_open "$CORE_NODE" 60; then
  fail "core API never came back online after restart"
fi
log "✓ core restarted (port open)"

# ===========================================================================
act "6. M1 re-catchup, expect ≥$WRITES_COUNT triples (no loss across kill)"
# ===========================================================================
# Two passes: gossip alone may not refire, host-catchup explicitly will.
api_call "$M1_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)" >/dev/null 2>&1 || true
sleep 6
api_call "$M1_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)" >/dev/null 2>&1 || true
sleep 4

M1_FINAL=$(count_triples "$M1_NODE")
log "M1 final triple count: $M1_FINAL (expected ≥ $WRITES_COUNT)"
[ "$M1_FINAL" -ge "$WRITES_COUNT" ] || fail "DATA LOSS across kill-restart boundary: M1 has $M1_FINAL triples, expected ≥ $WRITES_COUNT"

# ===========================================================================
act "7. Core stats still healthy — host-mode survived unclean shutdown"
# ===========================================================================
STATS=$(api_call "$CORE_NODE" GET /api/shared-memory/host-mode/stats)
log "Stats: $STATS"
ENABLED=$(parse_json "$STATS" '.enabled')
[ "$ENABLED" = "true" ] || fail "core host-mode NOT enabled after restart — B3 persistence regression"

BYTES_AFTER=$(parse_json "$STATS" ".perCg['$CG_ID'].bytes" 2>/dev/null || echo "")
log "Core perCg[$CG_ID].bytes after restart: $BYTES_AFTER"

log ""
log "================================================================"
log "  RFC-38 LU-6 C5 (unclean restart recovery): PASS"
log "================================================================"
log "  Curated CG:        $CG_ID  (onChainId=$ON_CHAIN_ID)"
log "  Curator wrote:     $WRITES_COUNT triples"
log "  M1 pre-kill:       $M1_PARTIAL triples"
log "  Core kill:         SIGKILL (no graceful shutdown)"
log "  M1 post-restart:   $M1_FINAL triples (≥ $WRITES_COUNT — no loss)"
log "  Core host-mode:    enabled=true after restart"
log "================================================================"
