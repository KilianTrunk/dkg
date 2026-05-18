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
   * Resolves a CG's peer allowlist. Returns `null` for non-curated
   * CGs (no `DKG_ALLOWED_PEER` triples in the meta graph) — the
   * enumerator interprets `null` as "fall through to topic-subscribers".
   * Returns `[]` for a curated CG whose allowlist is explicitly
   * empty (rare; the enumerator surfaces this as `source: 'allowlist'`
   * with zero members so callers can distinguish "curated with zero
   * remaining members" from "public CG with no subscribers").
   */
  getContextGraphAllowedPeers: (cgId: string) => Promise<string[] | null>;
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

  function isFresh(entry: { computedAtMs: number }, nowMs: number): boolean {
    return nowMs - entry.computedAtMs < ttl;
  }

  return {
    async enumerate(cgId: string): Promise<CGMemberEnumeration> {
      const nowMs = now();
      const cached = cache.get(cgId);
      if (cached && isFresh(cached, nowMs)) {
        return cached.value;
      }

      const allowed = await deps.getContextGraphAllowedPeers(cgId);
      let result: CGMemberEnumeration;

      if (allowed !== null) {
        // Curated CG: allowlist is authoritative. Even an empty
        // allowlist is meaningful (signals a curator removed every
        // member; callers should NOT fall through to topic subscribers
        // because that would re-admit peers the curator just kicked).
        result = {
          source: 'allowlist',
          members: dedupAndExcludeSelf(allowed, deps.selfPeerId),
        };
      } else {
        // Public CG: no on-chain roster exists by design (subscribers
        // don't pay to subscribe). Use the live GossipSub view.
        const subscribers = deps.getTopicSubscribers(deps.topicForCG(cgId));
        if (subscribers.length === 0) {
          result = { source: 'none', members: [] };
        } else {
          result = {
            source: 'topic-subscribers',
            members: dedupAndExcludeSelf(subscribers, deps.selfPeerId),
          };
        }
      }

      cache.set(cgId, { computedAtMs: nowMs, value: result });
      return result;
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
