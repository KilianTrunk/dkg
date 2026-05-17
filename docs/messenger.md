# Universal Messenger

> Status: shipping in `v10.0.0-rc.9`. Skeleton landed in PR-1 (rc.9 plan). Subsequent PRs flesh out per-protocol coverage; PR-13 is the final coherence pass.

The Universal Messenger is the reliability substrate every short
peer-to-peer DKG protocol travels through. It generalises the chat-
specific outbox + receiver-dedup work from rc.8 (PRs #533, #534, #536,
#537, #538) into a single layer that wraps `ProtocolRouter.send` and
gives every caller — chat, skill request, query, swm-sender-key,
private-access, join-request, storage-ack, verify-proposal — the same
delivery guarantees:

- **At-least-once delivery** with sender-side durable retry (survives
  daemon crash mid-retry).
- **Exactly-once application semantics** via receiver-side idempotency
  by `messageId`.
- **Stale-snapshot-safe retries** (the rc.9 #538 lesson, lifted into
  the generic substrate).
- **Caller-visible delivery state** — `{ delivered, queued, attempts,
  messageId }` so MCP / HTTP callers can surface "queued" vs "sent"
  to the operator.

This page is the architecture reference. Two siblings live alongside it:

- [`messenger-add-protocol.md`](./messenger-add-protocol.md) — recipe
  for migrating an existing protocol onto the Messenger, or adding a
  new short-message protocol.
- [`messenger-operator.md`](./messenger-operator.md) — how to read
  `/api/slo`, what `--relay-preferred` does, and how to debug a peer
  that "should be" reachable but isn't.

## Architecture

```
caller (chat, query, etc.)
  │
  ▼
Messenger.sendToPeer(peerId, protocol, payload, { messageId? })
  │  1. (sender-side) check `MessageIdempotencyStore` for direction='out':
  │       seen? → return cached response (re-issue path)
  │  2. wrap payload in `ReliableEnvelope { messageId, version, tsMs, payload }`
  │  3. ProtocolRouter.send (existing low-level wire I/O)
  │  4a. success → record `(peer, protocol, msgId, 'out')` in idempotency store
  │  4b. failure → enqueue in `ProtocolOutboxStore`; background tick + connect-flush retry
  ▼
ProtocolRouter.send  (unchanged; just wire I/O + path selection)
  │
  ▼
[ libp2p / circuit-relay / direct ]
  │
  ▼
ProtocolRouter receives
  │
  ▼
Messenger.register(protocol, handler)
  │  1. decode `ReliableEnvelope`
  │  2. check `MessageIdempotencyStore` for direction='in':
  │       seen + cached response → return cached response (no app handler call)
  │       seen + mark-only       → return RESPONSE_GONE
  │       not seen               → invoke handler(payload, peerId)
  │  3. record `(peer, protocol, msgId, 'in', responseBytes)`
  ▼
application handler (existing protocol-specific code)
```

The substrate is composed of:

1. **`ReliableEnvelope` proto** (`packages/core/src/proto/reliable-envelope.ts`)
   — uniform `{ messageId, version, tsMs, payload }` outer wrapper.
   The application payload (chat protobuf, JSON request, pipe-
   delimited frame) stays inside `payload` byte-identical.

2. **`MessageIdempotencyStore`** (interface in
   `packages/core/src/messenger-types.ts`; SQLite-backed in
   `packages/node-ui/src/db.ts`'s `SqliteMessageIdempotencyStore`) —
   keyed by `(peer, protocol, messageId, direction)`, with inline
   response cache up to 256 KiB and mark-only beyond.

3. **`ProtocolOutbox` + `ProtocolOutboxStore`**
   (`packages/core/src/protocol-outbox.ts`; SQLite-backed in
   `SqliteProtocolOutboxStore`) — durable send-side retry queue keyed
   by `(peer, protocol, messageId)`. Backoff ladder: 5s → 15s → 30s →
   60s → 5m → 30m → 2h, capped 24h.

4. **`Messenger`** class (`packages/agent/src/messenger.ts`) — wires
   the above together around `ProtocolRouter`. Provides `sendToPeer`
   + `register` as the only public surface every protocol needs. _PR-2._

## Wire format

Every message on `/dkg/10.0.1/*` is `ReliableEnvelope` encoded:

```protobuf
message ReliableEnvelope {
  string message_id = 1;     // UUID v4, Messenger-managed
  uint32 version = 2;        // 1 = current
  uint64 ts_ms = 3;          // sender wall-clock at send time
  bytes payload = 4;         // original protocol bytes (existing protobuf, JSON, etc.)
}
```

**Protocol prefix bump from `/dkg/10.0.0/*` → `/dkg/10.0.1/*`** is the
coarse-grained compatibility break that signals "envelope wrapper now
present"; the `version` field inside the envelope handles fine-grained
evolution within the prefix. Hard cutover — no negotiation logic, no
codepath that mixes wrapped + bare frames. Two nodes on different
prefixes simply don't talk on the migrated protocol until both reach
rc.9.

## V12 schema (PR-1)

The SQLite-backed stores live in `DashboardDB` (`packages/node-ui/src/db.ts`).
V12 migration is pure additive — chat continues to write to
`chat_messages.message_id` until PR-3 cuts over.

```sql
CREATE TABLE message_idempotency (
  peer_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  response_blob BLOB,            -- inline cache up to 256 KiB; NULL = mark-only
  response_size INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  PRIMARY KEY (peer_id, protocol, message_id, direction)
);
CREATE INDEX idx_idem_ts ON message_idempotency(ts);

CREATE TABLE protocol_outbox (
  peer_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload BLOB NOT NULL,         -- envelope-wrapped wire bytes (not raw app payload)
  attempts INTEGER NOT NULL DEFAULT 0,
  first_failure_at INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (peer_id, protocol, message_id)
);
CREATE INDEX idx_outbox_next_attempt ON protocol_outbox(next_attempt_at);
```

Periodic prune (24h TTL) runs in `DashboardDB.prune()`.

## Response caching policy

Fixed at 256 KiB inline cache. No per-protocol or per-call knob.

| Response size                       | Behaviour                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `<=` 256 KiB                        | Stored inline in `response_blob`. Duplicate receive returns cached bytes.                |
| `>` 256 KiB                         | Stored mark-only (`response_blob = NULL`, `response_size` set). Duplicate → RESPONSE_GONE. |

Callers on the receive of `RESPONSE_GONE` decide whether to re-issue
with a fresh `messageId` (acceptable for `/query-remote` since SPARQL
is idempotent at the app layer) or surface a terminal error.

## Per-protocol coverage

> Filled in as protocols migrate. Empty rows are placeholders for the
> milestone they land in.

| Protocol                        | Migrated in | parallelPaths | Notes                                                                              |
| ------------------------------- | ----------- | ------------- | ---------------------------------------------------------------------------------- |
| `/dkg/10.0.1/message` (chat)    | PR-3        | 2 (PR-4)      | Pilot. Wire-format break replaces `chat_messages.message_id` index uniqueness.     |
| `/dkg/10.0.1/skill_request`     | PR-3        | 1             | Migrated alongside chat (shares `agent.sendMessage` path).                         |
| `/dkg/10.0.1/swm-sender-key`    | PR-8        | 1             | Batch with `/private-access`.                                                      |
| `/dkg/10.0.1/private-access`    | PR-8        | 1             | Batch with `/swm-sender-key`.                                                      |
| `/dkg/10.0.1/query-remote`      | PR-9        | 1             | First caller exercising RESPONSE_GONE retry path.                                  |
| `/dkg/10.0.1/join-request`      | PR-10       | 1             | Removes `JoinApprovalRetryQueue` in favour of generic outbox.                      |
| `/dkg/10.0.1/storage-ack`       | PR-11 ✅     | **1**         | App-level quorum (`ACKCollector`) untouched; transport sendP2P → `messenger.sendReliable`. `parallelPaths=1` (transport-side; app already fans out to N core peers — `parallelPaths>1` would 9x the wire load for no SLO win). Substrate `queued` returns surface as a per-peer throw, picked up by `ACKCollector`'s `MAX_RETRIES=3` loop. |
| `/dkg/10.0.1/verify-proposal`   | PR-11 ✅     | **1**         | Same shape + same rationale as `/storage-ack` — app-level quorum (`VerifyCollector`) untouched; only the transport swaps. `parallelPaths=1` for the same amplification reason. |

## Recovery primitives

> Documented as they ship. Linked PRs are in the rc.9 plan.

- **Outbox-driven retry** (rc.8 carry-over) — backoff ladder above.
- **Opportunistic-flush on `connection:open`** — when a peer
  reconnects, drain its `pendingFor(peer)` queue immediately rather
  than wait for backoff. Stale-snapshot-safe via `hasEntry` guard
  (rc.9 #538).
- **`parallelPaths`** _(PR-4)_ — `Messenger.sendToPeer` can race N
  candidate paths; receiver dedup absorbs duplicates.
- **DHT walk on stall** _(PR-5)_ — outbox entry with ≥ 5 attempts of
  "no valid addresses for peer" triggers a time-bounded, rate-limited
  `libp2p.peerRouting.findPeer()`.
- **Gossip peer-hints** _(PR-6, conditional)_ — only ships if Gate B
  shows DHT walk insufficient.

## SLO

Defined fully in [`messenger-operator.md`](./messenger-operator.md).
TL;DR: per-message latency clock starts at `Messenger.sendToPeer`
invocation and ends at the promise resolving `{ delivered: true }`
(includes queue + retries; this is the operator-visible "I clicked
send → it arrived" time). Target: ≥ 99%/15s on chat/skill/query,
≥ 99.5% on the rest. Per-protocol histograms via PR-12's `/api/slo`
endpoint (localhost-only by default).

## Open questions / future work

- Multi-recipient fan-out (broadcast to N peers with single
  `messageId`) — out of scope for rc.9; explored in a follow-up RFC.
- Cross-process idempotency (multiple daemons sharing the same store)
  — not needed today (one daemon per node) but the schema accommodates it.
- Operator-relay infrastructure — code-side in PR-7; actual relay
  provisioning is an out-of-band ops track.
