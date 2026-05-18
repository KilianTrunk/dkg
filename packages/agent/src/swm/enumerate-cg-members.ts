/**
 * SWM Reliable Fan-out — runtime CG member enumeration (rc.9 PR-B,
 * Step 1a of the plan).
 *
 * Discovers the recipient set for a SWM share at fan-out time, with
 * a single uniform API across the three CG membership models that
 * coexist on rc.9 testnet:
 *
 *   - **curated** — CG has an on-chain (or local-meta-mirrored)
 *     allowlist of peer IDs. Resolved via `getContextGraphAllowedPeers`,
 *     which returns a non-null array of allowed peerIds. Source label:
 *     `'allowlist'`.
 *
 *   - **public** — anyone can subscribe. There is NO authoritative
 *     roster (publishing the allowlist on-chain for every drive-by
 *     subscriber would be a cost regression the RFC explicitly avoids
 *     — see RFC-003 §4.4 "Member enumeration misalignment"). The
 *     best-effort substitute is the live GossipSub subscriber set as
 *     observed via the heartbeat + peer-exchange protocol. Source
 *     label: `'topic-subscribers'`.
 *
 *   - **legacy / unknown** — neither an allowlist nor any live
 *     subscribers. Returns an empty member set with source `'none'`
 *     so the caller can fall back to gossip-only delivery (or skip
 *     the substrate top-up entirely). This is the bootstrap state for
 *     a freshly-created CG before any peer has joined the mesh.
 *
 * The enumerator is intentionally NOT a hot-path component. Each
 * `enumerate(cgId)` call may trigger a SPARQL query against the
 * meta graph (for the allowlist resolution) — non-trivial but not
 * prohibitive. The 60s in-memory cache absorbs the burst pattern
 * typical for SWM share workloads (a burst of N shares to the same
 * CG within seconds shares a single enumeration result).
 *
 * Cache TTL chosen to balance:
 *   - **freshness** — when a curator updates the allowlist or a
 *     subscriber joins/leaves, the change becomes visible to the
 *     fan-out path within at most TTL milliseconds.
 *   - **work** — N shares to the same CG within TTL only pay one
 *     SPARQL query + one `getSubscribers` call.
 *
 * Callers that need explicit invalidation (e.g. PR-C after a
 * substrate top-up consistently fails for a member) can call
 * `invalidate(cgId)`.
 */

export type CGMemberSource = 'allowlist' | 'topic-subscribers' | 'none';

export interface CGMemberEnumeration {
  /** Which discovery path produced {@link members}. */
  source: CGMemberSource;
  /**
   * Peer IDs of the recipient set, with self excluded. Order is not
   * guaranteed (depends on SPARQL result ordering or GossipSub's
   * internal peer set iteration). Caller MUST de-duplicate if it
   * combines results across calls.
   */
  members: string[];
}

