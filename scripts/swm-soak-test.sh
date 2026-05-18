#!/usr/bin/env bash
# swm-soak-test.sh — SWM share reliability soak across the mesh
#
# Validates the SWM Reliable Fan-out plan (RFC-003) end-to-end:
# each participating peer writes one tagged quad per cycle to each
# configured context graph, then samples its local SWM to count
# how many writes from other peers actually arrived. Final report
# computes per-peer + aggregate delivery rate, with the ship-gate
# being ≥99.9% within the soak window.
#
# Topology assumptions
# --------------------
# Multiple operators run this script in parallel against their own
# daemons, all participating in the same set of context graphs.
# The CGs must already exist on every daemon and every participating
# peer must be subscribed to them (and, for curated CGs, on the
# allowlist). This script does NOT create or join CGs — operators
# coordinate that out-of-band (see SETUP STEPS below). Doing it in-
# script would require chain RPC + a shared bootstrap leader, which
# is friction we don't need for an ephemeral validation run.
#
# What it measures
# ----------------
# Three slices of /api/slo per cycle (rc.9 PR-A extended the shape):
#   - protocols.* — substrate sendReliable latencies + delivered/queued
#     counters per protocol (chat, swm-key, swm-update once PR-C lands,
#     swm-share-ack once PR-D lands)
#   - gossip.publishFailures — per-cgId count of failed gossip.publish
#     calls (was silently swallowed pre-PR-A; loud now)
#   - swm.redundantApplies — per-cgId count of (cgId, shareOpId)
#     pairs seen twice within TTL. Informs the Concern-2 dedup
#     decision in RFC-003
#
# Plus per-CG SPARQL snapshot of "how many tagged quads from non-self
# peers exist in our local SWM graph", which is the ground-truth
# delivery measurement.
#
# Expected setup (SETUP STEPS)
# ----------------------------
# 1. One operator creates each CG and shares the cgId out-of-band:
#    pnpm dkg context create \
#      --name "swm-soak-curated" \
#      --allowed-peer 12D3KooWPeer1 --allowed-peer 12D3KooWPeer2 ...
#    (for curated CGs — include EVERY participant's peerId)
#
#    pnpm dkg context create --name "swm-soak-public"
#    (for public CGs — anyone who subscribes can join)
#
# 2. Every participating operator subscribes locally:
#    pnpm dkg context subscribe <cgId>
#
# 3. Every operator confirms via `pnpm dkg context list` that they
#    see both CGs and have the expected role (member for curated,
#    subscriber for public).
#
# 4. Run this script in parallel on every participant. They will
#    each write 1 tagged quad/cycle/CG and observe the others'
#    writes via local SWM.
#
# Defaults: 1440 cycles × 30s = 12h. Aggressive enough to surface
# the rc8-postmortem "shares disappear" pathology if it recurs.
#
# Override via env vars:
#   SWM_CG_CURATED   comma-separated curated CG ids (default: empty)
#   SWM_CG_PUBLIC    comma-separated public CG ids   (default: empty)
#   SWM_INTERVAL_S   seconds between cycles          (default: 30)
#   SWM_TOTAL_CYCLES number of write cycles          (default: 1440)
#   SENDER_TAG       label used in subject URI + log (default: MILES)
#   PEERS_EXPECTED   comma-separated peer tags (other ops) for
#                    per-peer delivery breakdown in summary (optional)
#
# At least one of SWM_CG_CURATED / SWM_CG_PUBLIC MUST be set.
#
# Usage
# -----
#   nohup caffeinate -i bash scripts/swm-soak-test.sh \
#     SWM_CG_CURATED=swm-soak-curated \
#     SWM_CG_PUBLIC=swm-soak-public \
#     SENDER_TAG=MILES \
#     PEERS_EXPECTED=LEX,HERMES,ARX \
#     >> ~/.dkg/swm-soak-test.out 2>&1 &
#   disown
#
# Stop early: pkill -f swm-soak-test.sh

set -uo pipefail

for kv in "$@"; do
  case "$kv" in
    *=*) export "$kv" ;;
  esac
done

SWM_CG_CURATED="${SWM_CG_CURATED:-}"
SWM_CG_PUBLIC="${SWM_CG_PUBLIC:-}"
SWM_INTERVAL_S="${SWM_INTERVAL_S:-30}"
SWM_TOTAL_CYCLES="${SWM_TOTAL_CYCLES:-1440}"
SENDER_TAG="${SENDER_TAG:-MILES}"
PEERS_EXPECTED="${PEERS_EXPECTED:-}"

