# Runbook — Manual host-mode subscribe (`POST /api/shared-memory/host-mode/subscribe`)

**Scope.** Operator playbook for the manual / fourth-resort path that asks
a core daemon to start hosting a curated CG's opaque SWM ciphertext
without waiting for any of the three automatic discovery paths to fire.

This runbook covers **when** to reach for it (and when not to), **how**
to call it safely, and **what the four discovery paths each look like**
so you can tell from a log whether the manual call is actually needed.

## TL;DR

Almost always you should let LU-6 Phase B's automatic discovery do its
job. The manual subscribe is a last-resort tool — reach for it only when
**all three** automatic paths have demonstrably failed for a CG, and a
late-joining member is asking for catchup that cores can't yet serve.

## The four discovery paths

A core daemon picks up curated-CG hosting assignments through one of
four mechanisms. The first three are automatic; the fourth is what this
runbook covers.

| # | Path | Wired at | Triggers when |
|---|------|----------|---------------|
| 1 | **Chain-event auto-subscribe** | `packages/agent/src/dkg-agent.ts:1737-1803` (`ContextGraphCreated` event listener inside the chain poller) | Curator registers an `accessPolicy=1` CG on-chain with a `nameHash` commitment. Cores in the sharding table with `swmHostMode` enabled subscribe immediately on event arrival. |
| 2 | **Discovery beacon** | `packages/agent/src/dkg-agent.ts:1810-1838` (global `DKG_CG_DISCOVERY_TOPIC` gossip subscribe + `BEACON_REANNOUNCE_INTERVAL_MS` re-announce timer) | Curator pre-registers a CG (before any on-chain transaction) and starts re-announcing it on the discovery topic. Cores hear the beacon and subscribe. Used for pre-reg / off-chain-only CGs. |
| 3 | **Periodic reconciler** | `packages/agent/src/dkg-agent.ts:9347-9376` (`hostModeReconcilerTimer`, default 30s) | Catches anything the first two paths missed (chain event lost in a re-org, beacon missed during a restart, etc.). Sweeps every locally-known CG and ensures host-mode subscription state is in sync. Idempotent. |
| 4 | **Operator-driven manual subscribe** *(this runbook)* | `packages/cli/src/daemon/routes/memory.ts:960-977` (`POST /api/shared-memory/host-mode/subscribe`) | Operator explicitly POSTs a `contextGraphId`. The daemon enables host-mode for it the same way the reconciler would. |

Paths 1–3 cover the documented Phase B happy path: a curator registers
a CG, cores see it, cores host it. Path 4 exists for the gaps those
three don't cover.

## When to reach for the manual path

Use the manual subscribe **only** when you can demonstrate at least one
of:

1. **Off-chain CG / no chain commitment.** The curator did not register
   on-chain and does not run the discovery beacon (e.g. a one-off
   curated CG used inside an organization that lives entirely off-chain).
   Paths 1 and 2 cannot fire; path 3 only reconciles CGs the local node
   already knows about, so a fresh core needs to be told the id.
2. **Coverage gap during rc.10 rollout.** Fewer than `minimumRequired-
   Signatures` rc.10 cores are connected to the curator, and you (the
   operator) want to deliberately enroll a specific core as an opaque
   host. This is a transitional tool while the rc.10 testnet capacity
   ramps; once enough cores are auto-subscribed via paths 1–3, this
   case goes away.
