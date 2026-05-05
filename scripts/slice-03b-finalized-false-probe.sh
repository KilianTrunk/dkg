#!/usr/bin/env bash
# Slice 03b probe: single-node, single-scenario verification that
# `?finalized=false` returns the captured event with full payload after
# the lift writes both the SWM anchor and the `<cg>/_private` payload
# under the same root IRI (the slice 03b fix).
#
# Setup expected:
#   - 6-node devnet started with `DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start`
#   - Auth token at `.devnet/node1/auth.token`
#   - CG = `devnet-test` (devnet-bootstrapped, has on-chain publisher
#     authority — chosen so the lift can reach finalization).
#
# What this probe asserts:
#   - SWM anchor in `<cg>/_shared_memory` and `<cg>/_private` payload
#     share the same root IRI (the bug this slice fixes).
#   - GET /api/epcis/events?finalized=false returns the event with the
#     full payload (eventTime, bizStep, epcList).

set -uo pipefail

CG="${CG:-devnet-test}"
TOKEN="${TOKEN:-$(tail -1 .devnet/node1/auth.token 2>/dev/null)}"
N1="http://127.0.0.1:9201"
RUN_ID="$(date +%s)"
EVENT_ID="urn:uuid:s03b-${RUN_ID}"
EPC="urn:epc:id:sgtin:S03B.${RUN_ID}.001"

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

post_capture() {
  curl -sS -o /tmp/s03b-cap-body -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -X POST --data "$1" "$N1/api/epcis/capture"
}
get_events() {
  curl -sS -o /tmp/s03b-q-body -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    "$N1/api/epcis/events?$1"
}
post_sparql() {
  curl -sS -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -X POST --data "$(python3 -c 'import json,sys; print(json.dumps({"sparql":sys.argv[1],"contextGraphId":sys.argv[2]}))' "$1" "$CG")" \
    "$N1/api/query"
}

EPCIS_CTX='{"@vocab":"https://gs1.github.io/EPCIS/","epcis":"https://gs1.github.io/EPCIS/","cbv":"https://ref.gs1.org/cbv/","type":"@type","id":"@id","eventID":"@id"}'

DOC=$(printf '{"@context":%s,"type":"EPCISDocument","schemaVersion":"2.0","creationDate":"2026-05-05T00:00:00Z","epcisBody":{"eventList":[{"type":"ObjectEvent","eventID":"%s","eventTime":"2026-05-05T11:00:00Z","eventTimeZoneOffset":"+00:00","epcList":["%s"],"action":"ADD","bizStep":"https://ref.gs1.org/cbv/BizStep-receiving"}]}}' "$EPCIS_CTX" "$EVENT_ID" "$EPC")

# Wait until the SWM anchor for the event lands on N1. The publisher
# writes the SWM anchor synchronously inside POST /capture, so this
# usually returns "ready" on the first poll, but we leave a budget for
# slow CI.
wait_for_swm_anchor() {
  local budget_s=30 elapsed=0 sparql body
  sparql="SELECT ?root WHERE { GRAPH <did:dkg:context-graph:$CG/_shared_memory> { ?root <http://dkg.io/ontology/privateDataAnchor> \"true\" . FILTER(CONTAINS(STR(?root), \"s03b-$RUN_ID\")) } } LIMIT 1"
  while [ $elapsed -lt $budget_s ]; do
    body=$(post_sparql "$sparql")
    if echo "$body" | grep -q "s03b-$RUN_ID"; then echo "ready"; return 0; fi
    sleep 1
    elapsed=$((elapsed+1))
  done
  echo "timeout"; return 1
}

# Wait until the `<cg>/_private` payload lands on N1. With the slice 03b
# fix, the lift writes the payload under the same root IRI as the SWM
# anchor (no canonical-form remap), so the first poll usually wins —
# but a real lift round-trip can still take a few seconds.
wait_for_private_payload() {
  local budget_s=60 elapsed=0 sparql body
  sparql="SELECT ?p ?o WHERE { GRAPH <did:dkg:context-graph:$CG/_private> { <$EVENT_ID> ?p ?o } } LIMIT 1"
  while [ $elapsed -lt $budget_s ]; do
    body=$(post_sparql "$sparql")
    # Body shape on the daemon: {"result":{"bindings":[{...}]}}.
    # Match a non-empty `bindings` array — at least one `{` after the
    # opening `[`.
    if echo "$body" | grep -Eq '"bindings":[[:space:]]*\[[[:space:]]*\{'; then
      echo "ready"; return 0
    fi
    sleep 2
    elapsed=$((elapsed+2))
  done
  echo "timeout"; return 1
}

