# Fixtures

Pre-generated EPCIS 2.0 documents from one synthesized Acme Bikes assembly trace.

## Contents

| File | Purpose |
|---|---|
| `source-raw/acme-bikes-line-w18.json` | The synthesized raw source — 7 cycle records on the assembly line. Committed because it's fully synthetic; ETL is reproducible from a clean clone. |
| `event-NN-<station>.json` | One EPCIS document per station event, in chronological order. Each document holds exactly one `ObjectEvent`. |
| `trace-7c4f8d2a-bike-line.json` | Manifest: trace ID, time range, stations visited, item IDs, plus per-event metadata (eventID, bizStep, disposition, action). |
| `source-snapshot.json` | Source basename + SHA-256 of the synthesized raw source used at ETL time. |

The Phase 6 allowList grant is demonstrated against a synthesized "shipping" event built in memory by `run.mjs` and written to `os.tmpdir()` per run — no committed file.

## Regenerate from source

The fixtures are generated from the committed synthesized source `source-raw/acme-bikes-line-w18.json`. To regenerate after editing the source:

```sh
node ../lib/etl.mjs

# or override
node ../lib/etl.mjs \
  --source ./source-raw/acme-bikes-line-w18.json \
  --trace-id 7c4f8d2a-9e3b-4a6d-b517-8f9e0a1b2c3d \
  --out ./

# or via env
BIKE_SOURCE=./source-raw/acme-bikes-line-w18.json node ../lib/etl.mjs
```

ETL is deterministic: same source + same trace ID → identical eventIDs. The seed is `trace_id|unit_id|ended` for the common case where one source record yields one EPCIS document; when a single source record splits into multiple status groups (e.g. mixed `Passed` / `Rejected` items in the same cycle), each sibling document's seed gains a `groupKey` segment (`trace_id|unit_id|ended|<status>`) so the siblings get distinct eventIDs and the publisher's duplicate-root validator can't reject the second one.

## Mapping rules

See `lib/epc-mapping.mjs` for the mapping logic.

- `items.<id>` → `epcList[i]` as `urn:acme:bike:item:<id>` (custom URN — Acme Bikes is a fictional manufacturer; URN segment is normalized by `safeUrnSegment` so spaces / slashes / non-ASCII in source data don't produce invalid IRIs)
- `process_name` → `bizLocation.id` and `readPoint.id` as `urn:acme:bike:station:<process_name>` (same `safeUrnSegment` normalization applies)
- `process_name` matching `inspection|test|inspecting` → CBV `inspecting`; otherwise CBV `assembling`
- `items.<id>.status`: `Passed` → CBV `in_progress`, `Rejected` → CBV `damaged`, `Skipped` → CBV `unknown`
- `action: ADD` only when EVERY item in the emitted status group is first-seen in the trace; mixed groups (some seen, some not) drop to `OBSERVE`. For the demo's uniform-status fixture each item appears in exactly one record per station, so the practical pattern is "doc 1: ADD, docs 2..N: OBSERVE".
- `eventID` derived from `urn:uuid:<v5(trace_id|unit_id|ended)>` — or `urn:uuid:<v5(trace_id|unit_id|ended|<groupKey>)>` when a single source record splits into multiple sibling EPCIS documents (see deterministic note above).
