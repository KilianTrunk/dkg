# Fix SWM Large Payload Storage Amplification

## Summary

This change fixes Shared Working Memory large-payload storage amplification.
Before this fix, each public SWM payload was stored twice per node:

1. Once as normal RDF quads in the SWM data graph.
2. Again as a JSON-stringified RDF literal in SWM metadata through
   `dkg:publicStagedQuads`.

For large replicated writes this doubled the effective Oxigraph payload and
pushed the WASM store into memory failures. In the reproduced benchmark, the
duplicated path failed around `202.5 MiB/store` with:

```text
RuntimeError: unreachable
Store.load(...)
```

After that failure, later queries could also fail with:

```text
table index is out of bounds
```

The fix has two layers:

1. Full-payload metadata snapshots are replaced by compact immutable
   share-operation metadata and per-root public quad fingerprints.
2. Large public SWM literal object terms are externalized into
   content-addressed blob files, leaving only a small placeholder literal in
   Oxigraph.

New SWM writes no longer serialize public payloads into
`dkg:publicStagedQuads`, and persistent nodes no longer ask Oxigraph WASM to
hold large literal bytes directly. Legacy metadata records that already contain
`dkg:publicStagedQuads` remain readable.

## Problem

The old SWM share path made metadata carry the entire public payload:

```mermaid
flowchart TD
  A["Client writes public SWM quads"] --> B["Store quads in SWM graph"]
  A --> C["Serialize same quads as JSON"]
  C --> D["Store JSON string as dkg:publicStagedQuads literal"]
  B --> E["Oxigraph stores payload copy 1"]
  D --> F["Oxigraph stores payload copy 2"]
  E --> G["Large payload memory pressure"]
  F --> G
```

That metadata snapshot was useful for later lift/share resolution, but it made
the storage model scale with approximately `2x payload size` per node. The
failure was reproduced without private mode and without Sender Key encryption,
so the root cause was public SWM metadata amplification.

## New Model

New SWM writes store compact share-operation metadata:

- context graph id
- optional subgraph name
- share operation id
- root entities
- publisher peer id
- published timestamp
- public quad digest and count for each root

The public payload is not serialized into metadata. Resolution reconstructs and
validates the operation payload by reading the current SWM graph for the
operation roots, then comparing the hydrated quads to the stored digest/count.

```mermaid
flowchart TD
  A["Client writes public SWM quads"] --> B["Store quads in SWM graph"]
  A --> C["Generate compact metadata"]
  B --> L{"Large SWM literal?"}
  L -->|No| M["Store RDF term inline"]
  L -->|Yes| N["Write exact RDF object term to literal-blobs/sha256"]
  N --> O["Store externalLiteralRef placeholder in Oxigraph"]
  C --> D["dkg:shareOperationId"]
  C --> E["dkg:rootEntity"]
  C --> F["dkg:publisherPeerId"]
  C --> G["dkg:publishedAt"]
  C --> H["dkg:contextGraphId"]
  C --> I["optional dkg:subGraphName"]
  C --> P["dkg:publicQuadsDigest + dkg:publicQuadsCount"]
  M --> J["Small or normal RDF terms in Oxigraph"]
  O --> J
  D --> K["Small operation reference metadata"]
  E --> K
  F --> K
  G --> K
  H --> K
  I --> K
  P --> K
```

## Large Literal Blob Storage

Local Oxigraph-backed agent stores now enable large SWM literal storage by
default when `dataDir` is configured. The default settings are:

```ts
largeLiteralStorage: {
  enabled: true,
  thresholdBytes: 65536,
  directory: "<dataDir>/literal-blobs",
}
```

Only RDF literal objects written to graphs ending in `/_shared_memory` are
eligible. Small literals, IRIs, blank nodes, non-SWM graphs, Verified Memory,
private encrypted staging, and file import blobs stay unchanged.

For each large SWM literal, the wrapper computes `sha256` over the exact
serialized RDF object term string and writes that string to:

```text
<dataDir>/literal-blobs/<sha256>
```

Oxigraph stores this placeholder instead of the full literal bytes:

```text
"sha256:<hex>"^^<http://dkg.io/ontology/externalLiteralRef>
```

Queries and lift resolution hydrate placeholders after Oxigraph returns
bindings or constructed quads, so normal callers receive the original RDF
literal term. Exact large-literal constants in simple `SELECT`, `ASK`, and
equality-filter queries are also translated to the placeholder form before
querying. Full SPARQL value semantics for functions over externalized literal
values are intentionally not promised; those expressions still execute inside
Oxigraph against the stored placeholder.

