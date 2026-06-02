#!/usr/bin/env bash
#
# Shared helpers for devnet test scripts — rc.12+ single-root sync publish.
#
# Since #925, POST /api/shared-memory/publish rejects `selection: "all"`
# when multiple root entities exist (MULTI_ROOT_PUBLISH_NOT_ATOMIC). Scripts
# that previously published whole SWM graphs in one call must publish one root
# at a time.
#
# Usage: source this file AFTER defining `api_call NODE METHOD PATH [DATA]`.
#
#   PUBLISH_RESP=$(devnet_publish_swm_all_roots "$NODE" "$CG_ID" false)
#   devnet_publish_load_state
#
# Command substitution runs the publish helper in a subshell, so metadata is
# persisted to DEVNET_PUBLISH_STATE_FILE and must be loaded in the caller shell.
# The state file is scoped to the parent shell PID ($$). Unlike BASHPID, $$ is
# stable across command-substitution subshells, so the path the helper writes
# inside `$(...)` matches the one the parent later reads. It also keeps
# concurrent devnet scripts from clobbering each other's publish metadata.
#
DEVNET_PUBLISH_STATE_FILE="${DEVNET_PUBLISH_STATE_FILE:-${DEVNET_DIR:-/tmp}/.devnet-publish-state-$$.json}"
DEVNET_PUBLISH_ALL_RESPONSES='[]'
DEVNET_PUBLISH_ROOT_ENTITIES='[]'
# Node that performed the last publish. KC metadata (merkleRoot, KCS records)
# must be read from this node — late-joining/non-curator verifier peers may not
# have materialized the batch yet, which would race verify-batch.
DEVNET_PUBLISH_NODE=''

devnet_json_field() {
  printf '%s' "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); const v=j$2; console.log(v == null ? '' : v); }
      catch { process.exit(1); }
    })
  "
}

# Honor an already-set DEVNET_PUBLISH_STATE_FILE; otherwise derive a
# parent-stable path from $$ (NOT BASHPID, which changes inside subshells).
_devnet_publish_init_state_file() {
  : "${DEVNET_PUBLISH_STATE_FILE:=${DEVNET_DIR:-/tmp}/.devnet-publish-state-$$.json}"
}

_devnet_publish_persist_state() {
  local all_responses="$1" root_entities="${2:-[]}" publish_node="${3:-}"
  node -e "
    require('fs').writeFileSync(
      process.argv[1],
      JSON.stringify({
        allResponses: JSON.parse(process.argv[2]),
        rootEntities: JSON.parse(process.argv[3]),
        publishNode: process.argv[4],
      }),
    );
  " "$DEVNET_PUBLISH_STATE_FILE" "$all_responses" "$root_entities" "$publish_node"
}

devnet_publish_load_state() {
  _devnet_publish_init_state_file
  if [ ! -f "$DEVNET_PUBLISH_STATE_FILE" ]; then
    DEVNET_PUBLISH_ALL_RESPONSES='[]'
    DEVNET_PUBLISH_ROOT_ENTITIES='[]'
    DEVNET_PUBLISH_NODE=''
    return 0
  fi
  DEVNET_PUBLISH_ALL_RESPONSES=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    console.log(JSON.stringify(s.allResponses || []));
  " "$DEVNET_PUBLISH_STATE_FILE")
  DEVNET_PUBLISH_ROOT_ENTITIES=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    console.log(JSON.stringify(s.rootEntities || []));
  " "$DEVNET_PUBLISH_STATE_FILE")
  DEVNET_PUBLISH_NODE=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    console.log(s.publishNode || '');
  " "$DEVNET_PUBLISH_STATE_FILE")
}

# Echo the number of root-entity publishes in the last devnet_publish_swm_all_roots call.
devnet_publish_root_count() {
  devnet_publish_load_state
  printf '%s' "$DEVNET_PUBLISH_ROOT_ENTITIES" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{ try { const n=JSON.parse(d).length; console.log(n > 0 ? n : 1); } catch { console.log(1); } });
  '
}

# Args: zero-based index into the last publish batch list.
devnet_publish_ka_id_at() {
  local idx="$1"
  devnet_publish_load_state
  printf '%s' "$DEVNET_PUBLISH_ALL_RESPONSES" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>console.log(JSON.parse(d)[Number(process.argv[1])].kaId));
  " "$idx"
}

# Args: root_subject
# Resolve the kaId of the batch that published a given root entity. The helper
# preserves publish order (allResponses[i] <-> rootEntities[i]), but the
# daemon's rootEntities order is NOT tied to the original quad order, so callers
# must look the batch up by subject rather than positional index. Lookups fail
# fast when the requested root has no recorded root->batch mapping (e.g. a typo,
# or a single-root publish where the subject was never recorded) instead of
# silently resolving to the wrong batch — use devnet_publish_ka_id_at for
# positional access to a single-batch publish.
devnet_publish_ka_id_for_root() {
  local root="$1"
  devnet_publish_load_state
  ALL="$DEVNET_PUBLISH_ALL_RESPONSES" ROOTS="$DEVNET_PUBLISH_ROOT_ENTITIES" ROOT="$root" node -e '
    const all = JSON.parse(process.env.ALL || "[]");
    const roots = JSON.parse(process.env.ROOTS || "[]");
    const root = process.env.ROOT;
    if (roots.length === 0) {
      console.error(
        "no root->batch mapping recorded for " + root +
        " (single-root publish records no subject; use devnet_publish_ka_id_at instead)",
      );
      process.exit(1);
    }
    const idx = roots.indexOf(root);
    if (idx < 0 || !all[idx]) {
      console.error("no published batch for root " + root);
      process.exit(1);
    }
    console.log(all[idx].kaId);
  '
}

