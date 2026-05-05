#!/usr/bin/env bash
# Slice 02 e2e smoke: per-request contextGraphId + subGraphName on /api/epcis/capture.
# Assumes a running devnet at $API (default node 1: http://127.0.0.1:9201) with
# a publisher wallet configured and the context graph "devnet-test" registered.
set -uo pipefail

API="${API:-http://127.0.0.1:9201}"
TOKEN="${TOKEN:-$(tail -1 .devnet/node1/auth.token 2>/dev/null)}"
RUN_ID="$(date +%s)"

PASS=0
FAIL=0

assert() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  local body="${4:-}"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $name (status=$actual)"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $name (expected=$expected actual=$actual body=$body)"
    FAIL=$((FAIL+1))
  fi
}

assert_match() {
  local name="$1"
  local pattern="$2"
  local body="$3"
  if echo "$body" | grep -Eq "$pattern"; then
    echo "  PASS  $name (matched: $pattern)"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $name (pattern '$pattern' not in body=$body)"
    FAIL=$((FAIL+1))
  fi
}

post() {
  curl -s -o /tmp/slice02-body -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -X POST --data "$1" "$API/api/epcis/capture"
}

DOC='{"@context":"https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld","type":"EPCISDocument","schemaVersion":"2.0","creationDate":"2026-05-05T00:00:00Z","epcisBody":{"eventList":[{"type":"ObjectEvent","eventTime":"2026-05-05T00:00:00Z","eventTimeZoneOffset":"+00:00","epcList":["urn:epc:id:sgtin:SLICE02.'"$RUN_ID"'.001"],"action":"ADD","bizStep":"https://ref.gs1.org/cbv/BizStep-receiving"}]}}'

echo "=== Slice 02 e2e smoke (run=$RUN_ID, api=$API) ==="

# --- 1. Missing CG everywhere → 400 InvalidContent.
echo "[1] missing contextGraphId everywhere → 400"
PAYLOAD=$(printf '{"epcisDocument":%s}' "$DOC")
STATUS=$(post "$PAYLOAD")
BODY=$(cat /tmp/slice02-body)
assert "1.status" "400" "$STATUS" "$BODY"
assert_match "1.body.error=InvalidContent" '"error":"InvalidContent"' "$BODY"
assert_match "1.body.message names body+config" 'epcis\.contextGraphId' "$BODY"

# --- 2. Invalid contextGraphId → 400.
echo "[2] invalid contextGraphId → 400"
PAYLOAD=$(printf '{"contextGraphId":"bad cg with spaces","epcisDocument":%s}' "$DOC")
STATUS=$(post "$PAYLOAD")
BODY=$(cat /tmp/slice02-body)
assert "2.status" "400" "$STATUS" "$BODY"
assert_match "2.body.message" 'Invalid .*contextGraphId' "$BODY"

# --- 3. Invalid subGraphName (reserved prefix) → 400.
echo "[3] invalid subGraphName → 400"
PAYLOAD=$(printf '{"contextGraphId":"devnet-test","subGraphName":"_reserved","epcisDocument":%s}' "$DOC")
STATUS=$(post "$PAYLOAD")
BODY=$(cat /tmp/slice02-body)
assert "3.status" "400" "$STATUS" "$BODY"
assert_match "3.body.message" 'Invalid .*subGraphName' "$BODY"
assert_match "3.body.message reason" 'reserved' "$BODY"

# --- 4. Empty subGraphName → 400.
echo "[4] empty subGraphName → 400"
PAYLOAD=$(printf '{"contextGraphId":"devnet-test","subGraphName":"","epcisDocument":%s}' "$DOC")
STATUS=$(post "$PAYLOAD")
BODY=$(cat /tmp/slice02-body)
assert "4.status" "400" "$STATUS" "$BODY"

# --- 5. contextGraphId wrong type → 400.
echo "[5] non-string contextGraphId → 400"
PAYLOAD=$(printf '{"contextGraphId":42,"epcisDocument":%s}' "$DOC")
STATUS=$(post "$PAYLOAD")
BODY=$(cat /tmp/slice02-body)
assert "5.status" "400" "$STATUS" "$BODY"
assert_match "5.body.message" 'must be a string' "$BODY"

# --- 6. subGraphName threading: an unregistered sub-graph reaches the
# publisher and is rejected with a message that names the sub-graph.
# This is the cleanest in-process proof that subGraphName traverses
# route → handler → publisher opts.
echo "[6] subGraphName threads to publisher (unregistered → 503 names it)"
PAYLOAD=$(printf '{"contextGraphId":"devnet-test","subGraphName":"research","epcisDocument":%s}' "$DOC")
STATUS=$(post "$PAYLOAD")
BODY=$(cat /tmp/slice02-body)
assert "6.status" "503" "$STATUS" "$BODY"
assert_match "6.body.error" '"error":"EnqueueFailed"' "$BODY"
assert_match "6.body.message names sub-graph" 'Sub-graph .*research' "$BODY"

# --- 7. Valid per-request CG only (no subGraphName) → 202.
echo "[7] valid contextGraphId, no subGraphName → 202"
PAYLOAD=$(printf '{"contextGraphId":"devnet-test","epcisDocument":%s}' "$DOC")
STATUS=$(post "$PAYLOAD")
BODY=$(cat /tmp/slice02-body)
assert "7.status" "202" "$STATUS" "$BODY"
assert_match "7.body.status" '"status":"accepted"' "$BODY"

echo
echo "=== Result: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
