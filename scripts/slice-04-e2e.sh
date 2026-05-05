#!/usr/bin/env bash
# Slice 04 e2e: per-request `contextGraphId` + `subGraphName` on
# GET /api/epcis/events. Mirrors the slice spec's devnet block,
# scoped to the route surface that slice 04 actually changes.
#
# Pre-existing devnet limitations the slice cannot fix from the
# query side (recorded in the summary report at the end of the run):
#   1. The publisher wallet is not on the on-chain CG-publish
#      authority list — every canonical publish ends in
#      "No authorized publisher wallet found in signer pool",
#      so capture state ends up `failed` instead of `finalized`.
#      Local triplestore writes still happen, so canonical query
#      reads still surface the event.
#   2. The shared-memory anchor subject (`urn:uuid:...`) does not
#      match the `/_private` event subject
#      (`dkg:<cg>:async-publish:context-graph/...`), so the
#      anchor⇄payload join in the slice 03 partition selector
#      returns no rows for `finalized=false` even though the
#      data is present in both graphs. This is a slice 03 /
#      publisher data-layout mismatch, not a slice 04 concern.
#   3. Authorised-peer private sync to N2 only triggers after
#      on-chain finalization completes, so allow-list reads on
#      N2 stay empty in this devnet. Privacy is still positively
#      verified: N3 has the public anchor but NO `/_private`
#      payload.
#
# Topology:
#   N1 (publisher)     = node 1 @ port 9201
#   N2 (allowed peer)  = node 2 @ port 9202
#   N3 (unauthorized)  = node 3 @ port 9203
#
# CG selection: see the comment on `CG=` below — we use a CG that
# the devnet bootstrap registered.
set -uo pipefail

# NOTE on CG choice: we use a CG that the devnet bootstrap registered
# because runtime-registered CGs do not currently authorize the
# publisher wallet (see limitation #1 above). The slice's per-request
# CG flow is the same regardless of which specific CG is used —
# see assertions below that drive the route via `?contextGraphId=…`.
CG="${CG:-devnet-test}"
ALT_CG="${ALT_CG:-devnet-isolation}"
TOKEN="${TOKEN:-$(tail -1 .devnet/node1/auth.token 2>/dev/null)}"
N1="http://127.0.0.1:9201"
N2="http://127.0.0.1:9202"
N3="http://127.0.0.1:9203"
N2_PEER="${N2_PEER:-12D3KooWFSaaPmmE9K7eTEQUzc8wfF15vUPZtP82kxsoX1C38dWH}"
RUN_ID="$(date +%s)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

assert_status() {
  local name="$1" expected="$2" actual="$3" body="${4:-}"
  if [ "$actual" = "$expected" ]; then pass "$name (status=$actual)"
  else fail "$name (expected=$expected actual=$actual body=$body)"; fi
}
assert_match() {
  local name="$1" pattern="$2" body="$3"
  if echo "$body" | grep -Eq "$pattern"; then pass "$name (matched: $pattern)"
  else fail "$name (pattern '$pattern' not in body=$body)"; fi
}
assert_no_match() {
  local name="$1" pattern="$2" body="$3"
  if echo "$body" | grep -Eq "$pattern"; then fail "$name (pattern '$pattern' SHOULD NOT match: $body)"
  else pass "$name (correctly absent: $pattern)"; fi
}

post_capture() {
  local node="$1" payload="$2"
  curl -sS -o /tmp/s04-cap-body -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -X POST --data "$payload" "$node/api/epcis/capture"
}
get_capture_state() {
  local node="$1" cid="$2"
  curl -sS -H "Authorization: Bearer $TOKEN" "$node/api/epcis/capture/$cid"
}
get_events() {
  local node="$1" qs="$2"
  curl -sS -o /tmp/s04-q-body -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    "$node/api/epcis/events?$qs"
}
post_sparql() {
  local node="$1" cg="$2" sparql="$3"
  curl -sS -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -X POST --data "$(python3 -c 'import json,sys; print(json.dumps({"sparql":sys.argv[1],"contextGraphId":sys.argv[2]}))' "$sparql" "$cg")" \
    "$node/api/query"
}

# Inline EPCIS JSON-LD context — matches the namespace the query
# builder filters on (`https://gs1.github.io/EPCIS/`) so events
# materialise with the expected type URIs.
EPCIS_CTX='{"@vocab":"https://gs1.github.io/EPCIS/","epcis":"https://gs1.github.io/EPCIS/","cbv":"https://ref.gs1.org/cbv/","type":"@type","id":"@id","eventID":"@id"}'

