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
# Per-run isolation (rc.9 PR-A Codex follow-up #5)
# ------------------------------------------------
# Each invocation generates its own RUN_ID + SOAK_START_ISO; every
# write tags itself with `urn:swm-soak:runId "<RUN_ID>"`, and every
# tally SPARQL filters on `sentAt >= "<SOAK_START_ISO>"` to exclude
# pre-soak `swm-soak` rows that may already be sitting in
# `_shared_memory`. Without this, rerunning the script against a CG
# that hosted a prior soak (or two operators reusing the same
# SENDER_TAG across runs) made stale deliveries inflate the
# final-percentage report.
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

# Codex PR #572 R3 + R4: fail fast on missing/empty auth token.
# Pre-fix the script omitted `set -e` AND did not validate the
# token, so a missing or comments-only `auth.token` degraded into a
# 12h run of unauthorized reads/writes returning empty JSON, which
# then showed up as misleading zero-delivery output. Now: explicit
# file-exists + non-empty checks BEFORE the long-running loop,
# matching the precedent in scripts/devnet-test.sh.
#
# Codex PR #572 R4 also flagged the parser itself: `grep -v '^#'
# | head -1` returns an empty string when the first non-comment
# line is blank (`# header\n\ntoken` is a real shape that
# devnet.sh writes). The replacement filters BOTH comments AND
# blank/whitespace-only lines, then takes the first surviving
# line, then trims surrounding whitespace.
AUTH_TOKEN_FILE="${DKG_HOME}/auth.token"
if [ ! -f "$AUTH_TOKEN_FILE" ]; then
  echo "ERROR: auth token file not found at ${AUTH_TOKEN_FILE}." >&2
  echo "       Start the daemon first ('pnpm dkg start') so it provisions the token, or export AUTH=<token> before running." >&2
  exit 65
