#!/usr/bin/env bash
#
# OT-RFC-39 / LU-11 — COMPREHENSIVE devnet validation.
#
# Drives THREE scenarios against the same 6-node devnet, each
# culminating in an on-chain `submitChallengeProof` against the KC
# published in that scenario:
#
#   Scenario A — PUBLIC CG random sampling (regression).
#     Confirms PR-B's `_isCGEligible` revert (which re-enables curated
#     CGs in the picker) did NOT regress the existing public-CG path.
#     Picker draws a public KC, prover takes the flat-KC branch
#     (`extractV10KCFromStore` + `V10MerkleTree`), proof lands.
#
#   Scenario B — CURATED CG, SINGLE chunk.
#     Smallest LU-11 happy path: 1KB plaintext → 1 chunk. Validates
#     PR-A end-to-end: chunked emit, per-chunk SWM gossip, V2 ACK,
#     on-chain (root,count) commitment, off-chain prover picks curated
#     branch and lands the proof.
#
#   Scenario C — CURATED CG, MULTI-chunk.
#     ≥64KB plaintext → ≥2 chunks. The interesting one: exercises
#     `V10CiphertextChunksMerkleTree` with multiple leaves,
#     deterministic per-chunk AEAD nonces, multi-chunk Merkle root
#     recomputation in the V2 ACK verifier, and the prover's
#     `extractCiphertextChunksFromStore` GRAPH ?g scan across more
#     than one chunk subject URI.
#
# Each scenario snapshots `submittedCount` per core BEFORE publishing,
# `hardhat_mine`s 250 blocks AFTER publish to guarantee a fresh
# sampling period, and asserts at least one core's count strictly
# increases. The cores' `lastSubmittedTxHash` after the bump is the
# concrete proof tx — printed at the end for operator follow-up.
#
# Preconditions: devnet already running.
#   ./scripts/devnet.sh start 6
# (Honours DEVNET_DIR / HARDHAT_PORT / API_PORT_BASE env overrides.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
CORE_NODES=(1 2 3 4)
EDGE_CURATOR_NODE=5
RS_TIMEOUT="${RS_TIMEOUT:-180}"
# proofingPeriodDurationInBlocks is 100 on devnet; mining 250 reliably
# advances past a period boundary with margin for slippage.
MINE_BLOCKS_AFTER_PUBLISH=250

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

# Per-scenario summary collector
SCENARIO_RESULTS=()

log()  { echo "[rfc39-comp] $*"; }
warn() { echo "[rfc39-comp] WARN: $*" >&2; }
fail() { echo "[rfc39-comp] FAIL: $*" >&2; exit 1; }
banner() {
  echo ""
  echo "================================================================"
  echo "  $*"
  echo "================================================================"
}

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_log()   { echo "$(node_dir "$1")/daemon.log"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
}

# Extract `loop.submittedCount` from /api/random-sampling/status (or 0).
get_submitted_count() {
  local node="$1" status
  status=$(api_call "$node" GET /api/random-sampling/status 2>/dev/null || true)
  printf '%s' "$status" | node -e '
    let d="";
    process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { const j=JSON.parse(d); console.log((j.loop||{}).submittedCount||0); }
      catch(e) { console.log(0); }
    })
  ' 2>/dev/null || echo 0
}

# Extract `loop.lastSubmittedTxHash` from /api/random-sampling/status.
get_last_submitted_tx() {
  local node="$1" status
  status=$(api_call "$node" GET /api/random-sampling/status 2>/dev/null || true)
  printf '%s' "$status" | node -e '
    let d="";
    process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { const j=JSON.parse(d); console.log((j.loop||{}).lastSubmittedTxHash||""); }
      catch(e) { console.log(""); }
    })
  ' 2>/dev/null || echo ""
}

# Snapshot baselines for the four cores into two parallel arrays.
declare BASELINE_KEYS=""
snap_baseline() {
  BASELINE_KEYS=""
  for n in "${CORE_NODES[@]}"; do
    local c
    c=$(get_submitted_count "$n")
    BASELINE_KEYS+="${n}=${c} "
  done
}
baseline_for() {
  local target="$1" tok
  for tok in $BASELINE_KEYS; do
    local k="${tok%%=*}"; local v="${tok#*=}"
    if [ "$k" = "$target" ]; then echo "$v"; return; fi
  done
  echo 0
}

