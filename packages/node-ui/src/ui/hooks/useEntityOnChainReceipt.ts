/**
 * useEntityOnChainReceipt — resolves the REAL on-chain identity of a single
 * graph entity (UAL, transaction hash, block number, packed KA id, author).
 *
 * Unlike `useVerifiedEntityIdentity` (which surfaces the *synthetic*
 * WorkspaceOperation op-id as a UAL placeholder), this hook reads the genuine
 * blockchain receipt the publisher persists at publish time:
 *
 *   • `buildAssertionPublishReceiptQuads` (packages/core/src/assertion-seal.ts)
 *     writes, keyed by the assertion URI, into the context-graph `_meta` graph:
 *        <assertion>  dkg:publishedAtTx     "0x…"            (real tx hash)
 *        <assertion>  dkg:publishedAtBlock  "N"^^xsd:integer
 *        <assertion>  dkg:publishedAtKaId   "<packed>"^^xsd:integer
 *   • the lifecycle URN carries  dkg:reservedUal  "did:dkg:evm:<chain>/<addr>/<n>"
 *     — the deterministic Option-1 UAL.
 *
 * The clicked node is an *entity*, but the receipt is keyed by the *KA*
 * (assertion / {addr}/{name}). The bridge is the `ShareTransition` record in
 * `_shared_memory_meta` (packages/publisher/src/metadata.ts), which links each
 * member entity to its assertion source:
 *
 *     <urn:dkg:share:{opId}>  dkg:entities  <entity> ;
 *                             dkg:source    "assertion/{addr}/{name}" ;
 *                             dkg:agent     did:dkg:agent:{addr} ;
 *                             dkg:timestamp "…"^^xsd:dateTime .
 *
 * So the resolution is two SPARQL hops:
 *   1. entity → ShareTransition → (addr, name, agent, timestamp)
 *   2. (addr, name) → `_meta` → (reservedUal, txHash, block, kaId)
 *
 * Status semantics:
 *   • 'verified'  — a real on-chain receipt (tx hash) was found.
 *   • 'offchain'  — the entity is known to WM/SWM but has no VM receipt yet.
 *   • 'idle'      — no entity / disabled.
 *
 * Everything is read-only over `/api/query`; nothing is written.
 */
import { useEffect, useRef, useState } from 'react';
import { executeQuery } from '../api.js';

const DKG = 'http://dkg.io/ontology/';

export type OnChainReceiptStatus = 'idle' | 'loading' | 'verified' | 'offchain' | 'error';

export interface EntityOnChainReceipt {
  status: OnChainReceiptStatus;
  /** Real deterministic UAL: did:dkg:evm:<chainId>/<addr>/<number>. */
  ual: string | null;
  /** Real blockchain transaction hash of the publish. */
  txHash: string | null;
  /** Block number the publish landed in. */
  blockNumber: string | null;
  /** Packed Option-1 KA id (author<<96 | number), as a decimal string. */
  kaId: string | null;
  /** 0x author address (parsed from the assertion source). */
  author: string | null;
  /** ISO publish timestamp. */
  publishedAt: string | null;
  /** did:dkg:agent:… that fired the publish. */
  agent: string | null;
  error?: string;
}

const EMPTY: EntityOnChainReceipt = {
  status: 'idle',
  ual: null,
  txHash: null,
  blockNumber: null,
  kaId: null,
  author: null,
  publishedAt: null,
  agent: null,
};

/** SPARQL binding → plain string (handles both bare strings and {value}). */
function bv(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') {
    // strip wrapping quotes + ^^<datatype> / @lang on literal lexical forms
    return v.startsWith('"')
      ? v.replace(/^"/, '').replace(/"(\^\^<[^>]*>|@[\w-]+)?$/, '')
      : v;
  }
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const raw = (v as { value?: unknown }).value;
    return raw == null ? '' : String(raw);
  }
  return String(v);
}

/** Strip `< >` IRI wrapping. */
function unwrapIri(s: string): string {
  const t = s.trim();
  return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
}