devnet_kc_merkle_root() {
  local node="$1" kc="$2"
  local meta
  meta=$(api_call "$node" GET "/api/kc/$kc")
  devnet_json_field "$meta" '.merkleRoot'
}

# Args: expected_minted_per_kc (default 1)
# Requires REPO_ROOT, HARDHAT_PORT, CONTRACTS_JSON, EVM_ABI_DIR in caller env.
devnet_kcs_readback_all_published() {
  local expected_minted="${1:-1}"
  devnet_publish_load_state
  (
    cd "${REPO_ROOT:?REPO_ROOT must be set}/packages/evm-module" && \
    RPC_URL="http://127.0.0.1:${HARDHAT_PORT:-8545}" \
    CONTRACTS_JSON="${CONTRACTS_JSON:?CONTRACTS_JSON must be set}" \
    ABI_DIR="${EVM_ABI_DIR:?EVM_ABI_DIR must be set}" \
    ALL_KCS="$DEVNET_PUBLISH_ALL_RESPONSES" \
    EXPECTED_MINTED="$expected_minted" \
    node -e '
const { ethers } = require("ethers");
const fs = require("fs"); const path = require("path");
(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const kcsAddr = contracts.DKGKnowledgeAssets?.evmAddress ?? contracts.KnowledgeCollectionStorage?.evmAddress;
  if (!kcsAddr) throw new Error("DKGKnowledgeAssets / KnowledgeCollectionStorage not deployed");
  const kcsAbiFile = fs.existsSync(path.join(process.env.ABI_DIR, "DKGKnowledgeAssets.json"))
    ? "DKGKnowledgeAssets.json" : "DKGKnowledgeAssets.json";
  const kas = new ethers.Contract(kcsAddr,
    JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, kcsAbiFile), "utf8")), provider);
  const kcs = JSON.parse(process.env.ALL_KCS);
  const expectedMinted = BigInt(process.env.EXPECTED_MINTED);
  if (!kcs.length) throw new Error("no published KC responses in state");
  for (const pub of kcs) {
    const batchId = pub.kaId;
    const [merkleRoots, , minted, byteSize] = await kas.getKnowledgeAssetMetadata(BigInt(batchId));
    if (!merkleRoots || merkleRoots.length === 0) throw new Error("no merkleRoots for kaId=" + batchId);
    if (byteSize === 0n) throw new Error("byteSize=0 for kaId=" + batchId);
    if (minted !== expectedMinted) {
      throw new Error("kaId=" + batchId + ": expected " + expectedMinted + " KAs minted, got " + minted);
    }
  }
  console.log("✓ KCS: " + kcs.length + " KC(s) each minted=" + expectedMinted);
})().catch(e => { console.error(e?.message || e); process.exit(1); });
    '
  )
}