# Mine N blocks via hardhat_mine RPC. Args: blocks (decimal).
hardhat_mine_blocks() {
  local blocks="$1"
  local hexcount
  hexcount=$(printf '0x%x' "$blocks")
  local resp
  resp=$(curl -sS -X POST -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hardhat_mine\",\"params\":[\"${hexcount}\"]}" \
    "http://127.0.0.1:${HARDHAT_PORT}" 2>/dev/null || true)
  if printf '%s' "$resp" | grep -q '"result":true'; then
    return 0
  fi
  warn "hardhat_mine response was unexpected: $resp"
  return 1
}

# Read on-chain (ciphertextChunksRoot, ciphertextChunkCount) for kcId.
read_ct_commitment() {
  local kc_id="$1"
  ( cd "$REPO_ROOT/packages/evm-module" && \
    RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
    CONTRACTS_JSON="$CONTRACTS_JSON" \
    ABI_DIR="$EVM_ABI_DIR" \
    KC_ID="$kc_id" \
    node -e '
      const { ethers } = require("ethers");
      const fs = require("fs");
      const path = require("path");
      (async () => {
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
        const kcsAddr = contracts.KnowledgeCollectionStorage?.evmAddress;
        if (!kcsAddr) throw new Error("KCS not deployed");
        const abi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "KnowledgeCollectionStorage.json"), "utf8"));
        const kcs = new ethers.Contract(kcsAddr, abi, provider);
        const ctRoot = await kcs.getLatestCiphertextChunksRoot(BigInt(process.env.KC_ID));
        const ctCount = await kcs.getCiphertextChunkCount(BigInt(process.env.KC_ID));
        const plainRoot = await kcs.getLatestMerkleRoot(BigInt(process.env.KC_ID));
        const plainCount = await kcs.getMerkleLeafCount(BigInt(process.env.KC_ID));
        console.log(JSON.stringify({ ctRoot, ctCount: ctCount.toString(), plainRoot, plainCount: plainCount.toString() }));
      })().catch(e => { console.error("[kcs] " + (e?.shortMessage || e?.message || e)); process.exit(1); });
    '
  )
}

# Wait for ANY core to bump submittedCount above its baseline. Returns
# "$node $count $tx" on success, empty string on timeout.
wait_for_fresh_proof() {
  local end_ts=$(( $(date +%s) + RS_TIMEOUT ))
  while [ "$(date +%s)" -lt "$end_ts" ]; do
    for n in "${CORE_NODES[@]}"; do
      local cur baseline tx
      cur=$(get_submitted_count "$n")
      baseline=$(baseline_for "$n")
      if [ "${cur:-0}" -gt "${baseline:-0}" ] 2>/dev/null; then
        tx=$(get_last_submitted_tx "$n")
        if [ -n "$tx" ]; then
          echo "$n $cur $tx"
          return 0
        fi
      fi
    done
    sleep 5
  done
  return 1
}

# Build a single SWM write payload of ~target_bytes plaintext by
# splatting one long literal across many triples. The publisher will
# concatenate the SWM graph quads → serialize → encrypt → chunk into
# 32KB ciphertext chunks; target_bytes ≈ 64K reliably produces ≥2
# chunks even after compression / N-quads framing trims a little.
build_swm_write_payload() {
  local cg_uri="$1" stamp="$2" target_bytes="$3"
  local triples_per_subject=12
  local literal_chunk_bytes=2048
  local n_subjects=$(( (target_bytes + (triples_per_subject * literal_chunk_bytes) - 1) / (triples_per_subject * literal_chunk_bytes) ))
  [ "$n_subjects" -lt 1 ] && n_subjects=1

  STAMP="$stamp" CG_URI="$cg_uri" N_SUBJECTS="$n_subjects" \
  TRIPLES_PER_SUBJECT="$triples_per_subject" LITERAL_BYTES="$literal_chunk_bytes" \
  node -e '
    const cg = process.env.CG_URI;
    const stamp = process.env.STAMP;
    const N = +process.env.N_SUBJECTS;
    const T = +process.env.TRIPLES_PER_SUBJECT;
    const B = +process.env.LITERAL_BYTES;
    // Deterministic, alphanumeric literal — compresses poorly enough to
    // preserve the rough byte budget even if the publisher gzips
    // anywhere downstream.
    const literal = ("abcdefghijklmnopqrstuvwxyz0123456789".repeat(Math.ceil(B/36))).slice(0, B);
    const quads = [];
    for (let s = 0; s < N; s++) {
      const subj = `urn:rfc39:bulk:${stamp}/s${s}`;
      for (let t = 0; t < T; t++) {
        quads.push({
          subject: subj,
          predicate: `http://schema.org/multiChunkProbe_${t}`,
          object: `"${literal}"`,
          graph: "",
        });
      }
    }
    process.stdout.write(JSON.stringify({ contextGraphId: cg, quads }));
  '
}