export interface CGMemberEnumeratorDeps {
  /**
   * Resolves a CG's peer allowlist. Returns `null` for CGs without
   * an explicit `DKG_ALLOWED_PEER` allowlist in the meta graph. A
   * `null` return does NOT by itself mean "public" — agent-gated
   * private CGs (`DKG_ALLOWED_AGENT` / `DKG_PARTICIPANT_AGENT`
   * without peer allowlist triples) also return `null` here. The
   * enumerator disambiguates via {@link isPrivateContextGraph}.
   * Returns `[]` for a curated CG whose allowlist is explicitly
   * empty (rare; surfaced as `source: 'allowlist'` with zero members
   * so callers can distinguish "curated with zero remaining members"
   * from "public CG with no subscribers").
   */
  getContextGraphAllowedPeers: (cgId: string) => Promise<string[] | null>;
  /**
   * Returns true for any private CG — peer-allowlisted, agent-gated,
   * or both. Same predicate the responder consults to gate sync /
   * SWM-share auth (see `DKGAgent.isPrivateContextGraph`), so
   * fan-out classification stays consistent with the data-plane
   * access control.
   *
   * Bug fix (codex review on #571): without this, a CG that is
   * private via `DKG_ALLOWED_AGENT` ONLY (no `DKG_ALLOWED_PEER`
   * triples) was misclassified as public — `getContextGraphAllowedPeers`
   * returns null, and the old code fell straight through to live
   * topic subscribers. That would fan out SWM shares to GossipSub
   * subscribers who are NOT actually allowed members, risking a
   * metadata leak (the encrypted payload itself is still gated by
   * the per-CG key, but the bare fact that a share exists would
   * reach unauthorized nodes). Fail closed: if the CG is private
   * but we have no enumerable peer allowlist, return `source:
   * 'none'` with empty members so the caller falls back to
   * gossip-only delivery (still safe because the receiver enforces
   * auth on the gossip path too).
   */
  isPrivateContextGraph: (cgId: string) => Promise<boolean>;
  /**
   * Best-effort snapshot of peers subscribed to {@link topic} as
   * observed via GossipSub heartbeat + peer-exchange. May be empty
   * or stale; never throws.
   */
  getTopicSubscribers: (topic: string) => string[];
  topicForCG: (cgId: string) => string;
  /**
   * Our own peer ID. Always excluded from the returned member set —
   * we don't fan-out to ourselves (the local apply already happened
   * in the caller).
   */
  selfPeerId: string;
  /** Defaults to `Date.now`; override in tests for deterministic TTL. */
  now?: () => number;
  /** Defaults to 60s; override in tests or for higher-volatility CGs. */
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

export interface CGMemberEnumerator {
  /**
   * Resolve the current member set for {@link cgId}. Returns cached
   * value if within TTL, otherwise recomputes (and caches).
   */
  enumerate(cgId: string): Promise<CGMemberEnumeration>;
  /**
   * Drop the cached entry for {@link cgId} so the next `enumerate`
   * call recomputes. Safe to call for unknown cgIds (no-op).
   */
  invalidate(cgId: string): void;
  /** Test/debug helper: number of cached entries currently held. */
  size(): number;
}

export function createCGMemberEnumerator(deps: CGMemberEnumeratorDeps): CGMemberEnumerator {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, { computedAtMs: number; value: CGMemberEnumeration }>();
  // In-flight promise dedup so a burst of concurrent `enumerate(cgId)`
  // calls for the same cgId collapses onto a single resolution. Bug
  // fix (codex review on #571): without this, the burst optimisation
  // the cache TTL is supposed to provide didn't actually fire for
  // CONCURRENT bursts — every concurrent call saw a cache miss
  // (cache is populated only after the async resolution finishes) and
  // each performed its own SPARQL query + `getSubscribers` call. The
  // entry is removed in `finally` so a future call after the promise
  // settles consults the TTL cache normally.
  const inFlight = new Map<string, Promise<CGMemberEnumeration>>();

  function isFresh(entry: { computedAtMs: number }, nowMs: number): boolean {
    return nowMs - entry.computedAtMs < ttl;
  }

  async function resolve(cgId: string, computedAtMs: number): Promise<CGMemberEnumeration> {
    const allowed = await deps.getContextGraphAllowedPeers(cgId);

    if (allowed !== null) {
      // Curated CG with explicit peer allowlist: roster is
      // authoritative. Even an empty allowlist is meaningful
      // (curator removed every member; do NOT fall through to topic
      // subscribers — that would re-admit peers the curator just
      // kicked).
      const result: CGMemberEnumeration = {
        source: 'allowlist',
        members: dedupAndExcludeSelf(allowed, deps.selfPeerId),
      };
      cache.set(cgId, { computedAtMs, value: result });
      return result;
    }

    // No peer allowlist exists. Disambiguate private (agent-gated)
    // from public via the same predicate the responder consults for
    // sync / SWM-share auth. Fail closed for private CGs (see
    // `isPrivateContextGraph` jsdoc on CGMemberEnumeratorDeps).
    if (await deps.isPrivateContextGraph(cgId)) {
      const result: CGMemberEnumeration = { source: 'none', members: [] };
      cache.set(cgId, { computedAtMs, value: result });
      return result;
    }

    // Public CG: no on-chain roster exists by design (subscribers
    // don't pay to subscribe). Use the live GossipSub view.
    const subscribers = deps.getTopicSubscribers(deps.topicForCG(cgId));
    const result: CGMemberEnumeration = subscribers.length === 0
      ? { source: 'none', members: [] }
      : {
        source: 'topic-subscribers',
        members: dedupAndExcludeSelf(subscribers, deps.selfPeerId),
      };
    cache.set(cgId, { computedAtMs, value: result });
    return result;
  }

  return {
    async enumerate(cgId: string): Promise<CGMemberEnumeration> {
      const nowMs = now();
      const cached = cache.get(cgId);
      if (cached && isFresh(cached, nowMs)) {
        return cached.value;
      }

      const existing = inFlight.get(cgId);
      if (existing) return existing;

      const promise = resolve(cgId, nowMs).finally(() => {
        inFlight.delete(cgId);
      });
      inFlight.set(cgId, promise);
      return promise;
    },

    invalidate(cgId: string): void {
      cache.delete(cgId);
    },

    size(): number {
      return cache.size;
    },
  };
}

function dedupAndExcludeSelf(peers: readonly string[], selfPeerId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of peers) {
    if (p === selfPeerId) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