/** Escape a value for safe embedding inside a SPARQL string literal. */
function sparqlStr(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/** Escape a value for safe embedding inside a `<…>` SPARQL IRI. */
function sparqlIri(value: string): string {
  // Disallow the characters that would break out of an IRI ref. If any are
  // present we treat the resolution as impossible rather than build a
  // malformed query.
  return /[<>"{}|\\^`\s]/.test(value) ? '' : value;
}

/**
 * Step 1: entity → ShareTransition → assertion source / agent / timestamp.
 * Cross-subgraph `GRAPH ?g` over `_shared_memory_meta`, so we deliberately do
 * NOT pass contextGraphId (mirrors `useVerifiedMemoryAnchors`: passing it
 * constrains `GRAPH ?g` to CG-direct graphs and drops the share records).
 */
function buildShareQuery(cgId: string, entityIri: string): string {
  return `PREFIX dkg: <${DKG}>
SELECT ?source ?agent ?ts WHERE {
  GRAPH ?g {
    ?op a dkg:ShareTransition ;
        dkg:entities <${entityIri}> ;
        dkg:source ?source ;
        dkg:agent ?agent ;
        dkg:timestamp ?ts .
  }
  FILTER(
    STRSTARTS(STR(?g), "did:dkg:context-graph:${sparqlStr(cgId)}/") &&
    CONTAINS(STR(?g), "_shared_memory_meta")
  )
} ORDER BY DESC(?ts) LIMIT 1`;
}

/**
 * Step 2: (addr, name) → `_meta` → reservedUal + on-chain receipt.
 * Fixed `GRAPH <…/_meta>` so we DO pass contextGraphId (mirrors
 * `fetchAssertionUals`). The receipt is keyed by the assertion URI; we match
 * it by `STRENDS(… "/assertion/{addr}/{name}")` so a sub-graph-qualified
 * assertion URI still resolves. reservedUal/kaId sit on the lifecycle URN.
 */
function buildReceiptQuery(cgId: string, addr: string, name: string): string {
  const metaGraph = `did:dkg:context-graph:${cgId}/_meta`;
  const lifecycleUri = `urn:dkg:assertion:${cgId}:${addr}:${name}`;
  const suffix = `/assertion/${addr}/${name}`;
  return `PREFIX dkg: <${DKG}>
SELECT ?ual ?tx ?block ?kaId WHERE {
  GRAPH <${metaGraph}> {
    OPTIONAL { <${lifecycleUri}> dkg:reservedUal ?ual . }
    OPTIONAL {
      ?asrt dkg:publishedAtTx ?tx ;
            dkg:publishedAtBlock ?block ;
            dkg:publishedAtKaId ?kaId .
      FILTER(STRENDS(STR(?asrt), "${sparqlStr(suffix)}"))
    }
  }
} LIMIT 1`;
}

/** `assertion/{addr}/{name}` → { addr, name }. */
function parseSource(source: string): { addr: string; name: string } | null {
  const m = source.match(/^assertion\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { addr: m[1], name: m[2] };
}

export function useEntityOnChainReceipt(
  contextGraphId: string | undefined,
  entityUri: string | null | undefined,
  enabled: boolean = true,
): EntityOnChainReceipt {
  const [state, setState] = useState<EntityOnChainReceipt>(() => ({ ...EMPTY }));
  const versionRef = useRef(0);

  useEffect(() => {
    if (!enabled || !contextGraphId || !entityUri) {
      setState({ ...EMPTY });
      return;
    }
    const version = ++versionRef.current;
    setState({ ...EMPTY, status: 'loading' });

    (async () => {
      try {
        // ── Hop 1: find the entity's assertion via ShareTransition ──
        const shareRes = await executeQuery(buildShareQuery(contextGraphId, entityUri)).catch(() => null);
        if (version !== versionRef.current) return;

        const shareRow = ((shareRes as any)?.result?.bindings ?? [])[0];
        if (!shareRow) {
          // No share record — entity lives only in Working Memory.
          setState({ ...EMPTY, status: 'offchain' });
          return;
        }
        const source = bv(shareRow.source);
        const parsed = parseSource(source);
        const agent = shareRow.agent ? unwrapIri(bv(shareRow.agent)) : null;
        const publishedAt = shareRow.ts ? bv(shareRow.ts) : null;
        const addr = parsed?.addr ?? null;

        if (!parsed || !sparqlIri(parsed.addr) || !sparqlStr(parsed.name)) {
          // Resolved a share but can't safely build the receipt query.
          setState({ ...EMPTY, status: 'offchain', author: addr, agent, publishedAt });
          return;
        }

        // ── Hop 2: pull the real on-chain receipt from `_meta` ──
        const receiptRes = await executeQuery(
          buildReceiptQuery(contextGraphId, parsed.addr, parsed.name),
          contextGraphId,
        ).catch(() => null);
        if (version !== versionRef.current) return;

        const receiptRow = ((receiptRes as any)?.result?.bindings ?? [])[0];
        const ual = receiptRow?.ual ? bv(receiptRow.ual) : null;
        const txHash = receiptRow?.tx ? bv(receiptRow.tx) : null;
        const blockNumber = receiptRow?.block ? bv(receiptRow.block) : null;
        const kaId = receiptRow?.kaId ? bv(receiptRow.kaId) : null;

        setState({
          status: txHash ? 'verified' : 'offchain',
          ual: ual || null,
          txHash: txHash || null,
          blockNumber: blockNumber || null,
          kaId: kaId || null,
          author: addr,
          publishedAt,
          agent,
        });
      } catch (err: any) {
        if (version !== versionRef.current) return;
        setState({ ...EMPTY, status: 'error', error: err?.message ?? String(err) });
      }
    })();
  }, [contextGraphId, entityUri, enabled]);

  return state;
}