## Write Path

The SWM write path still accepts and gossips normal public RDF quads. The
storage wrapper externalizes large literal bytes at the local persistence
boundary, and compact metadata records only operation provenance plus
digest/count fingerprints.

```mermaid
sequenceDiagram
  participant Client
  participant API as DKG API
  participant Publisher as DKGPublisher
  participant Store as Triple Store
  participant Gossip as SWM Gossip

  Client->>API: POST /api/shared-memory/write
  API->>Publisher: share(contextGraphId, quads, subGraphName?)
  Publisher->>Store: store public quads in SWM graph
  Store->>Store: externalize large SWM literals to literal-blobs
  Publisher->>Store: store compact share metadata
  Publisher->>Gossip: broadcast SWM operation
  Gossip-->>API: operation propagated to peers
  API-->>Client: shareOperationId
```

The important behavior change is this:

```text
New writes no longer emit:
  <share-operation> dkg:publicStagedQuads "<serialized full payload>"
```

Instead they emit compact metadata that points to roots already present in the
SWM data graph and records immutable digest/count fingerprints for stale-write
detection.

## Resolution Path

Lift/share resolution now resolves the public payload from the graph itself
when compact metadata is present.

```mermaid
flowchart TD
  A["Lift request contains shareOperationId"] --> B["Read share operation metadata"]
  B --> C{"Legacy dkg:publicStagedQuads present?"}
  C -->|Yes| D["Parse legacy serialized quad snapshot"]
  C -->|No| E["Read root entities from metadata"]
  E --> F["Query current SWM graph for those roots"]
  F --> I["Hydrate externalLiteralRef placeholders from blobs"]
  I --> J["Compare hydrated digest/count with metadata"]
  J --> G["Return public quads for operation"]
  D --> G
  G --> H["Build lift request payload"]
```

For compact metadata, the resolver validates the operation roots and then reads
hydrated public quads from the current SWM graph. If the current root slice no
longer matches the stored digest/count, resolution fails instead of silently
publishing a mismatched public/private asset.

## Legacy Compatibility

Existing stores may already contain `dkg:publicStagedQuads`. Those records still
work. The compatibility rule is:

```mermaid
flowchart LR
  A["Existing metadata record"] --> B{"Has dkg:publicStagedQuads?"}
  B -->|Yes| C["Use legacy serialized snapshot"]
  B -->|No| D["Use compact root metadata"]
  C --> E["Resolved public quads"]
  D --> E
```

This means the fix is forward-looking for new writes, while old metadata remains
readable and does not need a migration before use.

## Benchmark

This PR adds a reusable live benchmark:

```bash
pnpm bench:swm-large-payload -- \
  --ports 19101,19102,19103,19104,19105 \
  --payload-mib-per-node 204.8 \
  --chunk-mib 0.5 \
  --write-concurrency 5 \
  --output bench/results/swm-large-payload-1gib.json
```

The benchmark:

1. Writes large public SWM literals through each configured node.
2. Polls every node until all benchmark payloads are queryable.
3. Checks per-run metadata for `shareOperationId`, `rootEntity`,
   `publisherPeerId`, and `publishedAt`.
4. Verifies `dkg:publicStagedQuads` did not grow.
5. Selects one sample payload literal per node to prove hydration returns the
   original payload bytes.
6. Optionally scans appended daemon logs for known Oxigraph and GossipSub
   failure signatures.

```mermaid
sequenceDiagram
  participant Bench as Benchmark
  participant N1 as Node 1
  participant N2 as Node 2
  participant N3 as Node 3
  participant N4 as Node 4
  participant N5 as Node 5

  Bench->>N1: write 204.8 MiB in chunks
  Bench->>N2: write 204.8 MiB in chunks
  Bench->>N3: write 204.8 MiB in chunks
  Bench->>N4: write 204.8 MiB in chunks
  Bench->>N5: write 204.8 MiB in chunks

  N1-->>N2: gossip SWM operations
  N1-->>N3: gossip SWM operations
  N2-->>N4: gossip SWM operations
  N3-->>N5: gossip SWM operations
  N4-->>N1: gossip SWM operations
  N5-->>N2: gossip SWM operations

  loop Until every node converges
    Bench->>N1: count benchmark payloads
    Bench->>N2: count benchmark payloads
    Bench->>N3: count benchmark payloads
    Bench->>N4: count benchmark payloads
    Bench->>N5: count benchmark payloads
  end

  Bench->>N1: verify compact metadata
  Bench->>N2: verify compact metadata
  Bench->>N3: verify compact metadata
  Bench->>N4: verify compact metadata
  Bench->>N5: verify compact metadata
  Bench->>N1: select one hydrated sample literal
  Bench->>N2: select one hydrated sample literal
  Bench->>N3: select one hydrated sample literal
  Bench->>N4: select one hydrated sample literal
  Bench->>N5: select one hydrated sample literal
```