DKG_HOME="${DKG_HOME:-${HOME}/.dkg}"
API="${API:-http://127.0.0.1:9200}"
AUTH=$(grep -v '^#' "${DKG_HOME}/auth.token" | head -1)

if [ -z "$SWM_CG_CURATED" ] && [ -z "$SWM_CG_PUBLIC" ]; then
  echo "ERROR: at least one of SWM_CG_CURATED or SWM_CG_PUBLIC must be set" >&2
  exit 64
fi

LOG_DIR="${DKG_HOME}/swm-soak-test-$(date -u +%Y%m%d-%H%M%S)-${SENDER_TAG}"
mkdir -p "$LOG_DIR"
echo "$$" > "$LOG_DIR/pid"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" \
    | tee -a "$LOG_DIR/main.log"
}

SELF_PEER_ID=$(curl -s --max-time 5 "$API/api/info" -H "Authorization: Bearer $AUTH" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('peerId',''))" 2>/dev/null)
if [ -z "$SELF_PEER_ID" ]; then
  log "WARN: could not resolve self peerId from /api/info; SPARQL self-exclusion will use SENDER_TAG only"
fi

# Each peer's writes use a subject URI of the form
#   urn:swm-soak:<TAG>:<seq>
# which uniquely identifies the writer + cycle within a CG. We do
# NOT embed cgId in the subject because cgIds can legally contain
# colons (see validateContextGraphId) which would defeat the
# downstream regex. The cgId is implicit because each share goes
# into that CG's named SWM graph; the receiver SPARQLs each CG's
# SWM graph individually so subject collisions across CGs are
# irrelevant. The receiver tally filters out subjects whose tag
# matches its own SENDER_TAG (self-share sanity check).
subject_for_cycle() {
  local _cgId=$1 seq=$2
  printf 'urn:swm-soak:%s:%05d' "$SENDER_TAG" "$seq"
}

