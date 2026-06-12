# RFC: Per-KA metadata trim + indexed graph addressing

**Status:** Proposed — Phases 0–1 (and approved easy Phase-2 items) implemented in the accompanying PR; aggressive options are explicit decision points below.
**Motivation:** scalability. Publishing **one 1-triple KA leaves ~134 resident quads** in the local store (live-measured, rc.17, Base Sepolia). ~97% is publish bookkeeping, ~30 quads are repeated copies of five values. Combined with hot-path SPARQL that scans graph names, this is the mechanism behind the rc.17 idle-node CPU saturation (`oxigraph-server` at 200–360%): store volume feeds RocksDB compaction *and* makes every recurring full-store reconciler query more expensive. The storage adapter itself documents the second half: *"the `SELECT DISTINCT ?g` quad-store scan — **the dominant idle-node CPU cost**"* (`packages/storage/src/adapters/sparql-http.ts:336`).

## Ground truth (live dump, KA #122, `megagiga` CG)

One `dkg shared-memory publish` of 1 user triple writes, resident:

| Graph | Quads | Content |
|---|---|---|
| `{cg}/_meta` | 86 | on-chain mirror (UAL node, 21) · token node `UAL/1` (7) · AuthorshipProof bnode (4) · author seal + chain receipt (15) · lifecycle URN (16) · 2 PROV events (17) · publication node (5) · orphan WM marker (1) |
| `{cg}/context/{id}/_meta` | 29 | byte-identical copy of UAL + UAL/1 rows (+1 dangling bnode) |
| `{cg}/_shared_memory_meta` | 15 | ShareTransition (5) + public-stage snapshot (10) |
| `{cg}/_verifiable_memory/{addr}/{n}` | 2 | **the user triple** + trust stamp |
| `{cg}/context/{id}` | 2 | queryable copy of the user triple |

