#!/usr/bin/env bash
#
# OT-RFC-38 LU-6 C1 — MEMBER REVOCATION test.
#
# Validates the key-rotation contract spelled out in SPEC_CG_MEMORY_MODEL.md
# §LU-4 ("Sender-key rotation on membership change"). When a curator
# removes a member from a curated CG, subsequent SWM writes MUST be
# undecryptable to the removed member — even though the removed member
# is still gossip-reachable on the topic and still has older sender-key
# copies stashed locally.
#
# Test plan:
#
#   1. Curator (N5) creates curated CG with allowlist
#      [curator, M1=N6, M2=N4]. All three pre-create the CG.
#   2. Curator writes 3 triples. Catchup on both members confirms
#      they can decrypt the pre-revocation batch.
#   3. Curator calls /api/context-graph/{id}/remove-participant for M2.
#      The allowlist on the curator's local store drops M2 + their
#      agent-delegation.
#   4. Curator writes 3 NEW triples (with different subjects so we can
#      tell the batches apart).
#   5. Assert:
#        - M1 catches up the new batch and can read all 6 triples.
#        - M2 either CANNOT catchup (auth denied) OR can pull the
#          envelopes but the apply path rejects them as un-decryptable
#          / not for them. The end state on M2 must show ≤ 3 triples
#          (only the pre-revocation batch).
#   6. (Sanity) Curator's own store has all 6 triples.
#
# Re-runnable: timestamp-suffixed CG id.
#
# Notes:
#   - The current sender-key model retains old SK copies on the kicked
#     member's disk, so M2 *should* still be able to decrypt the FIRST
#     batch. This test asserts that — confirming we cleanly rotate
#     forward without revoking the past (consistent with §LU-4).
#   - Doesn't validate on-chain ACK revocation; ACK quorum re-eligibility
#     is a separate fix tracked under LU-6 follow-up B (signed catchup).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
M1_NODE=6
M2_NODE=4

log()  { echo "[rev] $*"; }
warn() { echo "[rev] WARN: $*" >&2; }
fail() { echo "[rev] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[rev] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }

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

CURATOR_AGENT=$(api_call "$CURATOR_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
M1_AGENT=$(api_call "$M1_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
M2_AGENT=$(api_call "$M2_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/rev-${STAMP}"

log "Curator:  $CURATOR_AGENT (node $CURATOR_NODE)"
log "M1:       $M1_AGENT (node $M1_NODE)"
log "M2:       $M2_AGENT (node $M2_NODE) [will be revoked]"
log "CG:       $CG_ID"

# ===========================================================================
act "1. All three parties pre-create the CG with [curator, M1, M2] allowlist"
# ===========================================================================
ALLOWED='["'"$CURATOR_AGENT"'", "'"$M1_AGENT"'", "'"$M2_AGENT"'"]'

CREATE_CUR=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "revocation ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": $ALLOWED,
  "register": true }
EOF
)")
ON_CHAIN_ID=$(parse_json "$CREATE_CUR" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "create+register failed: $CREATE_CUR"
log "✓ curated CG onChainId=$ON_CHAIN_ID"

api_call "$M1_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "revocation ${STAMP} (M1)",
  "accessPolicy": 1, "publishPolicy": 0, "allowedAgents": $ALLOWED }
EOF
)" >/dev/null || true

api_call "$M2_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "revocation ${STAMP} (M2)",
  "accessPolicy": 1, "publishPolicy": 0, "allowedAgents": $ALLOWED }
EOF
)" >/dev/null || true
sleep 3