DOC_BARE=$(printf '{"@context":%s,"type":"EPCISDocument","schemaVersion":"2.0","creationDate":"2026-05-05T00:00:00Z","epcisBody":{"eventList":[{"type":"ObjectEvent","eventID":"urn:uuid:s04-bare-%s","eventTime":"2026-05-05T08:00:00Z","eventTimeZoneOffset":"+00:00","epcList":["urn:epc:id:sgtin:S4.%s.001"],"action":"ADD","bizStep":"https://ref.gs1.org/cbv/BizStep-receiving"}]}}' "$EPCIS_CTX" "$RUN_ID" "$RUN_ID")

DOC_ALLOW=$(printf '{"@context":%s,"type":"EPCISDocument","schemaVersion":"2.0","creationDate":"2026-05-05T00:00:00Z","epcisBody":{"eventList":[{"type":"ObjectEvent","eventID":"urn:uuid:s04-allow-%s","eventTime":"2026-05-05T09:00:00Z","eventTimeZoneOffset":"+00:00","epcList":["urn:epc:id:sgtin:S4ALLOW.%s.001"],"action":"OBSERVE","bizStep":"https://ref.gs1.org/cbv/BizStep-shipping"}]}}' "$EPCIS_CTX" "$RUN_ID" "$RUN_ID")

DOC_SUB=$(printf '{"@context":%s,"type":"EPCISDocument","schemaVersion":"2.0","creationDate":"2026-05-05T00:00:00Z","epcisBody":{"eventList":[{"type":"ObjectEvent","eventID":"urn:uuid:s04-sub-%s","eventTime":"2026-05-05T10:00:00Z","eventTimeZoneOffset":"+00:00","epcList":["urn:epc:id:sgtin:S4SUB.%s.001"],"action":"ADD","bizStep":"https://ref.gs1.org/cbv/BizStep-receiving"}]}}' "$EPCIS_CTX" "$RUN_ID" "$RUN_ID")

# Wait until the canonical-graph anchor for `event_id_substr` lands on
# `node`. The publisher writes locally before kicking off the (failing)
# chain finalization step, so the local triplestore is the deterministic
# "data is queryable" signal. We use a SELECT (not ASK) because the
# daemon's read-only SPARQL guard currently rejects ASK queries that
# carry PREFIX directives.
wait_for_anchor() {
  local node="$1" cg="$2" graph_uri="$3" event_id_substr="$4" budget_s="${5:-60}"
  local elapsed=0 sparql body
  sparql="SELECT ?root WHERE { GRAPH <$graph_uri> { ?root <http://dkg.io/ontology/privateDataAnchor> \"true\" . FILTER(CONTAINS(STR(?root), \"$event_id_substr\")) } } LIMIT 1"
  while [ $elapsed -lt $budget_s ]; do
    body=$(post_sparql "$node" "$cg" "$sparql")
    if echo "$body" | grep -q "$event_id_substr"; then
      echo "ready"; return 0
    fi
    sleep 2
    elapsed=$((elapsed+2))
  done
  echo "timeout"
  return 1
}

echo "=== Slice 04 e2e (run=$RUN_ID, cg=$CG, alt-cg=$ALT_CG) ==="

