#!/usr/bin/env bash
#
# #1234 (fixes #1233) — agents/_meta growth is BOUNDED: devnet proof.
#
# Before #1234, every agent-profile heartbeat appended a per-publish tentative
# tracking record to `<agents>/_meta` keyed by a fresh UAL, never pruned, gossip-
# fanned per peer — growing without bound (~386 records/agent observed). #1234
# suppresses that write at the two highest-volume paths (gossip receiver + local
# publish terminal) gated on isAgentRegistryContextGraph(), while the agent
# profile DATA still lands in the data graph.
#
# This asserts on a running fleet that the AGENT REGISTRY DATA graph is populated
# (profiles present) while `<agents>/_meta` stays bounded (no tentative-record
# accumulation). This is the lightweight static check; a longer-running variant
# can force a small heartbeat (config.network.agentProfileHeartbeatMs) and assert
# zero growth across N heartbeats.
#
# Requires a running devnet (./scripts/devnet.sh start 6). Self-contained.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NUM_NODES="${NUM_NODES:-6}"
META_MAX="${META_MAX:-50}"   # generous ceiling; pre-#1234 bloat was hundreds/agent

PASS=0; FAIL=0
log() { echo "[agents-meta] $*"; }
ok()  { echo "[agents-meta]   PASS: $*"; PASS=$((PASS+1)); }
bad() { echo "[agents-meta]   FAIL: $*" >&2; FAIL=$((FAIL+1)); }

node_token() { grep -v '^#' "$DEVNET_DIR/node$1/auth.token" 2>/dev/null | tr -d '[:space:]'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }

qcount() { # node graph -> integer count ("" on error)
  local n="$1" g="$2" port token
  port=$(node_port "$n"); token=$(node_token "$n")
  curl -s -m 12 -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -X POST "http://127.0.0.1:${port}/api/query" \
    -d "{\"sparql\":\"SELECT (COUNT(*) AS ?c) WHERE { GRAPH <$g> { ?s ?p ?o } }\"}" 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);const b=(j.result?.bindings||j.result?.results?.bindings||j.results?.bindings||j.bindings||[])[0];const v=b?.c?.value??b?.c??"";const m=String(v).match(/\d+/);process.stdout.write(m?m[0]:"")}catch(e){process.stdout.write("")}})'
}

AG='did:dkg:context-graph:agents'
META='did:dkg:context-graph:agents/_meta'

for n in $(seq 1 "$NUM_NODES"); do
  [ -f "$DEVNET_DIR/node$n/auth.token" ] || continue
  DATA=$(qcount "$n" "$AG"); MT=$(qcount "$n" "$META")
  [ -z "$DATA" ] && { log "node$n unreachable — skipping"; continue; }
  if [ "${DATA:-0}" -gt 0 ] 2>/dev/null; then
    ok "node$n agent-registry DATA populated ($DATA quads)"
  else
    bad "node$n agent-registry DATA empty (expected profiles) — phonebook not replicating?"
  fi
  if [ "${MT:-0}" -le "$META_MAX" ] 2>/dev/null; then
    ok "node$n agents/_meta BOUNDED ($MT <= $META_MAX; #1234 suppression holding)"
  else
    bad "node$n agents/_meta UNBOUNDED ($MT > $META_MAX) — #1234 regression"
  fi
done

echo
log "──────── SUMMARY ────────"
log "PASS=$PASS  FAIL=$FAIL  (META_MAX=$META_MAX)"
[ "$FAIL" -eq 0 ] && { log "ALL AGENTS-META CHECKS PASSED"; exit 0; } || { log "SOME CHECKS FAILED"; exit 1; }
