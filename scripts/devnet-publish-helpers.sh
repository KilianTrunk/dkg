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
#   PUBLISH_RESP=$(devnet_publish_swm_all_roots "$NODE" "$CG_ID" false '"epochs":1')
#
# After a call, DEVNET_PUBLISH_ALL_RESPONSES holds a JSON array of every
# publish response (one element when the graph is single-root). When a
# multi-root split occurred, DEVNET_PUBLISH_ROOT_ENTITIES lists the root
# entity IRIs in publish order (same index as DEVNET_PUBLISH_ALL_RESPONSES).
#
DEVNET_PUBLISH_ALL_RESPONSES='[]'
DEVNET_PUBLISH_ROOT_ENTITIES='[]'

devnet_json_field() {
  printf '%s' "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); const v=j$2; console.log(v == null ? '' : v); }
      catch { process.exit(1); }
    })
  "
}

devnet_kc_merkle_root() {
  local node="$1" kc="$2"
  local meta
  meta=$(api_call "$node" GET "/api/kc/$kc")
  devnet_json_field "$meta" '.merkleRoot'
}

# Args: node cg quads_payload_json (stringified { contextGraphId, quads })
# Verifies each published root entity against its KC merkleRoot via verify-batch.
devnet_verify_each_published_root() {
  local node="$1" cg="$2" quads_payload="$3"
  local count i kc merkle body resp ok actual

  count=$(printf '%s' "$DEVNET_PUBLISH_ROOT_ENTITIES" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{ try { console.log(JSON.parse(d).length); } catch { console.log(0); } });
  ')
  if [ "$count" -eq 0 ]; then
    count=1
  fi

  i=0
  while [ "$i" -lt "$count" ]; do
    kc=$(printf '%s' "$DEVNET_PUBLISH_ALL_RESPONSES" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>console.log(JSON.parse(d)[Number(process.argv[1])].kaId));
    " "$i")
    merkle=$(devnet_kc_merkle_root "$node" "$kc")
    body=$(QUADS_PAYLOAD="$quads_payload" ROOT_IDX="$i" ROOTS="$DEVNET_PUBLISH_ROOT_ENTITIES" CG="$cg" MERKLE="$merkle" KC="$kc" node -e '
      const roots = JSON.parse(process.env.ROOTS || "[]");
      const rootIdx = Number(process.env.ROOT_IDX);
      const payload = JSON.parse(process.env.QUADS_PAYLOAD);
      let quads = payload.quads;
      if (roots.length > 0) {
        const root = roots[rootIdx];
        quads = quads.filter((q) => q.subject === root || q.subject.startsWith(root + "/"));
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

  DEVNET_PUBLISH_ALL_RESPONSES='[]'
  DEVNET_PUBLISH_ROOT_ENTITIES='[]'

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
    DEVNET_PUBLISH_ALL_RESPONSES=$(printf '%s' "$probe" | node -e '
      let d=""; process.stdin.on("data",c=>d+=c);
      process.stdin.on("end",()=>console.log(JSON.stringify([JSON.parse(d)])));
    ')
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
  DEVNET_PUBLISH_ROOT_ENTITIES="$roots_json"
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
  DEVNET_PUBLISH_ALL_RESPONSES="$all_resps"
  printf '%s' "$last_resp"
  return 0
}