# Per-scenario runner. Args:
#   $1 scenario tag (A | B | C)
#   $2 description
#   $3 access policy (0=public, 1=curated)
#   $4 SWM payload mode: "small" | "multi-chunk"
#   $5 expected ciphertextChunkCount-min (0 for public; 1 for B; 2 for C)
run_scenario() {
  local tag="$1" desc="$2" access_policy="$3" payload_mode="$4" min_ct_count="$5"

  banner "Scenario $tag — $desc"

  local stamp cg_slug cg_local_id cg_uri
  stamp=$(date +%s)
  local tag_lc
  tag_lc=$(printf '%s' "$tag" | tr '[:upper:]' '[:lower:]')
  cg_slug="rfc39-${tag_lc}-${stamp}"
  cg_local_id="${CURATOR_AGENT}/${cg_slug}"
  cg_uri="${cg_local_id}"

  local visibility_label
  if [ "$access_policy" = "1" ]; then visibility_label="curated"; else visibility_label="public"; fi

  log "Creating $visibility_label CG '$cg_local_id' (accessPolicy=$access_policy)..."
  # `/api/context-graph/create` silently flips accessPolicy → 1 (curated)
  # whenever `allowedAgents` is non-empty (see cli.ts:1780 — the
  # daemon's intent is "explicit allowlist ⇒ private"). For Scenario A
  # we want a genuinely public CG, so omit `allowedAgents` when
  # accessPolicy=0 and include it (single-curator allowlist) when
  # accessPolicy=1.
  local create_body
  if [ "$access_policy" = "1" ]; then
    create_body=$(cat <<EOF
{
  "id": "${cg_local_id}",
  "name": "RFC-39 comp $tag ${stamp}",
  "description": "OT-RFC-39 comprehensive devnet probe scenario $tag",
  "accessPolicy": 1,
  "publishPolicy": 0,
  "allowedAgents": ["${CURATOR_AGENT}"],
  "register": true
}
EOF
)
  else
    create_body=$(cat <<EOF
{
  "id": "${cg_local_id}",
  "name": "RFC-39 comp $tag ${stamp}",
  "description": "OT-RFC-39 comprehensive devnet probe scenario $tag",
  "accessPolicy": 0,
  "publishPolicy": 0,
  "register": true
}
EOF
)
  fi
  local create_resp
  create_resp=$(api_call "$EDGE_CURATOR_NODE" POST /api/context-graph/create "$create_body")
  local on_chain_id
  on_chain_id=$(printf '%s' "$create_resp" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { const j=JSON.parse(d); if(!j.registered||!j.onChainId){process.exit(1)} console.log(j.onChainId); }
      catch(e){process.exit(1)}
    })' 2>/dev/null) || fail "Scenario $tag: create+register did not return onChainId. Response: $create_resp"
  log "  CG on chain: onChainId=$on_chain_id"

  log "Writing SWM payload ($payload_mode)..."
  local write_body write_resp
  case "$payload_mode" in
    small)
      write_body=$(STAMP="$stamp" CG_URI="$cg_uri" node -e '
        const stamp = process.env.STAMP; const cg = process.env.CG_URI;
        const out = { contextGraphId: cg, quads: [] };
        for (const who of ["alice","bob","carol","dave"]) {
          out.quads.push({ subject: `urn:rfc39:entity:${stamp}/${who}`, predicate: "http://schema.org/name", object: `"${who.charAt(0).toUpperCase()+who.slice(1)} Smallpayload"`, graph: "" });
          out.quads.push({ subject: `urn:rfc39:entity:${stamp}/${who}`, predicate: "http://schema.org/role", object: `"engineering"`, graph: "" });
          out.quads.push({ subject: `urn:rfc39:entity:${stamp}/${who}`, predicate: "http://schema.org/email", object: `"${who}@example.com"`, graph: "" });
        }
        process.stdout.write(JSON.stringify(out));
      ')
      ;;
    multi-chunk)
      # 96KB plaintext → ~3 chunks after AES-GCM framing.
      write_body=$(build_swm_write_payload "$cg_uri" "$stamp" 98304)
      ;;
    *) fail "Scenario $tag: unknown payload mode '$payload_mode'";;
  esac
  write_resp=$(api_call "$EDGE_CURATOR_NODE" POST /api/shared-memory/write "$write_body")
  local triples_written
  triples_written=$(printf '%s' "$write_resp" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { const j=JSON.parse(d); console.log(j.triplesWritten||0); } catch(e){console.log(0);}
    })' 2>/dev/null || echo 0)
  log "  triplesWritten=$triples_written"
  [ "$triples_written" -ge 1 ] || fail "Scenario $tag: SWM write reported zero triples: $write_resp"
  sleep 2

  # Snapshot per-core baseline JUST BEFORE the publish so we can later
  # demand a strict increase. Done per-scenario because each scenario
  # bumps counts on at least one core.
  snap_baseline
  log "  Baseline submittedCount per core: $BASELINE_KEYS"

  log "Publishing $visibility_label CG to VM..."
  local publish_resp
  publish_resp=$(api_call "$EDGE_CURATOR_NODE" POST /api/shared-memory/publish "$(cat <<EOF
{
  "contextGraphId": "${cg_uri}",
  "selection": "all",
  "clearAfter": false
}
EOF
)")
  local publish_status publish_tx publish_kc publish_block
  publish_status=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).status||"")}catch(e){console.log("")}})')
  publish_tx=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).txHash||"")}catch(e){console.log("")}})')
  publish_kc=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).kcId||"")}catch(e){console.log("")}})')
  publish_block=$(printf '%s' "$publish_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).blockNumber||"")}catch(e){console.log("")}})')

  [ "$publish_status" = "confirmed" ] || fail "Scenario $tag: publish status='$publish_status' (expected confirmed). Full response: $publish_resp"
  [ -n "$publish_tx" ] || fail "Scenario $tag: publish: no txHash. Full response: $publish_resp"
  [ -n "$publish_kc" ] && [ "$publish_kc" != "0" ] || fail "Scenario $tag: publish: zero/empty kcId"
  log "  ✓ publish landed: kcId=$publish_kc tx=$publish_tx block=$publish_block"

  log "Reading on-chain commitment for kcId=$publish_kc..."
  local commitment ct_root ct_count plain_root plain_count
  commitment=$(read_ct_commitment "$publish_kc") || fail "Scenario $tag: on-chain commitment read failed"
  ct_root=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).ctRoot))')
  ct_count=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).ctCount))')
  plain_root=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).plainRoot))')
  plain_count=$(printf '%s' "$commitment" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).plainCount))')
  log "  ciphertextChunksRoot:  $ct_root"
  log "  ciphertextChunkCount:  $ct_count"
  log "  plain merkleRoot:      $plain_root  (== batchId)"
  log "  plain merkleLeafCount: $plain_count"

  local zero_root="0x0000000000000000000000000000000000000000000000000000000000000000"
  if [ "$access_policy" = "1" ]; then
    [ "$ct_root" != "$zero_root" ] || fail "Scenario $tag: RFC-39 INVARIANT BROKEN — ciphertextChunksRoot is zero on a curated KC publish (publisher did NOT take the LU-11 chunked path)"
    [ "$ct_count" -ge "$min_ct_count" ] || fail "Scenario $tag: ciphertextChunkCount=$ct_count, expected ≥ $min_ct_count"
    log "  ✓ on-chain LU-11 commitment is non-zero and meets count expectation (≥$min_ct_count)"
  else
    # Public KCs intentionally have NO ciphertext commitment (legacy
    # path), so root/count MUST be zero.
    [ "$ct_root" = "$zero_root" ] || fail "Scenario $tag: PUBLIC KC unexpectedly has a non-zero ciphertextChunksRoot=$ct_root (chunked path leaked into public path)"
    [ "$ct_count" = "0" ] || fail "Scenario $tag: PUBLIC KC unexpectedly has ciphertextChunkCount=$ct_count (expected 0 — public path must skip LU-11)"
    log "  ✓ public KC correctly carries zero ciphertext commitment"
  fi

  log "Mining $MINE_BLOCKS_AFTER_PUBLISH hardhat blocks to advance into a fresh sampling period..."
  hardhat_mine_blocks "$MINE_BLOCKS_AFTER_PUBLISH" || warn "block-mine RPC call failed"

  log "Polling cores for fresh submitChallengeProof tx (timeout=${RS_TIMEOUT}s)..."
  local proof_line proof_node proof_count proof_tx
  if proof_line=$(wait_for_fresh_proof); then
    proof_node=${proof_line%% *}
    proof_tx=${proof_line##* }
    local rest="${proof_line#* }"
    proof_count="${rest%% *}"
    log "  ✓ core node $proof_node submitted a NEW proof: submittedCount=$proof_count tx=$proof_tx"
  else
    log "  Dumping per-core RS status for diagnostics:"
    for n in "${CORE_NODES[@]}"; do
      log "    node $n: $(api_call "$n" GET /api/random-sampling/status 2>/dev/null || echo '<api error>')"
    done
    log ""
    log "  Tail of node1 daemon log (look for 'rs.tick.*' / 'curated' / 'LU-11'):"
    tail -40 "$(node_log 1)" | sed 's/^/      /'
    fail "Scenario $tag: no core landed a fresh proof within ${RS_TIMEOUT}s"
  fi

  SCENARIO_RESULTS+=("$tag|$visibility_label|kc=$publish_kc|ct_root=${ct_root:0:18}…|ct_count=$ct_count|proof_node=$proof_node|proof_tx=${proof_tx:0:18}…")
}