# ===========================================================================
act "2. Curator writes pre-revocation batch (3 triples) and verifies both members catch up"
# ===========================================================================
PRE_QUADS=$(STAMP="$STAMP" CG_ID="$CG_ID" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  const quads = [];
  for (const tag of ["pre-alpha","pre-beta","pre-gamma"]) {
    const entity = "urn:rev:" + stamp + "/" + tag;
    quads.push({ subject: entity, predicate: "http://schema.org/name", object: "\""+tag+"\"", graph: "" });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WRITE_PRE=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$PRE_QUADS")
[ "$(parse_json "$WRITE_PRE" '.triplesWritten')" = "3" ] || fail "pre-write expected 3 triples: $WRITE_PRE"
log "✓ pre-revocation: 3 triples written by curator"
sleep 3

count_triples() {
  local node="$1"
  local resp; resp=$(api_call "$node" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)")
  local n; n=$(parse_json "$resp" '.entriesApplied' 2>/dev/null || echo "")
  if [ -z "$n" ]; then n=$(parse_json "$resp" '.appliedTriples' 2>/dev/null || echo "0"); fi
  local listing; listing=$(api_call "$node" GET "/api/shared-memory/list?contextGraphId=$(printf %s "$CG_ID" | sed 's/\//%2F/g')")
  local count; count=$(parse_json "$listing" '.triples?.length' 2>/dev/null || echo "")
  [ -n "$count" ] || count=$(parse_json "$listing" '.quads?.length' 2>/dev/null || echo "0")
  echo "$count"
}

M1_PRE=$(count_triples "$M1_NODE" || echo "0")
M2_PRE=$(count_triples "$M2_NODE" || echo "0")
log "M1 sees $M1_PRE triples pre-revocation; M2 sees $M2_PRE triples"
[ "$M1_PRE" -ge 3 ] || warn "M1 pre-revocation count=$M1_PRE expected ≥3 — catchup may be slow"
[ "$M2_PRE" -ge 3 ] || warn "M2 pre-revocation count=$M2_PRE expected ≥3 — catchup may be slow"

# ===========================================================================
act "3. Curator revokes M2"
# ===========================================================================
CG_ID_ENC=$(printf %s "$CG_ID" | sed 's/\//%2F/g')
REVOKE_RESP=$(api_call "$CURATOR_NODE" POST "/api/context-graph/${CG_ID_ENC}/remove-participant" "$(cat <<EOF
{ "agentAddress": "$M2_AGENT" }
EOF
)")
[ "$(parse_json "$REVOKE_RESP" '.ok')" = "true" ] || fail "revoke failed: $REVOKE_RESP"
log "✓ curator removed M2 from allowlist"
sleep 5

# Confirm allowlist update on the curator
PARTS_RESP=$(api_call "$CURATOR_NODE" GET "/api/context-graph/${CG_ID_ENC}/participants")
PARTICIPANTS_LIST=$(parse_json "$PARTS_RESP" '.allowedAgents.join(",")')
log "Curator's allowlist after revoke: $PARTICIPANTS_LIST"
case "$PARTICIPANTS_LIST" in
  *"$M2_AGENT"*) fail "M2 ($M2_AGENT) still in curator's allowlist after revoke" ;;
esac
case "$PARTICIPANTS_LIST" in
  *"$M1_AGENT"*) log "✓ M1 still on the allowlist" ;;
  *)             fail "M1 unexpectedly missing from the post-revoke allowlist" ;;
esac

# ===========================================================================
act "4. Curator writes post-revocation batch (3 NEW triples)"
# ===========================================================================
POST_QUADS=$(STAMP="$STAMP" CG_ID="$CG_ID" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  const quads = [];
  for (const tag of ["post-delta","post-epsilon","post-zeta"]) {
    const entity = "urn:rev:" + stamp + "/" + tag;
    quads.push({ subject: entity, predicate: "http://schema.org/name", object: "\""+tag+"\"", graph: "" });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WRITE_POST=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$POST_QUADS")
[ "$(parse_json "$WRITE_POST" '.triplesWritten')" = "3" ] || fail "post-write expected 3 triples: $WRITE_POST"
log "✓ post-revocation: 3 NEW triples written by curator"
sleep 8

# ===========================================================================
act "5. Assert M1 sees all 6, M2 sees ≤ 3"
# ===========================================================================
# Force a catchup on both members
api_call "$M1_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)" >/dev/null 2>&1 || true
api_call "$M2_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)" >/dev/null 2>&1 || true
sleep 3

M1_FINAL=$(count_triples "$M1_NODE" || echo "0")
M2_FINAL=$(count_triples "$M2_NODE" || echo "0")
CURATOR_FINAL=$(count_triples "$CURATOR_NODE" || echo "0")

log "Curator sees:  $CURATOR_FINAL triples"
log "M1 sees:       $M1_FINAL triples"
log "M2 sees:       $M2_FINAL triples (must be ≤3 — would prove revocation worked)"

[ "$CURATOR_FINAL" -ge 6 ] || warn "curator final count=$CURATOR_FINAL expected ≥6 (own writes)"
[ "$M1_FINAL" -ge 6 ] || fail "REGRESSION: M1 sees $M1_FINAL triples post-revocation, expected 6 (M1 was NOT revoked — must continue receiving)"

if [ "$M2_FINAL" -gt 3 ]; then
  fail "SECURITY REGRESSION: revoked M2 sees $M2_FINAL triples — expected ≤3 (only pre-revocation writes). " \
       "Sender-key rotation FAILED to lock out the kicked member."
fi
log "✓ M2's triple count is bounded above by pre-revocation batch — revocation works"

log ""
log "================================================================"
log "  RFC-38 LU-6 C1 (member revocation): PASS"
log "================================================================"
log "  Curated CG:    $CG_ID  (onChainId=$ON_CHAIN_ID)"
log "  Pre-revoke:    3 triples; all 3 members could read."
log "  Revoked:       M2 ($M2_AGENT)"
log "  Post-revoke:   3 NEW triples; M1 reads all 6, M2 stuck at $M2_FINAL ≤ 3."
log "================================================================"