fi
AUTH=$(awk '
  # Codex PR #572 R4: first non-empty, non-comment line, trimmed.
  /^[[:space:]]*#/ { next }   # drop comment lines
  /^[[:space:]]*$/ { next }   # drop blank/whitespace-only lines
  { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print; exit }
' "$AUTH_TOKEN_FILE")
if [ -z "$AUTH" ]; then
  echo "ERROR: ${AUTH_TOKEN_FILE} exists but contains no usable token (after stripping # comments and blank lines)." >&2
  echo "       Inspect the file and re-provision via 'pnpm dkg start'." >&2
  exit 65
fi

if [ -z "$SWM_CG_CURATED" ] && [ -z "$SWM_CG_PUBLIC" ]; then
  echo "ERROR: at least one of SWM_CG_CURATED or SWM_CG_PUBLIC must be set" >&2
  exit 64
fi

# Codex PR #572 R5: each soak run gets a fresh RUN_ID so the
# delivery-tally SPARQL can distinguish the current run from older
# `swm-soak` writes already sitting in `_shared_memory`. Without
# this, rerunning against the same CG (or two operators reusing the
# same SENDER_TAG) makes stale rows count as current-run deliveries
# and silently inflates the final percentage. We embed the RUN_ID
# as a third quad (`urn:swm-soak:runId`) on every write AND record
# SOAK_START_ISO so the SPARQL can additionally exclude pre-soak
# writes from ANY peer (so we catch other operators' fresh writes
# without needing to know their RUN_ID, while still rejecting their
# pre-soak leftovers).
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(hostname -s 2>/dev/null || hostname)-$$-${SENDER_TAG}"
SOAK_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
  }, {
    # Codex PR #572 R5: writer-side RUN_ID tag so downstream tally
    # queries can distinguish current-run writes from stale rows
    # left in _shared_memory by a prior soak.
    'subject': '$subject',
    'predicate': 'urn:swm-soak:runId',
    'object': '\"$RUN_ID\"',
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
  # the subject pattern urn:swm-soak:<TAG>:<seq>.
  #
  # Codex PR #572 R5: filter on `sentAt >= SOAK_START_ISO` so the
  # query excludes pre-soak `swm-soak` writes left in
  # `_shared_memory` by prior runs. This catches OTHER operators'
  # current-run writes without needing to know their RUN_ID, while
  # still rejecting everybody's pre-soak leftovers. Pre-fix, a
  # rerun against the same CG (or a different operator reusing the
  # same SENDER_TAG) made stale rows count as current-run
  # deliveries and inflated the final percentage.
  local label=$1 cgId=$2 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local swm_graph="did:dkg:context-graph:${cgId}/_shared_memory"
  local sparql
  sparql=$(cat <<SPARQL
SELECT DISTINCT ?s WHERE {
  GRAPH <${swm_graph}> {
    ?s <urn:swm-soak:sentBy> ?tag ;
       <urn:swm-soak:sentAt> ?sentAt .
    FILTER(STR(?sentAt) >= "${SOAK_START_ISO}")
  }
}
SPARQL
)
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
  # Codex PR #572 R1: /api/query wraps SPARQL results as
  # {result: {bindings: [...]}}. Pre-fix this parser only looked
  # at the top-level 'bindings' key on dict payloads (the else
  # branch was dead code since json.loads of any JSON object
  # always returns a dict), so every inbox snapshot was reported
  # as empty even when SWM data had arrived. Try the wrapped
  # location first, then fall back to a bare 'bindings' for
  # forward-compatibility with any future flatter shape.
  rows = []
  if isinstance(d, dict):
    inner = d.get('result')
    if isinstance(inner, dict) and isinstance(inner.get('bindings'), list):
      rows = inner['bindings']
    elif isinstance(d.get('bindings'), list):
      rows = d['bindings']
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
  # Codex PR #572 R6: include overflow buckets + truncated flags in
  # the running summary. Pre-fix the summary printed only
  # `sum(perCg_map)`, which under-reports once either map hits its
  # configured cap and starts evicting smallest counters into
  # `*Overflow`. The endpoint documents the correct grand total as
  # `sum(map) + overflow`; soak diagnostics must reflect that or
  # operators chasing a stuck-share incident will see misleading
  # zero/low values during the exact regime they care about.
  #
  # Also surface:
  #   - `publishFailuresTruncated` → marks the per-cgId breakdown
  #     in `gossip.publishFailures` as partial (totals still
  #     accurate via overflow).
  #   - `redundantAppliesTruncated` → same, for swm.redundantApplies.
  #   - `redundantAppliesLowerBound` → sticky flag set when
  #     seenShareOps cap eviction trimmed a still-live entry, so
  #     `redundantApplies` is a lower bound for the window.
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
  pubfail_perCg = sum((gossip.get('publishFailures') or {}).values())
  pubfail_overflow = gossip.get('publishFailuresOverflow', 0) or 0
  pubfail_truncated = bool(gossip.get('publishFailuresTruncated'))
  pubfail_total = pubfail_perCg + pubfail_overflow
  redundant_perCg = sum((swm.get('redundantApplies') or {}).values())
  redundant_overflow = swm.get('redundantAppliesOverflow', 0) or 0
  redundant_truncated = bool(swm.get('redundantAppliesTruncated'))
  redundant_lower_bound = bool(swm.get('redundantAppliesLowerBound'))
  redundant_total = redundant_perCg + redundant_overflow
  pubfail_flag = ' [TRUNCATED]' if pubfail_truncated else ''
  redundant_flags = []
  if redundant_truncated: redundant_flags.append('TRUNCATED')
  if redundant_lower_bound: redundant_flags.append('LOWER-BOUND')
  redundant_flag = (' [' + '|'.join(redundant_flags) + ']') if redundant_flags else ''
  proto_s = ' '.join(parts) if parts else '(no substrate traffic yet)'
  print(
    f'slo: {proto_s} | '
    f'gossip.failures={pubfail_total}{pubfail_flag} (perCg={pubfail_perCg} overflow={pubfail_overflow}) | '
    f'swm.redundant={redundant_total}{redundant_flag} (perCg={redundant_perCg} overflow={redundant_overflow})'
  )
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
log "  run_id=$RUN_ID"
log "  soak_start_iso=$SOAK_START_ISO"
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
      # Codex PR #572 R1: /api/query wraps results as
      # {result: {bindings: [...]}}. Pre-fix this parser read the
      # top-level `data.bindings` (always absent), so the final
      # summary saw zero rows on every record. Same wrap-unwrap
      # as snapshot_swm_inbox above.
      data = rec.get('data') or {}
      rows = []
      if isinstance(data, dict):
        inner = data.get('result')
        if isinstance(inner, dict) and isinstance(inner.get('bindings'), list):
          rows = inner['bindings']
        elif isinstance(data.get('bindings'), list):
          rows = data['bindings']
      # Codex PR #572 R2: the regex match + tag/seq assignment +
      # `by_cg_final[cg] = by_tag` were all misindented out of
      # their respective loops pre-fix — `m = re.match(...)` ran
      # once per record (on whatever `s` happened to be at the
      # end of the per-binding loop), `continue` jumped past the
      # remaining records of the file (not the remaining
      # bindings), and `by_cg_final[cg] = by_tag` ran exactly
      # once after the whole file was read, keeping only the LAST
      # final record. Net result: multi-row / multi-CG runs
      # silently undercounted delivery to zero on all but one CG.
      # Now: per-binding statements stay inside `for r in rows`,
      # per-record assignment stays inside `for line in f`, and
      # we ACCUMULATE into `by_cg_final[cg]` (merging share-op
      # sequence sets per tag) so if the same `final` cgId
      # appears more than once across the jsonl no rows are lost.
      bucket = by_cg_final.setdefault(cg, {})
      for r in rows:
        s = r.get('s', '')
        if isinstance(s, dict): s = s.get('value', '')
        s = s.strip('<>')
        m = re.match(r'^urn:swm-soak:([^:]+):(\d+)$', s)
        if not m: continue
        tag, seq = m.group(1), m.group(2)
        bucket.setdefault(tag, set()).add(seq)
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