Redundancy: merkle root ×6, entity URI ×10 (`entity`+`rootEntity` pairs on 5 subjects), author address ×8, on-chain id ×3 (+ as the UAL's last URI segment), tx/block ×2 each.

Method: every predicate audited for **writers and readers** (grep over `packages/*/src`, `node-ui`, `mcp-dkg`; both `${NS}pred` template and inline-IRI forms). Verdicts: **DROP** = zero readers repo-wide; **MIGRATE** = readers exist but trivially re-pointable; **KEEP** = load-bearing.

## Part 1 — metadata trim

### Phase 0: dead code (implemented)

- `generateAssertionPublishedMetadata` (`packages/publisher/src/metadata.ts:1465-1496`) and its gate (`packages/publisher/src/dkg-publisher.ts:1550-1578`) — the gate joins `dkg:agent`, a predicate the lifecycle writer never emits (it writes `prov:wasAttributedTo`), so it **never fires**: 0 `dkg:AssertionPublished` instances in a live store with 113 assertions. The SWM→VM flip is done imperatively (`dkg-agent-publish.ts:3067-3127`).
- The orphaned history `OPTIONAL { … dkg:kcUal … }` read (`packages/agent/src/dkg-agent.ts:1914`).
- The dangling `authoredBy` blank node in the partition copy (no outgoing triples in any graph).

### Phase 1: zero-reader drops (implemented) — ≈ −24 quads/KA

| Dropped triple | Was written at | Why safe |
|---|---|---|
| `dkg:kaCount` | metadata.ts:138 | zero readers; wire/chain carries its own count. Post-rc.17 one publish = 1 KA, so it is also a constant `1` — a KC-era remnant |
| `dkg:publishedAt` (KC row) | metadata.ts:161-166 | zero readers in `_meta` (the consumed `publishedAt` is the SWM-meta WorkspaceOperation row) |
| `dkg:blockTimestamp` | metadata.ts:332-337 | zero readers |
| `dkg:publisherAddress` | metadata.ts:338 | zero readers (code uses on-chain/UAL-derived address) |
| `dkg:chainId` | metadata.ts:340 | zero readers (code reads `this.chain.chainId`) |
| `dkg:tokenId` ×2 (KC + token rows) | metadata.ts:201-203, 231 | zero readers (token order parsed from `<ual>/<n>` URI, metadata.ts:973-979) |
| `dkg:publicTripleCount` ×2 | metadata.ts:199, 232-237 | zero readers (recomputed from payload at verify time) |
| `dkg:authoredBy → bnode` + AuthorshipProof block (5) | metadata.ts:426-436 via dkg-publisher.ts:2794-2809 | zero code readers; on-chain `KnowledgeBatch.authorAddress` is canonical per the writer's own comment (metadata.ts:79-81) |
| Publication node + `dkg:publication` edge (6) | metadata.ts:266-278, 277 | zero pattern readers; only the backfill repair tool CONSTRUCT-copies it (one-line tool edit included) |
| lifecycle URN: `a prov:Entity`, `a dkg:Assertion`, `dkg:contextGraph`, `prov:wasGeneratedBy` (4) | metadata.ts:1333-1337 | readers: none (the type row's sole reader was the Phase-0 dead gate; history joins event-side `prov:generated/used`) |
| `dkg:blockNumber` | metadata.ts:331 | sole reader is an `OPTIONAL` clause (endorse provenance, dkg-agent-endorse.ts:893) — binds nothing, degrades gracefully; derivable from `transactionHash` via RPC on demand |

The `context/{id}/_meta` partition copy is a CONSTRUCT-copy of the KC/token rows, so it **shrinks automatically** by every quad dropped above.

### Phase 2: dedupe with small reader migrations (this PR implements the ⊕ items)

| Item | Saves | Migration |
|---|---|---|
| ⊕ `rdf:type dkg:KnowledgeCollection` + aggregate `dkg:KnowledgeAsset` type rows | −2 | rewrite the two status counters (`packages/cli/src/daemon/lifecycle.ts:1861,1867`) to count `dkg:status` / `dkg:partOf` subjects |
| `entity`+`rootEntity` dual pairs on 5 subjects → **one `rootEntity` on the token row** | −8 | dual-read shim already exists (`packages/core/src/entity-predicate.ts:39`); seal pair stays (signed material) |
| `wm/swm/vmCurrentAssertion` written only on divergence (same hash ×3 when no draft) | −2 | history + idempotency readers `COALESCE` to `vm` |
| `fromLayer`/`toLayer` on events (100% determined by event class) | −4 | derive in the history query (`dkg-agent.ts:1911-1912`) |
| `prov:wasAssociatedWith` on events | −2 | make node-ui feed pattern OPTIONAL; agent recoverable from URN `wasAttributedTo` |
| partition copy → documented minimal shape (`restateKaPartition`, metadata.ts:843-874) | −21 | RS prover needs only `partOf` + `rootEntity` + `batchId` (+`privateMerkleRoot`) — ka-extractor.ts:184-202 |
| `publishedAtKaId` (third copy of the on-chain id) | −1 | node-ui receipt reads the UAL-row id instead |
| `publicSnapshotRef` (byte-identical to `publicQuadsDigest`) | −1 | collapse to one field |
| orphan WM `memoryLayer` marker cleanup at VM flip | −1 | add delete to the imperative flip |

**Identity columns after dedupe:** the UAL-row on-chain id is the *queryable index* (rename `dkg:batchId` → `dkg:onChainId` only at the next deliberate ontology bump); the seal's `reservedKaId` survives untouched — it is OT-RFC-43 §F2 **author-signed material**, not a redundant copy.

### Phase 3: aggressive options (decision points — NOT in this PR)

1. **Collapse `UAL` + `UAL/1` into one node** (−7, kills `dkg:partOf`). Justified iff "1 publish = 1 KA = 1 UAL" is a post-rc.17 invariant. Requires migrating ~6 readers (resolveKA, access-handler, RS prover, endorse, cg-registry, sync) from the token row to the single node, plus a read-both window for stores written by older nodes.
2. **Merge the lifecycle URN into the seal subject** (−5): one assertion = one node. Touches sync replication scope and history.
3. **PROV events behind `metadata.provenanceEvents` config** (−17 when off): "lite mode" for high-throughput publishers / core nodes; history API returns empty for disabled ranges.
4. **Drop ShareTransition** (−5): migrate the node-ui on-chain-receipt hop (`useEntityOnChainReceipt.ts:141-147`).
5. **Partition copy → zero locally** (−7 beyond minimal shape): RS prover reads `_meta` on the publisher node; sync ships the minimal shape to replicas only.

**Quad budget:** 134 → ~99 (Phase 1) → ~75 (Phase 2) → **~45–50 (Phase 3), ~40 in lite mode**. No consensus (merkle/seal/status), resolution (rootEntity/contextGraph/kaId/reservedUal), access (accessPolicy/publisherPeerId/wasAttributedTo), sync (memoryLayer/assertionGraph/prov:generated), or trust (trustLevel) path is touched in any phase.

## Part 2 — query patterns (the other half of the saturation)

Trimming quads lowers the water level; these stop the daemon from boiling the ocean per tick. Inventory of unindexable hot-path patterns (all are full scans on any SPARQL engine — Blazegraph included):

| Pattern | Sites (non-exhaustive) | Runs |
|---|---|---|
| `FILTER(STRSTARTS(STR(?g), …))` graph-name surgery | gossip-publish-handler.ts:252 (per gossip message); dkg-agent-endorse.ts:799; profile-manager.ts:79; ccl-fact-resolution.ts:72; dkg-agent-cg-resolve.ts:430-432 | per message / per request |
| `STR(?g) = CONCAT(…)` boundary filters | sync/responder/sync-handler.ts:147-239 | per sync request served |
| `SELECT DISTINCT ?g` full enumeration | storage adapters (oxigraph.ts:268, blazegraph.ts:178, sparql-http.ts:387) | host-mode sweeps; cache exists but write-heavy sync invalidates it continuously |
| per-CG full sweeps | syncReconciler every 5 min → `canUseSharedMemoryForContextGraph` per known CG (dkg-agent-lifecycle.ts:2070, 2837); host-mode/VM/warm-core timers | every tick, cost grows with store |

### Proposal A — graph registry (one quad per graph kills every name scan)

At graph creation, write into one well-known graph (`did:dkg:registry`):

```
<graphUri> dkg:graphKind  "vm" | "swm" | "wm" | "meta" | "data" ;
           dkg:ofContextGraph <cgUri> .
```

Every "all VM graphs of CG X" becomes an indexed lookup + direct `GRAPH <g>` access. Precedent already in the codebase: `dkg:assertionGraph` is exactly this pointer for per-KA VM graphs and is already used by history and import — the migration is "use the pointer everywhere name-matching is used today." `SELECT DISTINCT ?g` enumeration is replaced by reading the registry. Registry writes are tiny, append-mostly, and deleted with their graph.

### Proposal B — event-driven reconcilers (dirty sets, not sweeps)

The 5-min reconcilers re-derive the world from the store every tick. Replace with dirty-set tracking: subscription/`_meta` writes enqueue the affected CG; ticks process the queue and a slow background full-verify pass (e.g. hourly) catches drift. Cost becomes O(changes), not O(store).

### Proposal C — keep per-KA graphs

The graph-per-KA design itself is sound (a named graph is just the 4th term of a quad; no per-graph cost). With A+B in place there is no reason to restructure the data layout.

## Compatibility

- All trimmed graphs are **node-local** (`_meta`, partition, SWM-meta) — no wire-format or consensus change. Cross-version interop: nodes that sync rows written by older versions still read them (drops are write-side); the `entity`/`rootEntity` dual-read shim covers the dedupe.
- The author **seal block is untouched in every phase** — it is the signed mint authorization (`parseAssertionSealQuads` → mint args, dkg-agent-publish.ts:2850).
- Bug fixed in passing: `dkg:publisherPeerId` stores the literal `"unknown"` on the KC row (real peer id only lands in the SWM snapshot row).

## Verification approach

Per-predicate reader audit (multi-agent, grep both URI forms over all packages) + live-store census cross-check (e.g. `rdf:type` counts: `AssertionPublished` = 0 confirmed the dead writer). The PR includes: writer-side removals, the named reader migrations, updated test fixtures, and a regression grep proving no dropped predicate retains a reader.