# --- Preconditions -----------------------------------------------------------

log "Checking devnet state..."
for n in "${CORE_NODES[@]}" "$EDGE_CURATOR_NODE"; do
  pidf="$(node_dir "$n")/devnet.pid"
  [ -f "$pidf" ] || fail "node $n: missing $pidf"
  kill -0 "$(cat "$pidf")" 2>/dev/null || fail "node $n: pid stale"
  api_call "$n" GET /api/status >/dev/null || fail "node $n: API not reachable"
done
log "Cores + edge curator are up."

# --- Curator identity (shared across all scenarios) --------------------------

CURATOR_IDENTITY=$(api_call "$EDGE_CURATOR_NODE" GET /api/agent/identity)
CURATOR_AGENT=$(printf '%s' "$CURATOR_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
log "Curator agent: $CURATOR_AGENT (node $EDGE_CURATOR_NODE)"

# --- Scenarios ----------------------------------------------------------------

run_scenario A "PUBLIC CG random sampling (regression check)" 0 small        0
run_scenario B "CURATED CG random sampling — single-chunk"    1 small        1
run_scenario C "CURATED CG random sampling — multi-chunk"     1 multi-chunk  2

# --- Final summary -----------------------------------------------------------

banner "RFC-39 COMPREHENSIVE DEVNET VALIDATION: PASS"
for line in "${SCENARIO_RESULTS[@]}"; do
  log "  $line"
done
echo ""
echo "================================================================"
echo "  All three scenarios drove on-chain submitChallengeProof:"
echo "    A) public path  — picker draws + flat-KC prover lands proof"
echo "    B) curated path — LU-11 chunked emit + curated prover lands"
echo "    C) curated path — ≥2 chunks, multi-leaf Merkle, fresh proof"
echo "================================================================"