write_one_share() {
  local cgId=$1 seq=$2 total=$3
  local ts subject body resp
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  subject=$(subject_for_cycle "$cgId" "$seq")
  body=$(python3 -c "
import json
print(json.dumps({
  'contextGraphId': '$cgId',
  'quads': [{
    'subject': '$subject',
    'predicate': 'urn:swm-soak:sentBy',
    'object': '\"$SENDER_TAG\"',
    'graph': '',
  }, {
    'subject': '$subject',
    'predicate': 'urn:swm-soak:sentAt',
    'object': '\"$ts\"',
    'graph': '',
  }, {
    'subject': '$subject',
    'predicate': 'urn:swm-soak:seq',
    'object': '\"$seq/$total\"',
    'graph': '',
  }],
}))
")
  resp=$(curl -s --max-time 30 -X POST "$API/api/shared-memory/write" \
    -H "Authorization: Bearer $AUTH" \
    -H "Content-Type: application/json" \
    -d "$body")
  printf '{"cgId":"%s","seq":%d,"sent_ts":"%s","subject":"%s","resp":%s}\n' \
    "$cgId" "$seq" "$ts" "$subject" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/writes.jsonl"
  local ok
  ok=$(printf '%s' "$resp" | python3 -c "
import json, sys
try:
  d = json.loads(sys.stdin.read())
  print('ok' if d.get('shareOperationId') else 'fail')
except: print('fail')
" 2>/dev/null)
  log "  write cg=$cgId seq=$seq → $ok"
}

snapshot_swm_inbox() {
  # SPARQL the SWM graph for each configured CG. Counts:
  #   - total tagged quads (any sender)
  #   - per-sender breakdown (sender tag extracted from subject URI)
  # SELECT against the SWM named graph. The "tag" is extracted from
  # the subject pattern urn:swm-soak:<cgId>:<TAG>:<seq>.
  local label=$1 cgId=$2 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local swm_graph="did:dkg:context-graph:${cgId}/_shared_memory"
  local sparql="SELECT ?s WHERE { GRAPH <${swm_graph}> { ?s <urn:swm-soak:sentBy> ?tag } }"
  local body resp
  body=$(python3 -c "import json; print(json.dumps({'sparql': '''$sparql''', 'contextGraphId': '$cgId'}))")
  resp=$(curl -s --max-time 30 -X POST "$API/api/query" \
    -H "Authorization: Bearer $AUTH" \
    -H "Content-Type: application/json" \
    -d "$body")
  printf '{"label":"%s","cgId":"%s","ts":"%s","data":%s}\n' \
    "$label" "$cgId" "$ts" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/swm-inbox.jsonl"
  local summary
  summary=$(printf '%s' "$resp" | python3 -c "
import json, re, sys, os
self_tag = '$SENDER_TAG'
try:
  d = json.loads(sys.stdin.read())
  rows = d.get('bindings', []) if isinstance(d, dict) else (d.get('result', {}) or {}).get('bindings', [])
  by_tag = {}
  for r in rows:
    s = r.get('s', '')
    if isinstance(s, dict): s = s.get('value','')
    s = s.strip('<>')
    m = re.match(r'^urn:swm-soak:([^:]+):(\d+)$', s)
    if not m: continue
    tag, seq = m.group(1), m.group(2)
    by_tag.setdefault(tag, set()).add(seq)
  parts = []
  for tag in sorted(by_tag):
    n = len(by_tag[tag])
    parts.append(f'{tag}={n}{\" (self)\" if tag == self_tag else \"\"}')
  if not parts:
    print('inbox=empty')
  else:
    print('cg=' + '$cgId' + ' rows=' + str(sum(len(v) for v in by_tag.values())) + ' breakdown[' + ', '.join(parts) + ']')
except Exception as e:
  print(f'inbox=err({e})')
" 2>/dev/null)
  log "  swm-inbox snapshot ($label): $summary"
}

snapshot_slo() {
  # rc.9 PR-A extended /api/slo from {protocols} to
  # {protocols, gossip, swm}. This script consumes all three:
  #   - protocols.* — substrate sendReliable latencies per protocol
  #   - gossip.publishFailures — per-cgId silent-failure counter
  #   - swm.redundantApplies — per-cgId redundant-delivery counter
  local label=$1 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local resp
  resp=$(curl -s --max-time 10 "${API}/api/slo" \
    -H "Authorization: Bearer $AUTH")
  printf '{"label":"%s","ts":"%s","data":%s}\n' \
    "$label" "$ts" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/slo.jsonl"
  local summary
  summary=$(printf '%s' "$resp" | python3 -c "
import json, sys
try:
  d = json.loads(sys.stdin.read())
  protos = (d or {}).get('protocols', {}) or {}
  gossip = (d or {}).get('gossip', {}) or {}
  swm = (d or {}).get('swm', {}) or {}
  parts = []
  for proto, s in sorted(protos.items()):
    short = proto.split('/')[-1]
    p99 = s.get('p99Ms')
    p99_s = f'{p99}ms' if p99 is not None else 'n/a'
    parts.append(f'{short}=d{s.get(\"delivered\", 0)}/q{s.get(\"queued\", 0)} p99={p99_s}')
  pubfail_total = sum((gossip.get('publishFailures') or {}).values())
  redundant_total = sum((swm.get('redundantApplies') or {}).values())
  proto_s = ' '.join(parts) if parts else '(no substrate traffic yet)'
  print(f'slo: {proto_s} | gossip.failures={pubfail_total} | swm.redundant={redundant_total}')
except Exception as e:
  print(f'slo=err({e})')
" 2>/dev/null)
  log "  $summary"
}

split_cgs() {
  local raw=$1
  if [ -z "$raw" ]; then return; fi
  printf '%s' "$raw" | tr ',' '\n' | sed '/^$/d'
}

ALL_CGS=()
while IFS= read -r cg; do ALL_CGS+=("$cg"); done < <(split_cgs "$SWM_CG_CURATED")
while IFS= read -r cg; do ALL_CGS+=("$cg"); done < <(split_cgs "$SWM_CG_PUBLIC")

trap 'log "INTERRUPTED — stopping at cycle ${seq:-?}"; exit 130' INT TERM

log "=== START swm-soak-test ==="
log "  sender_tag=$SENDER_TAG"
log "  self_peer_id=${SELF_PEER_ID:-<unresolved>}"
log "  curated_cgs=${SWM_CG_CURATED:-<none>}"
log "  public_cgs=${SWM_CG_PUBLIC:-<none>}"
log "  total_cycles=$SWM_TOTAL_CYCLES"
log "  interval_s=$SWM_INTERVAL_S"
log "  peers_expected=${PEERS_EXPECTED:-<unset, summary skips per-peer breakdown>}"
log "  log_dir=$LOG_DIR"
log "  pid=$$"
log ""
log "Baseline SLO + inbox snapshot (before first write):"
for cg in "${ALL_CGS[@]}"; do snapshot_swm_inbox "baseline" "$cg"; done
snapshot_slo "baseline"
log ""

for seq in $(seq 1 "$SWM_TOTAL_CYCLES"); do
  log "--- CYCLE $seq/$SWM_TOTAL_CYCLES ---"
  for cg in "${ALL_CGS[@]}"; do
    write_one_share "$cg" "$seq" "$SWM_TOTAL_CYCLES"
  done
  sleep 5
  for cg in "${ALL_CGS[@]}"; do
    snapshot_swm_inbox "post-cycle-$seq" "$cg"
  done
  snapshot_slo "post-cycle-$seq"
  if [ "$seq" -lt "$SWM_TOTAL_CYCLES" ]; then
    sleep "$SWM_INTERVAL_S"
  fi
done

log ""
log "All cycles done. Waiting 5min for any late inbound to settle (gossip mesh, substrate retries, runSyncOnConnect catch-up)..."
sleep 300
for cg in "${ALL_CGS[@]}"; do snapshot_swm_inbox "final" "$cg"; done
snapshot_slo "final"

log ""
log "=== END swm-soak-test ==="
log ""
log "Summary:"
writes_total=$(wc -l < "$LOG_DIR/writes.jsonl" | tr -d ' ')
log "  total writes attempted: $writes_total"
writes_ok=$(grep -c '"shareOperationId"' "$LOG_DIR/writes.jsonl" 2>/dev/null || echo 0)
log "  writes accepted by local daemon: $writes_ok"
log ""
log "Per-CG final inbox (delivery validation — operators cross-reference):"
log ""
python3 <<PYTHON | tee -a "$LOG_DIR/main.log"
import json, os, re
log_dir = "$LOG_DIR"
self_tag = "$SENDER_TAG"
peers_expected = [p.strip() for p in "$PEERS_EXPECTED".split(',') if p.strip()]
cycles = $SWM_TOTAL_CYCLES

by_cg_final = {}
try:
  with open(os.path.join(log_dir, 'swm-inbox.jsonl')) as f:
    for line in f:
      rec = json.loads(line)
      if rec.get('label') != 'final': continue
      cg = rec['cgId']
      rows = (rec.get('data') or {}).get('bindings') or []
      by_tag = {}
      for r in rows:
        s = r.get('s', '')
        if isinstance(s, dict): s = s.get('value', '')
        s = s.strip('<>')
      m = re.match(r'^urn:swm-soak:([^:]+):(\d+)$', s)
      if not m: continue
      tag, seq = m.group(1), m.group(2)
      by_tag.setdefault(tag, set()).add(seq)
    by_cg_final[cg] = by_tag
except FileNotFoundError:
  print('  (no swm-inbox.jsonl)')

for cg, by_tag in sorted(by_cg_final.items()):
  print(f'  cg={cg}:')
  print(f'    self ({self_tag}): {len(by_tag.get(self_tag, set()))}/{cycles} (sanity-check: should equal total writes)')
  others_seen = sorted(t for t in by_tag if t != self_tag)
  if peers_expected:
    for peer in peers_expected:
      got = len(by_tag.get(peer, set()))
      pct = (got / cycles * 100.0) if cycles else 0.0
      flag = '' if pct >= 99.9 else '  [BELOW 99.9% — review postmortem]'
      print(f'    from {peer}: {got}/{cycles} = {pct:.2f}%{flag}')
    unexpected = [t for t in others_seen if t not in peers_expected]
    if unexpected:
      print(f'    unexpected senders observed: {unexpected}')
  else:
    for t in others_seen:
      got = len(by_tag.get(t, set()))
      pct = (got / cycles * 100.0) if cycles else 0.0
      flag = '' if pct >= 99.9 else '  [BELOW 99.9%]'
      print(f'    from {t}: {got}/{cycles} = {pct:.2f}%{flag}')
PYTHON
log ""
log "Detailed logs:"
log "  writes:     $LOG_DIR/writes.jsonl"
log "  swm-inbox:  $LOG_DIR/swm-inbox.jsonl  (per-cycle SPARQL snapshots of each CG's local SWM)"
log "  slo:        $LOG_DIR/slo.jsonl        (per-cycle /api/slo: protocols + gossip + swm sections)"
log "  trace:      $LOG_DIR/main.log"
