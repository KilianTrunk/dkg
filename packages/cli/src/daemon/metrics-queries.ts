// Canonical SPARQL for the daemon's metrics reads.
//
// Extracted so cross-package consumers — currently the
// `bench/store-read-latency` benchmark (regression guard for #939) — can
// measure the EXACT production read path instead of a duplicated copy that
// could silently drift.

/**
 * Total triples across the default graph and all named graphs. Run on the 30s
 * metrics-collector cadence via `getTotalTriples` (see the metrics source in
 * `lifecycle.ts`). It is the heaviest read the collector issues and the one the
 * store-read-latency benchmark tracks.
 */
export const GET_TOTAL_TRIPLES_SPARQL =
  'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }';
