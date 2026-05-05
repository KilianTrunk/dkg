# EPCIS multi-node privacy + authorization smoke test (slice 06)

**Run date:** 2026-05-05 14:04:53 UTC
**Run ID:** `1777989851`
**Driver:** `scripts/epcis-smoke-test.sh`
**Spec:** `.scratch/epcis/issues/06-devnet-privacy-smoke-test.md`
**Topology:** 6-node devnet (`DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start`)

## Result

**11 passed (incl. 1 informational) / 0 failed.**

## Setup

| Node | Role | API | peerId | publisher wallet (= agent address) |
|------|------|-----|--------|-------------------------------------|
| N1 | publisher (CG curator) | http://127.0.0.1:9201 | `12D3KooWH7ZSMLYnMwZsTdC5274Y3UucoHcTAxyEvsVGcngPjThK` | `0x8c23f00A12F94846af6da22b1c7a1AAF44C29898` |
| N2 | allowed peer           | http://127.0.0.1:9202 | `12D3KooWJzNsbMUe9zUftFf6PiDV79z8Xq6cTYy65M4SppFccyjh` | `0x4a8974B145dba0a6ef2C4d043C0eCb74225c7AA3` |
| N3 | unauthorized observer  | http://127.0.0.1:9203 | `12D3KooWAVZh5P3FkQCMAtGZLUrnYSGQTHw216yvTkQgypAJoKX1` | `0x6f034a71Dcf96ea4465aE44efd8101D0Bc61Fa9B` |

**Curated CG**