The 1 GiB target case uses `5 x 204.8 MiB = 1024 MiB` total. Acceptance is:

```text
payload quads:        all benchmark chunks on every node
dkg:publicStagedQuads: 0 per node
shareOperationIds:    one per benchmark write
rootEntities:         one per benchmark write
sample literal bytes: expected chunk payload size on every node
```

No Oxigraph failure signatures were observed:

```text
RuntimeError: unreachable
table index is out of bounds
```

## Files Changed

- `packages/publisher/src/workspace-resolution.ts`
  - Stops writing new full-payload `dkg:publicStagedQuads` metadata snapshots.
  - Resolves compact share operations by reading root-scoped public quads from
    the SWM graph.
  - Keeps legacy snapshot reads for existing metadata.

- `packages/publisher/src/metadata.ts`
  - Extends share metadata with compact operation fields.
  - Emits `dkg:publishedAt`, `dkg:shareOperationId`, `dkg:rootEntity`,
    `dkg:publisherPeerId`, `dkg:contextGraphId`, and optional
    `dkg:subGraphName`.

- `packages/publisher/src/dkg-publisher.ts`
  - Routes SWM share metadata generation through the compact metadata helper.

- `packages/publisher/src/workspace-handler.ts`
  - Applies the same compact metadata model for received SWM operations.

- `packages/publisher/test/async-lift-workspace.test.ts`
  - Covers compact share-operation resolution.
  - Covers legacy `dkg:publicStagedQuads` compatibility.
  - Covers large literal writes without metadata payload duplication.
  - Covers compact digest/count resolution over hydrated external SWM literals.

- `packages/publisher/test/metadata.test.ts`
  - Covers the new compact share metadata shape.

- `packages/storage/src/shared-memory-literal-blob-store.ts`
  - Adds the content-addressed large SWM literal blob wrapper.
  - Hydrates `SELECT` bindings and `CONSTRUCT` quads back to the original RDF
    literal term.
  - Translates deletes and exact large-literal query constants to the
    placeholder representation.

- `packages/storage/src/triple-store.ts`
  - Adds the `largeLiteralStorage` configuration surface.

- `packages/storage/test/external-literal-store.test.ts`
  - Covers externalization, hydration, exact literal matching, deletes,
    corrupt/missing blob failures, and reopen-from-disk behavior.

- `packages/agent/src/dkg-agent.ts`
  - Enables large SWM literal storage by default for local Oxigraph-backed
    `DKGAgent.create({ dataDir })` stores.

- `packages/agent/test/large-literal-storage.test.ts`
  - Covers the default persistent agent store wiring.

- `packages/cli/scripts/swm-large-payload-benchmark.cjs`
  - Adds the reusable live multi-node SWM payload benchmark.
  - Uses hydrated sample literal selection instead of `STRLEN(STR(?o))`, so
    count queries remain cheap and sample checks exercise blob hydration.

- `packages/cli/test/swm-large-payload-benchmark.test.ts`
  - Covers benchmark argument parsing, chunk planning, and generated payload
    sizing.

- `packages/cli/README.md`
  - Documents the benchmark and the 5-node 500 MiB regression command.

## Validation

Focused validation run for this change:

```bash
pnpm --filter @origintrail-official/dkg exec vitest run test/swm-large-payload-benchmark.test.ts
pnpm --filter @origintrail-official/dkg-storage exec vitest run test/storage.test.ts test/external-literal-store.test.ts
pnpm --filter @origintrail-official/dkg-publisher exec vitest run test/async-lift-workspace.test.ts
pnpm --filter @origintrail-official/dkg-agent exec vitest run test/large-literal-storage.test.ts
```

Additional validation performed during the fix:

```bash
git diff --check
```

Live benchmark validation:

```bash
pnpm bench:swm-large-payload -- \
  --ports 19101,19102,19103,19104,19105 \
  --payload-mib-per-node 204.8 \
  --chunk-mib 0.5 \
  --write-concurrency 5 \
  --auth-token <token> \
  --output bench/results/swm-large-payload-1gib.json
```

The live 1 GiB run should verify that each node converges, hydrated sample
literals match the expected chunk size, `dkg:publicStagedQuads` remains zero,
and the logs contain no `RuntimeError: unreachable` or
`table index is out of bounds`.