echo "=== Slice 03b probe (run=$RUN_ID, cg=$CG, event=$EVENT_ID) ==="

echo "[1] private capture on N1"
PAYLOAD=$(printf '{"contextGraphId":"%s","epcisDocument":%s}' "$CG" "$DOC")
STATUS=$(post_capture "$PAYLOAD")
BODY_CAP=$(cat /tmp/s03b-cap-body)
assert_status "1.capture.status" "202" "$STATUS" "$BODY_CAP"
CID=$(echo "$BODY_CAP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["captureID"])')
echo "  captureID=$CID"

echo "[2] wait for SWM anchor under the source root IRI"
RES=$(wait_for_swm_anchor)
if [ "$RES" = "ready" ]; then pass "2.swm-anchor.same-root-iri"; else fail "2.swm-anchor.same-root-iri ($RES)"; fi

echo "[3] verify SWM anchor IS the source URN, not a remapped dkg: scheme"
SP=$(post_sparql "SELECT ?root WHERE { GRAPH <did:dkg:context-graph:$CG/_shared_memory> { ?root <http://dkg.io/ontology/privateDataAnchor> \"true\" . FILTER(CONTAINS(STR(?root), \"s03b-$RUN_ID\")) } } LIMIT 1")
assert_match "3.swm-anchor.is-urn-uuid" "\"$EVENT_ID\"" "$SP"

echo "[4] wait for <cg>/_private payload under the same source root IRI"
RES=$(wait_for_private_payload)
if [ "$RES" = "ready" ]; then pass "4.private-payload.same-root-iri"; else fail "4.private-payload.same-root-iri ($RES)"; fi

echo "[5] verify <cg>/_private payload is keyed by the same source IRI (not the canonical dkg: scheme)"
SP=$(post_sparql "SELECT ?o WHERE { GRAPH <did:dkg:context-graph:$CG/_private> { <$EVENT_ID> <https://gs1.github.io/EPCIS/eventTime> ?o } } LIMIT 1")
assert_match "5.private-payload.eventTime" '"2026-05-05T11:00:00' "$SP"

echo "[6] verify NO dkg:async-publish: subject leaked into <cg>/_private"
SP=$(post_sparql "SELECT ?s WHERE { GRAPH <did:dkg:context-graph:$CG/_private> { ?s ?p ?o FILTER(STRSTARTS(STR(?s), \"dkg:$CG:async-publish:\") && CONTAINS(STR(?s), \"s03b-$RUN_ID\")) } } LIMIT 1")
if echo "$SP" | grep -Eq '"bindings":\s*\[\s*\{'; then
  fail "6.no-canonical-leak (found dkg:async-publish subject: $SP)"
else
  pass "6.no-canonical-leak (private payload keeps source IRI)"
fi

echo "[7] GET /api/epcis/events?finalized=false returns the event with full payload"
QSTATUS=$(get_events "contextGraphId=$CG&finalized=false&epc=$EPC")
QBODY=$(cat /tmp/s03b-q-body)
assert_status "7.swm-query.status" "200" "$QSTATUS" "$QBODY"
assert_match "7.swm-query.event-time" '"eventTime":"2026-05-05T11:00:00' "$QBODY"
assert_match "7.swm-query.bizStep" 'BizStep-receiving' "$QBODY"
assert_match "7.swm-query.epcList" "urn:epc:id:sgtin:S03B\\.${RUN_ID}\\.001" "$QBODY"
assert_match "7.swm-query.eventType" 'ObjectEvent' "$QBODY"

echo "[8] cross-check: GET ?finalized=true also returns the event (regression guard for slice 04)"
QSTATUS=$(get_events "contextGraphId=$CG&finalized=true&epc=$EPC")
QBODY=$(cat /tmp/s03b-q-body)
assert_status "8.canonical-query.status" "200" "$QSTATUS" "$QBODY"
assert_match "8.canonical-query.event-time" '"eventTime":"2026-05-05T11:00:00' "$QBODY"

echo
echo "=== Result: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
