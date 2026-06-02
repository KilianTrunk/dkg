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
devnet_publish_swm_all_roots() {
  local node="$1" cg="$2" clear_after="${3:-false}"
  local extra_fields="${4:-}"

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
    printf '%s' "$probe"
    return 0
  fi

  local roots_json count i last_resp root ca st
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
    i=$((i + 1))
    sleep 1
  done
  printf '%s' "$last_resp"
  return 0
}
