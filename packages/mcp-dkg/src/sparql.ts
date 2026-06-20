/**
 * Tiny helpers shared across tool implementations:
 *   - SPARQL literal escaping (copy of the core helper so this package
 *     stays dependency-free beyond the MCP SDK).
 *   - Common prefix map used everywhere in the V10 ontology.
 *   - Markdown renderers for SPARQL bindings.
 */
import type { SparqlBinding } from './client.js';
import { bindingValue } from './client.js';

// Re-export so tool code can pull everything it needs from one module.
export { bindingValue } from './client.js';

export const NS = {
  rdf:       'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs:      'http://www.w3.org/2000/01/rdf-schema#',
  schema:    'http://schema.org/',
  dcterms:   'http://purl.org/dc/terms/',
  prov:      'http://www.w3.org/ns/prov#',
  code:      'http://dkg.io/ontology/code/',
  github:    'http://dkg.io/ontology/github/',
  decisions: 'http://dkg.io/ontology/decisions/',
  tasks:     'http://dkg.io/ontology/tasks/',
  profile:   'http://dkg.io/ontology/profile/',
  agent:     'http://dkg.io/ontology/agent/',
  chat:      'http://dkg.io/ontology/chat/',
} as const;

/** All namespace prefixes, SPARQL-syntax. */
export const PREFIXES = Object.entries(NS)
  .map(([p, iri]) => `PREFIX ${p}: <${iri}>`)
  .join('\n');

/** Strip bracket wrappers, known namespace prefixes, and datatype suffixes. */
export function prettyTerm(raw: string): string {
  if (!raw) return '';
  let v = raw;
  if (v.startsWith('<') && v.endsWith('>')) v = v.slice(1, -1);
  // Typed literal → just the value
  const typed = v.match(/^"(.*)"\^\^<.+>$/s);
  if (typed) return typed[1];
  // Lang-tagged literal
  const langged = v.match(/^"(.*)"@[a-zA-Z0-9-]+$/s);
  if (langged) return langged[1];
  // Plain quoted literal
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  // Shorten well-known namespaces
  for (const [prefix, iri] of Object.entries(NS)) {
    if (v.startsWith(iri)) return `${prefix}:${v.slice(iri.length)}`;
  }
  return v;
}

export function escapeSparqlLiteral(s: string): string {
  // Defensive: strip null bytes BEFORE other escapes. SPARQL engines
  // (oxigraph et al.) reject null bytes outright today, so this is
  // pure hardening — guards against a future engine swap or any
  // truncate-at-null-byte parsing path that would silently change
  // query semantics. Pre-other-escapes ordering means a literal
  // backslash followed by null collapses to backslash only, not a
  // doubled backslash + dropped null.
  return s
    .replace(/\0/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * A verifiable source handle parsed from a result row's named graph. The raw
 * `sourceGraph` is always set; for the uniform per-KA layout
 * `did:dkg:context-graph:{cg}[/{sub}]/{_layer}/{addr}/{number}` the remaining
 * fields decode the on-chain UAL identity `(author, kaNumber)` a consumer
 * cites/verifies against. For any other content graph only `sourceGraph` is set.
 */
export interface EntitySource {
  sourceGraph: string;
  contextGraphId?: string;
  memoryLayer?: 'working-memory' | 'shared-working-memory' | 'verifiable-memory';
  author?: string;
  kaNumber?: string;
}

const LAYER_SLUG_TO_VIEW: Record<string, EntitySource['memoryLayer']> = {
  _working_memory: 'working-memory',
  _shared_memory: 'shared-working-memory',
  _verifiable_memory: 'verifiable-memory',
};

/** Parse a source named-graph URI into a verifiable handle. */
export function parseEntitySource(sourceGraph: string): EntitySource {
  const src: EntitySource = { sourceGraph };
  const m = sourceGraph.match(
    /^did:dkg:context-graph:(.+)\/(_working_memory|_shared_memory|_verifiable_memory)\/([^/]+)\/([^/]+)$/,
  );
  if (m) {
    src.contextGraphId = m[1];
    src.memoryLayer = LAYER_SLUG_TO_VIEW[m[2]];
    src.author = m[3];
    src.kaNumber = m[4];
  }
  return src;
}

/** Short citation label: `KA <author>/<kaNumber>` for a per-KA source, else the graph. */
export function sourceLabel(s: EntitySource): string {
  return s.author && s.kaNumber ? `KA \`${s.author}/${s.kaNumber}\`` : `\`${s.sourceGraph}\``;
}

/** Markdown table from SPARQL bindings, with pretty-printed terms. */
export function bindingsToTable(bindings: SparqlBinding[], columns?: string[]): string {
  if (!bindings.length) return '(no results)';
  const cols = columns ?? Object.keys(bindings[0]);
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const rows = bindings.map((row) =>
    '| ' + cols.map((c) => prettyTerm(bindingValue(row[c]))).join(' | ') + ' |',
  );
  return [header, sep, ...rows].join('\n');
}

/** Multi-line markdown summary per binding — better than a wide table for
 *  entities with long property lists. */
export function bindingsToParagraphs(bindings: SparqlBinding[]): string {
  if (!bindings.length) return '(no results)';
  return bindings
    .map((row, i) => {
      const lines = Object.entries(row).map(
        ([k, v]) => `  - **${k}**: ${prettyTerm(bindingValue(v))}`,
      );
      return `### ${i + 1}.\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