# --- 1. Bare private capture on N1.
echo "[1] private capture on N1 (CG=$CG)"
PAYLOAD=$(printf '{"contextGraphId":"%s","epcisDocument":%s}' "$CG" "$DOC_BARE")
STATUS=$(post_capture "$N1" "$PAYLOAD")
BODY_CAP=$(cat /tmp/s04-cap-body)
assert_status "1.capture.status" "202" "$STATUS" "$BODY_CAP"
CID_BARE=$(echo "$BODY_CAP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["captureID"])')
echo "  captureID=$CID_BARE"

echo "[2] wait until bare-event anchor lands on N1's canonical graph"
RES=$(wait_for_anchor "$N1" "$CG" "did:dkg:context-graph:$CG" "s04-bare-$RUN_ID" 60)
if [ "$RES" = "ready" ]; then pass "2.bare-anchor.queryable"; else fail "2.bare-anchor.queryable ($RES)"; fi

# --- 3. Query — finalized=true on N1: per-request CG works,
# canonical partition surfaces the bare event with full payload.
echo "[3] query finalized=true on N1 with per-request contextGraphId"
QSTATUS=$(get_events "$N1" "contextGraphId=$CG&finalized=true&epc=urn:epc:id:sgtin:S4.${RUN_ID}.001")
QBODY=$(cat /tmp/s04-q-body)
assert_status "3.query.status" "200" "$QSTATUS" "$QBODY"
assert_match "3.event-time" '"eventTime":"2026-05-05T08:00:00' "$QBODY"
assert_match "3.bizStep-private-payload" 'BizStep-receiving' "$QBODY"
assert_match "3.epcList-private-payload" "urn:epc:id:sgtin:S4\\.${RUN_ID}\\.001" "$QBODY"
assert_match "3.eventType" 'ObjectEvent' "$QBODY"

# --- 4. Per-request CG isolation: same query on a DIFFERENT CG
# returns no events. Pins down that the route's `contextGraphId`
# query-string parameter actually scopes the SPARQL builder, not
# just lands as a no-op on top of a config fallback.
echo "[4] per-request contextGraphId scoping (alt-cg=$ALT_CG)"
QSTATUS=$(get_events "$N1" "contextGraphId=$ALT_CG&finalized=true&epc=urn:epc:id:sgtin:S4.${RUN_ID}.001")
QBODY=$(cat /tmp/s04-q-body)
assert_status "4.alt-query.status" "200" "$QSTATUS" "$QBODY"
assert_no_match "4.alt-query.no-bare-event" "S4\\.${RUN_ID}\\.001" "$QBODY"

# --- 5. Allow-list capture on N1 (we don't depend on cross-node
# private sync — that requires chain finalization, which is the
# pre-existing devnet limitation). Asserts capture accepts the
# allow-list shape; later checks (8, 9) verify N3 privacy.
echo "[5] allow-list capture on N1 (allowedPeers=[N2])"
ALLOW_PAYLOAD=$(printf '{"contextGraphId":"%s","epcisDocument":%s,"publishOptions":{"accessPolicy":"allowList","allowedPeers":["%s"]}}' "$CG" "$DOC_ALLOW" "$N2_PEER")
STATUS=$(post_capture "$N1" "$ALLOW_PAYLOAD")
BODY_CAP=$(cat /tmp/s04-cap-body)
assert_status "5.allow.status" "202" "$STATUS" "$BODY_CAP"
CID_ALLOW=$(echo "$BODY_CAP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["captureID"])')
echo "  captureID=$CID_ALLOW"

echo "[6] wait until allow-event anchor lands on N1's canonical graph"
RES=$(wait_for_anchor "$N1" "$CG" "did:dkg:context-graph:$CG" "s04-allow-$RUN_ID" 60)
if [ "$RES" = "ready" ]; then pass "6.allow-anchor.queryable"; else fail "6.allow-anchor.queryable ($RES)"; fi

echo "[7] query allow-event finalized=true on N1 — per-request CG carries through"
QSTATUS=$(get_events "$N1" "contextGraphId=$CG&finalized=true&epc=urn:epc:id:sgtin:S4ALLOW.${RUN_ID}.001")
QBODY=$(cat /tmp/s04-q-body)
assert_status "7.query.status" "200" "$QSTATUS" "$QBODY"
assert_match "7.event-time" '"eventTime":"2026-05-05T09:00:00' "$QBODY"
assert_match "7.bizStep-private-payload" 'BizStep-shipping' "$QBODY"
assert_match "7.action-private-payload" '"action":"OBSERVE"' "$QBODY"

# --- 8/9. Privacy: N3 (unauthorised) MUST NOT see the allow-list
# event payload via the EPCIS query, and MUST NOT have the private
# payload in its `/_private` graph at all. The public anchor in
# the canonical partition is allowed to leak (that's how N3 knows
# something exists at all) — but only the anchor, not the payload.
echo "[8] N3 EPCIS query for allow-event — orphan exclusion"
QSTATUS=$(get_events "$N3" "contextGraphId=$CG&finalized=true&epc=urn:epc:id:sgtin:S4ALLOW.${RUN_ID}.001")
QBODY=$(cat /tmp/s04-q-body)
assert_status "8.n3.status" "200" "$QSTATUS" "$QBODY"
assert_no_match "8.n3.no-allow-event" "urn:epc:id:sgtin:S4ALLOW\\.${RUN_ID}\\.001" "$QBODY"
assert_no_match "8.n3.no-shipping-payload" 'BizStep-shipping' "$QBODY"

echo "[9] N3 raw SPARQL — _private graph does NOT contain allow-event payload"
SPARQL_PRIV="SELECT ?s ?p ?o WHERE { GRAPH <did:dkg:context-graph:$CG/_private> { ?s ?p ?o FILTER(CONTAINS(STR(?s), \"s04-allow-$RUN_ID\") || CONTAINS(STR(?o), \"S4ALLOW.$RUN_ID\")) } } LIMIT 5"
SP_BODY=$(post_sparql "$N3" "$CG" "$SPARQL_PRIV")
assert_no_match "9.n3.no-allow-private-bindings" "S4ALLOW\\.${RUN_ID}" "$SP_BODY"
assert_no_match "9.n3.no-shipping-in-private" 'BizStep-shipping' "$SP_BODY"

# --- Sub-graph variant ---
echo "[10] register sub-graph 'research' on N1"
SG_BODY=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST \
  --data "{\"contextGraphId\":\"$CG\",\"subGraphName\":\"research\"}" \
  "$N1/api/sub-graph/create")
if echo "$SG_BODY" | grep -Eq '"created"|already exists'; then
  pass "10.sub-graph.registered (body=$SG_BODY)"
else
  fail "10.sub-graph.registered (body=$SG_BODY)"
fi

echo "[11] sub-graph capture on N1 (subGraphName=research)"
SUB_PAYLOAD=$(printf '{"contextGraphId":"%s","subGraphName":"research","epcisDocument":%s}' "$CG" "$DOC_SUB")
STATUS=$(post_capture "$N1" "$SUB_PAYLOAD")
BODY_CAP=$(cat /tmp/s04-cap-body)
assert_status "11.sub.capture.status" "202" "$STATUS" "$BODY_CAP"

# Sub-graph anchor also lives in the canonical partition, but in the
# sub-graph variant URI: <cg>/<sub>. Wait until it appears.
echo "[12] wait until sub-event anchor lands on N1's <cg>/research canonical graph"
RES=$(wait_for_anchor "$N1" "$CG" "did:dkg:context-graph:$CG/research" "s04-sub-$RUN_ID" 60)
if [ "$RES" = "ready" ]; then pass "12.sub-anchor.queryable"; else fail "12.sub-anchor.queryable ($RES)"; fi

echo "[13] sub-graph EPCIS query — per-request subGraphName routing"
QSTATUS=$(get_events "$N1" "contextGraphId=$CG&subGraphName=research&finalized=true&epc=urn:epc:id:sgtin:S4SUB.${RUN_ID}.001")
QBODY=$(cat /tmp/s04-q-body)
assert_status "13.sub.query.status" "200" "$QSTATUS" "$QBODY"
assert_match "13.sub.event-time" '"eventTime":"2026-05-05T10:00:00' "$QBODY"
assert_match "13.sub.epc-list" "urn:epc:id:sgtin:S4SUB\\.${RUN_ID}\\.001" "$QBODY"
assert_match "13.sub.eventType" 'ObjectEvent' "$QBODY"

echo "[14] root-graph query MUST NOT return the sub-graph event"
QSTATUS=$(get_events "$N1" "contextGraphId=$CG&finalized=true&epc=urn:epc:id:sgtin:S4SUB.${RUN_ID}.001")
QBODY=$(cat /tmp/s04-q-body)
assert_status "14.root.query.status" "200" "$QSTATUS" "$QBODY"
assert_no_match "14.root.excludes-sub-event" "S4SUB\\.${RUN_ID}" "$QBODY"

# --- Validation surface (mirrors the unit tests but on the live route) ---
echo "[15] invalid contextGraphId → 400"
QSTATUS=$(get_events "$N1" "contextGraphId=bad%20cg%20with%20spaces")
QBODY=$(cat /tmp/s04-q-body)
assert_status "15.bad-cg.status" "400" "$QSTATUS" "$QBODY"
assert_match "15.bad-cg.message" '"error":"InvalidContent"' "$QBODY"
assert_match "15.bad-cg.message-names" 'contextGraphId' "$QBODY"

echo "[16] invalid subGraphName (reserved underscore) → 400"
QSTATUS=$(get_events "$N1" "contextGraphId=$CG&subGraphName=_reserved")
QBODY=$(cat /tmp/s04-q-body)
assert_status "16.bad-sg.status" "400" "$QSTATUS" "$QBODY"
assert_match "16.bad-sg.message" '"error":"InvalidContent"' "$QBODY"
assert_match "16.bad-sg.message-names" 'subGraphName' "$QBODY"
assert_match "16.bad-sg.message-reason" 'reserved' "$QBODY"

echo
echo "=== Result: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