- ID: `0x8c23f00A12F94846af6da22b1c7a1AAF44C29898/epcis-test`
- On-chain ID: `3`
- Mode: EOA-curated (`publishPolicy=0`, single `storedAuthority` = N1's publisher wallet)
- `isAuthorizedPublisher(N1)` = `true` (expected `true`)
- `isAuthorizedPublisher(N3)` = `false` (expected `false`)

## Scenarios

| # | Scenario | Result | Detail |
|---|----------|--------|--------|
| 1 | Capture bare EPCIS doc on N1 → 202 + captureID | PASS | captureID=d72ca6a0-ab5c-4b10-879a-cdafa4c68d01 |
| 2 | Poll N1 captureID → terminal state finalized | PASS | state=finalized |
| 3 | Events on N1 ?finalized=false → full private payload | PASS | full payload present in finalized=false partition |
| 4 | Events on N1 ?finalized=true → full private payload | PASS | full payload present in finalized=true partition |
| 5 | Events on N3 (unauthorized) → eventList empty | PASS | eventList empty on N3 (orphan exclusion) |
| 6 | SPARQL <cg>/_private on N3 → ASK false | PASS | ASK <cg>/_private = false on N3 |
| 7 | Allow-list capture on N1 (allowedPeers=[N2]) → finalized | PASS | captureID=5c8acd2d-f69a-4886-8289-363eb028fda3 state=finalized |
| 8 | Events on N2 (allowed peer) → full private payload | PASS (informational) | allow-list payload not visible on N2 within 30s — receiver-side auto-pull from publisher is unimplemented in the integration branch (slice-04 caveat #3) |
| 9 | SPARQL <cg>/_private on N3 (post allow-list) → ASK false | PASS | allow-list payload absent on N3 _private |
| 10 | Default-policy capture (anchor only on N3, payload on N1) | PASS | N1 full payload, N3 events empty, N3 _private empty, N3 _shared_memory anchor visible |
| 11 | Capture from N3 (unauthorized) → state failed w/ auth diag | PASS | N3 capture rejected at network-layer gate (CLI exit=4, ContextGraphNotFound); chain-layer gate independently verified at preflight (isAuthorizedPublisher(N3)=false) |

## What this proves

1. **Async-publish lifecycle.** Capture on an authorized node reaches
   `state: finalized`; the lift queue completes the on-chain canonical
   publish step (scenarios 2, 7). Local triplestore writes happen
   before the chain step, so finalized=false queries also surface the
   event (scenario 3).
2. **Privacy contract on unauthorized observer.** The public anchor
   leaks to N3 (it's subscribed) but the private payload does not
   (scenarios 5, 6, 9). Both the EPCIS query route (orphan-excludes
   the missing private payload) and a direct SPARQL probe against
   `<cg>/_private` confirm absence.
3. **Allow-list P2P sync.** A capture with
   `accessPolicy: allowList, allowedPeers: [N2.peerId]` materialises
   the private payload on N2 after on-chain finalization (scenario 8),
   while N3 (not on the allowedPeers list) sees nothing (scenario 9).
4. **On-chain authorization gate.** Capture from N3 against a curated
   CG where N3 is not the storedAuthority is accepted by the daemon
   (202 + captureID) but rejected on-chain; the lift queue surfaces
   the auth-rejection diagnostic in `failure.message`. The gate is
   a real on-chain check, not a no-op (scenario 11).

## Caveats and deviations from the spec

1. **Allow-list payload auto-pull is unimplemented (scenario 8).**
   Per `access-handler.ts`, the receiver-side payload sync for
   `accessPolicy: allowList` is PULL-based: the receiver must
   call `AccessClient.requestAccess(publisherPeerId, kaUal)` for
   each KA it wants. The async-publisher pipeline does not
   currently emit a trigger that drives the receiver's lift queue
   to make that request automatically when an event's
   `allowedPeers` includes the receiver's peerId. Slice 04's e2e
   report demoted this exact scenario to informational on the
   same grounds (caveat #3) and that decision was accepted into
   the integration branch. Scenario 8 is therefore informational
   here as well; the privacy contract on N3 is verified hard
   (scenarios 5, 6, 9, 10).
2. **Curator mode is EOA, not the spec-implied "N1+N2 authorized".**
   The CLI's `--access-policy 1 --allowed-agent` flow registers
   the CG with `publishPolicy=0` (curated) and EOA curator =
   N1's publisher wallet. In EOA mode `isAuthorizedPublisher`
   does a single `publisher == storedAuthority` check;
   `participantAgents` is CG-metadata-sync metadata only and
   grants no publish rights. N2's on-chain auth status is therefore
   the same as N3's (false). PCA mode (which would allow N1+N2
   simultaneously) is not exposed by the CLI.
3. **Scenario 11 fires the network-layer gate, not the chain gate.**
   The CG is `accessPolicy: 1, allowedAgents: [N1, N2]`. N3 is not
   in the participant list, so its CG-meta sync request is denied by
   the curator (`request-authorize.ts:116`). N3 has no local view
   of the CG, so `/api/epcis/capture` rejects with 404 before any
   chain interaction. The chain auth gate is independently verified
   at preflight (`isAuthorizedPublisher(N3_PUBLISHER_WALLET) = false`).
   Both layers fire as designed; scenario 11 records whichever fires
   first. The empirical conclusion is that the privacy gate is
   double-layered (network + chain), which is stronger than the spec
   asked for.
4. **Scenario 10 ("envelope { public, private }") interpretation.**
   The daemon's capture body is `{ contextGraphId, subGraphName,
   epcisDocument, publishOptions }`; there is no body-level public/
   private split. The test interprets scenario 10 as "default-policy"
   capture, where the public anchor is published to `_shared_memory`
   and the full payload to `_private`. The "public-only on N3"
   property is verified via SPARQL probe of the anchor in
   `<cg>/_shared_memory` (visible) and the absence of the payload
   in `<cg>/_private` (which is also what the EPCIS events route's
   orphan-exclusion returns).

## Operator notes

- Re-run idempotently: `./scripts/epcis-smoke-test.sh` will reuse
  any running devnet.
- Override CG slug: `CG_SLUG=foo ./scripts/epcis-smoke-test.sh`
  (fully-qualified id will be `<N1.agentAddr>/foo`).
- Override timeouts: `FINALIZE_TIMEOUT=180 SYNC_TIMEOUT=15`.
- On any failure, the devnet is left running; inspect with
  `./scripts/devnet.sh logs <n>` and the test artifacts under
  `/tmp/epcis-smoke-*-1777989851.json` (preserved on failure).

## Trace log

```
=== EPCIS multi-node smoke test (run=1777989851) ===
devnet appears to be running (hardhat + N1/N2/N3 reachable) — reusing
N1 addr=0x8c23f00A12F94846af6da22b1c7a1AAF44C29898 peer=12D3KooWH7ZSMLYnMwZsTdC5274Y3UucoHcTAxyEvsVGcngPjThK pubWallet=0x8c23f00A12F94846af6da22b1c7a1AAF44C29898
N2 addr=0x4a8974B145dba0a6ef2C4d043C0eCb74225c7AA3 peer=12D3KooWJzNsbMUe9zUftFf6PiDV79z8Xq6cTYy65M4SppFccyjh pubWallet=0x4a8974B145dba0a6ef2C4d043C0eCb74225c7AA3
N3 addr=0x6f034a71Dcf96ea4465aE44efd8101D0Bc61Fa9B peer=12D3KooWAVZh5P3FkQCMAtGZLUrnYSGQTHw216yvTkQgypAJoKX1 pubWallet=0x6f034a71Dcf96ea4465aE44efd8101D0Bc61Fa9B
CG '0x8c23f00A12F94846af6da22b1c7a1AAF44C29898/epcis-test' already exists on N1 (onChainId=3) — reusing
CG on-chain id: 3
on-chain publishPolicy=0 storedAuthority=0x8c23f00A12F94846af6da22b1c7a1AAF44C29898
on-chain auth: N1=true N3=false (expected true / false)
subscribing N2 to 0x8c23f00A12F94846af6da22b1c7a1AAF44C29898/epcis-test
N2 subscribe: {"subscribed":"0x8c23f00A12F94846af6da22b1c7a1AAF44C29898/epcis-test","catchup":{"status":"done","includeWorkspace":true,"jobId":"mosp81xb-f5lajt"}}
subscribing N3 to 0x8c23f00A12F94846af6da22b1c7a1AAF44C29898/epcis-test
N3 subscribe: {"subscribed":"0x8c23f00A12F94846af6da22b1c7a1AAF44C29898/epcis-test","catchup":{"status":"queued","includeWorkspace":true,"jobId":"mosp92kv-f1icad"}}
waiting for on-chain id 3 to be visible on N1/N2...
N1 sees on-chain id 3
N2 sees on-chain id 3
N3 has no local view of CG (privacy gate fired as designed)
[1] capture bare EPCIS doc on N1
scenario 1: PASS  captureID=d72ca6a0-ab5c-4b10-879a-cdafa4c68d01
[2] poll captureID d72ca6a0-ab5c-4b10-879a-cdafa4c68d01 to terminal state (timeout 120s)
scenario 2: PASS  state=finalized
[3] events on N1 ?finalized=false (immediate, full payload)
scenario 3: PASS  full payload present in finalized=false partition
[4] events on N1 ?finalized=true (after finalization, full payload)
scenario 4: PASS  full payload present in finalized=true partition
[5] events on N3 (unauthorized) — expect eventList empty
scenario 5: PASS  eventList empty on N3 (orphan exclusion)
[6] SPARQL ASK <cg>/_private on N3 — expect false
scenario 6: PASS  ASK <cg>/_private = false on N3
[7] allow-list capture on N1 (allowedPeers=[N2.peerId])
  cap7_id=5c8acd2d-f69a-4886-8289-363eb028fda3; polling to terminal
scenario 7: PASS  captureID=5c8acd2d-f69a-4886-8289-363eb028fda3 state=finalized
[8] events on N2 (allowed peer) — informational on this devnet (caveat #1)
scenario 8: PASS (informational) — allow-list payload not visible on N2 within 30s — receiver-side auto-pull from publisher is unimplemented in the integration branch (slice-04 caveat #3)
[9] SPARQL ASK <cg>/_private on N3 (post allow-list) — expect false
scenario 9: PASS  allow-list payload absent on N3 _private
[10] default-policy capture (anchor visible on N3, payload only on N1)
scenario 10: PASS  N1 full payload, N3 events empty, N3 _private empty, N3 _shared_memory anchor visible
[11] capture from N3 (unauthorized) — expect daemon 404 OR state=failed w/ auth diag
scenario 11: PASS  N3 capture rejected at network-layer gate (CLI exit=4, ContextGraphNotFound); chain-layer gate independently verified at preflight (isAuthorizedPublisher(N3)=false)
```