3. **Late-joining member catchup is failing** AND the failure log shows
   "no cores hold ciphertext for this CG" rather than a decryption /
   permission error. (If a member's catchup fails with `AEAD verify
   failed`, the issue is membership/key distribution, not host-mode
   subscription — manually subscribing more cores will not help.)

**Do not** use this as a routine subscribe call. If you find yourself
reaching for it on every fresh CG, paths 1–3 are not firing correctly
and that's the real bug to fix — file a ticket against the discovery
poller, not against the daemon that needed the manual nudge.

## Preconditions

- Target daemon must be a **core** node (`nodeRole === 'core'`) with
  `swmHostMode` enabled in `~/.dkg/config.json`. Edge nodes have host
  mode disabled by build; the endpoint returns a no-op on those.
- Operator must have the daemon's `~/.dkg/auth.token` (same `Bearer`
  scheme every other `/api/*` route uses).
- Target CG must be **curated** (`accessPolicy === 1`). Public CGs use
  the plaintext SWM substrate and don't need an opaque host.

## How to call it

```bash
# Pick up the daemon's auth token. The default location is the
# per-node ~/.dkg/auth.token; if you run multiple nodes via
# scripts/devnet.sh, each node has its own auth.token under
# .devnet/nodeN/.
AUTH="$(tail -1 ~/.dkg/auth.token)"

# `contextGraphId` is the SAME id the curator used at `dkg context-graph
# create` time. On the hosting core you'll typically supply the
# curator-committed `nameHash` (the on-chain wire id) — that's what the
# chain-event path uses internally and it's what `gossipWireIdFor`
# expects to resolve into the SWM gossip topic.
curl -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{ "contextGraphId": "<curator-agent>/lj-A-1717000000" }' \
  http://127.0.0.1:9201/api/shared-memory/host-mode/subscribe
```

A successful response looks like:

```json
{
  "contextGraphId": "<curator-agent>/lj-A-1717000000",
  "subscribed": true,
  "alreadySubscribed": false,
  "hostingEnabled": true
}
```

Other documented response shapes:

- `{"subscribed": false, "alreadySubscribed": true, "hostingEnabled": true}`
  — the daemon was already subscribed to this CG (paths 1–3 already
  fired, or you called this twice). Safe; idempotent.
- `{"subscribed": false, "alreadySubscribed": false, "hostingEnabled": true, "memberMode": true}`
  — local node is already a **CG member** of this CG. Member-mode
  takes precedence; the daemon refuses to wire a second handler.
  This means you don't need host mode for this CG on this node —
  the member-mode handler already covers it.
- `{"subscribed": false, "alreadySubscribed": false, "hostingEnabled": false}`
  — node has no `swmHostModeStore`, i.e. host mode is disabled at
  config time. Not a core node, or `swmHostMode: false` in config.
- HTTP `400` — missing/blank `contextGraphId`.
- HTTP `501` — daemon build does not expose `enableSwmHostModeFor`.
- HTTP `500` — `enableSwmHostModeFor` threw. The body's `error` field
  carries the underlying message; the daemon log has the full trace.

## How to verify the subscribe took effect

After a successful POST:

1. The daemon log on the core should include
   `Host-mode subscribed CG=<id>` (or the persistence-queue equivalent).
2. `GET /api/shared-memory/host-mode/list` reports the CG (along with
   every other host-mode-subscribed CG on this daemon).
3. Within a few seconds, gossiped SWM envelopes for that CG should
   start showing up in the core's `swm-host-mode` substrate. With no
   curator currently writing, you won't see ingest until the next
   write — that's normal.
4. A member running `POST /api/shared-memory/catchup` against this core
   should now get a non-zero `totalInsertedTriples` (assuming the
   member holds the AEAD chain key — see SCENARIO D in
   `scripts/devnet-test-rfc38-late-joiner.sh`).

## How to undo it

```bash
curl -X POST \
  -H "Authorization: Bearer $AUTH" \
  -d '{ "contextGraphId": "<id>" }' \
  http://127.0.0.1:9201/api/shared-memory/host-mode/unsubscribe
```

Idempotent. Tears down the gossip handler, removes the persistence
record, and the periodic reconciler will NOT re-add it on the next
sweep (the unmark is persisted).

Note that if path 1, 2, or 3 still match for this CG (e.g. a chain
event re-fires because the CG was re-registered), the auto-subscribe
will resurrect host-mode for this CG. The manual unsubscribe is an
explicit "I don't want to host this right now"; it isn't a permanent
blocklist.

## Anti-patterns

- **Don't** loop the manual call as a substitute for the reconciler.
  The reconciler is what guarantees eventual consistency for CGs
  whose chain event was missed; replacing it with a polling script
  hides whatever bug is preventing the reconciler from converging.
- **Don't** call this on a CG you're also a member of. The daemon
  rejects with `memberMode: true`; if you got there by misreading
  the topology, you don't need host mode — your member handler is
  already authoritative.
- **Don't** wire it into MCP-tool calling patterns that an agent
  invokes automatically. Operator-only by design: an agent that
  reaches for host mode is bypassing the curator's authority over
  who hosts the curated CG. (The optional `dkg_request_hosting`
  MCP tool, where it ships, is a thin operator UI for this same
  endpoint — not an agent escalation path.)

## Related

- `packages/cli/src/daemon/routes/memory.ts:960-977` — endpoint
  implementation.
- `packages/agent/src/dkg-agent.ts:10371-…` — `enableSwmHostModeFor`,
  the agent-side handler the endpoint delegates to.
- `packages/agent/src/dkg-agent.ts:1737-1803` (chain-event),
  `1810-1838` (beacon), `9347-9376` (reconciler) — the three
  automatic paths this runbook supplements.
- `scripts/devnet-test-rfc38-late-joiner.sh` SCENARIO D — the
  end-to-end happy path this endpoint participates in.
- `docs/RFC38_LU6_TWO_LAPTOP_TESTNET_RUNBOOK.md` — testnet
  validation runbook that calls this endpoint as one of its
  validation steps.