# Args: node cg quads_payload_json [metadata_node]
# Verifies each published root entity against its KC merkleRoot via verify-batch.
# verify-batch runs on `node` (often a late-joining/non-curator peer), but the
# expected merkleRoot is read from `metadata_node` — defaults to the node that
# performed the publish — to avoid racing that peer's KC chain-sync.
devnet_verify_each_published_root() {
  local node="$1" cg="$2" quads_payload="$3" meta_node="${4:-}"
  local count i kc merkle body resp ok actual

  devnet_publish_load_state
  [ -z "$meta_node" ] && meta_node="${DEVNET_PUBLISH_NODE:-$node}"
  [ -z "$meta_node" ] && meta_node="$node"

  count=$(devnet_publish_root_count)

  i=0
  while [ "$i" -lt "$count" ]; do
    kc=$(devnet_publish_ka_id_at "$i")
    merkle=$(devnet_kc_merkle_root "$meta_node" "$kc")
    body=$(QUADS_PAYLOAD="$quads_payload" ROOT_IDX="$i" ROOTS="$DEVNET_PUBLISH_ROOT_ENTITIES" CG="$cg" MERKLE="$merkle" KC="$kc" node -e '
      const genidPrefix = "/.well-known/genid/";
      const quadBelongsToRoot = (q, root) =>
        q.subject === root || q.subject.startsWith(root + genidPrefix);
      const roots = JSON.parse(process.env.ROOTS || "[]");
      const rootIdx = Number(process.env.ROOT_IDX);
      const payload = JSON.parse(process.env.QUADS_PAYLOAD);
      let quads = payload.quads;
      if (roots.length > 0) {
        const root = roots[rootIdx];
        quads = quads.filter((q) => quadBelongsToRoot(q, root));
      }
      console.log(JSON.stringify({
        contextGraphId: process.env.CG,
        expectedMerkleRoot: process.env.MERKLE,
        batchId: process.env.KC,
        quads,
      }));
    ')
    resp=$(api_call "$node" POST /api/shared-memory/verify-batch "$body")
    ok=$(devnet_json_field "$resp" '.ok')
    actual=$(devnet_json_field "$resp" '.actualRoot')
    if [ "$ok" != "true" ] || [ "$actual" != "$merkle" ]; then
      printf '%s\n' "$resp" >&2
      return 1
    fi
    i=$((i + 1))
  done
  return 0
}

devnet_publish_swm_all_roots() {
  local node="$1" cg="$2" clear_after="${3:-false}"
  local extra_fields="${4:-}"

  _devnet_publish_init_state_file

  local probe_body
  probe_body=$(node -e "
    const cg = process.argv[1];
    const clearAfter = process.argv[2] === 'true';
    const extra = process.argv[3] ? JSON.parse('{' + process.argv[3] + '}') : {};
    console.log(JSON.stringify({ contextGraphId: cg, selection: 'all', clearAfter, ...extra }));
  " "$cg" "$clear_after" "$extra_fields")

  local probe
  probe=$(api_call "$node" POST /api/shared-memory/publish "$probe_body")

  if ! printf '%s' "$probe" | grep -q 'MULTI_ROOT_PUBLISH_NOT_ATOMIC'; then
    local single_arr single_roots
    single_arr=$(printf '%s' "$probe" | node -e '
      let d=""; process.stdin.on("data",c=>d+=c);
      process.stdin.on("end",()=>console.log(JSON.stringify([JSON.parse(d)])));
    ')
    # Record the published root subject when the response exposes it so
    # devnet_publish_ka_id_for_root can validate single-root lookups too.
    single_roots=$(printf '%s' "$probe" | node -e '
      let d=""; process.stdin.on("data",c=>d+=c);
      process.stdin.on("end",()=>{
        try {
          const j = JSON.parse(d);
          const roots = j.rootEntities || j.publishedRootEntities || j.roots || [];
          console.log(JSON.stringify(Array.isArray(roots) ? roots : []));
        } catch { console.log("[]"); }
      });
    ')
    _devnet_publish_persist_state "$single_arr" "$single_roots" "$node"
    printf '%s' "$probe"
    return 0
  fi

  local roots_json count i last_resp root ca st all_resps
  roots_json=$(printf '%s' "$probe" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { console.log(JSON.stringify(JSON.parse(d).rootEntities || [])); }
      catch { console.log("[]"); }
    });
  ')
  count=$(printf '%s' "$roots_json" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).length))')
  if [ "$count" -eq 0 ]; then
    printf '%s' "$probe" >&2
    return 1
  fi

  all_resps="[]"
  i=0
  last_resp=""
  while [ "$i" -lt "$count" ]; do
    root=$(printf '%s' "$roots_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[Number(process.argv[1])]))" "$i")
    ca="$clear_after"
    if [ "$clear_after" = "true" ] && [ "$i" -lt $((count - 1)) ]; then
      ca="false"
    fi
    last_resp=$(node -e "
      const cg = process.argv[1];
      const root = process.argv[2];
      const clearAfter = process.argv[3] === 'true';
      const extra = process.argv[4] ? JSON.parse('{' + process.argv[4] + '}') : {};
      console.log(JSON.stringify({
        contextGraphId: cg,
        selection: { rootEntities: [root] },
        clearAfter,
        ...extra,
      }));
    " "$cg" "$root" "$ca" "$extra_fields")
    last_resp=$(api_call "$node" POST /api/shared-memory/publish "$last_resp")
    st=$(printf '%s' "$last_resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).status||"")}catch{}})' 2>/dev/null || echo "")
    if [ "$st" != "confirmed" ] && [ "$st" != "finalized" ]; then
      printf '%s' "$last_resp" >&2
      return 1
    fi
    all_resps=$(node -e "
      const arr = JSON.parse(process.argv[1]);
      arr.push(JSON.parse(process.argv[2]));
      console.log(JSON.stringify(arr));
    " "$all_resps" "$last_resp")
    i=$((i + 1))
    sleep 1
  done
  _devnet_publish_persist_state "$all_resps" "$roots_json" "$node"
  printf '%s' "$last_resp"
  return 0
}

# Filter quads to those belonging to a published root entity (matches publisher selection).
devnet_quads_for_root_json() {
  local quads_payload="$1" root="$2"
  QUADS_PAYLOAD="$quads_payload" ROOT="$root" node -e '
    const genidPrefix = "/.well-known/genid/";
    const quadBelongsToRoot = (q, root) =>
      q.subject === root || q.subject.startsWith(root + genidPrefix);
    const payload = JSON.parse(process.env.QUADS_PAYLOAD);
    const quads = payload.quads.filter((q) => quadBelongsToRoot(q, process.env.ROOT));
    console.log(JSON.stringify(quads));
  '
}
