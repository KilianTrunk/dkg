import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';

/**
 * A.4-lite+ — phonebook-driven warm/pinned connections to Core nodes.
 *
 * Why
 * ---
 * Catch-up and chain-driven reconciliation (Phase A/B) prefer Core nodes
 * because they're always-on, staked, and persist content. But an edge that
 * isn't *connected* to a Core when it needs to sync pays the full
 * circuit-relay dial cost first (the May 2026 soak measured 200-365 ms per
 * establishment, p95 ~8.5 s — see `message-stream-pool.ts`). Keeping a small
 * set of Cores **warm** (connection pinned + auto-redialed by libp2p's
 * connection manager) removes that cold-dial from the critical path.
 *
 * This is the same trick the node already uses for relay servers
 * (`node.ts`: `peerStore.merge(..., tags: { 'keep-alive-...': { value } })`
 * + `dial` + watchdog). We mirror it for Cores.
 *
 * Scope (deliberately narrow)
 * ---------------------------
 *   * Warm the *connection*, not a dedicated sync *stream*. A warm
 *     connection captures ~90 % of the latency win; pooling a long-lived
 *     `PROTOCOL_SYNC` stream is a structural mismatch (the message pool is a
 *     one-small-request/response multiplexer; sync streams pages) and is out
 *     of scope.
 *   * Identity of Cores comes from the Agent Registry CG phonebook
 *     (`nodeRole='core'`), which already carries `peerId` + `agentAddress`.
 *   * Trust gate: optionally confirm on-chain ShardingTable membership before
 *     pinning, so we only warm *staked* Cores. Best-effort — when the chain
 *     adapter can't answer (no chain, method absent), the gate passes.
 *
 * Pure selection (`selectWarmCoreCandidates`) is separated from the
 * side-effecting orchestration (`reconcileWarmCoreConnections`) so the
 * filtering is unit-testable without a libp2p/chain harness.
 */

/** Minimal phonebook shape this module needs. */
export interface WarmCoreAgent {
  peerId: string;
  nodeRole?: string;
  agentAddress?: string;
}

/**
 * From the phonebook agent list, the Cores worth warm-pinning: role
 * `core`, not ourselves, de-duplicated by peerId. Input order is preserved
 * (callers may pre-sort by `lastSeen`); the per-tick cap is applied later
 * in `reconcileWarmCoreConnections` so it counts *gated* Cores, not raw
 * candidates.
 */
export function selectWarmCoreCandidates(
  agents: WarmCoreAgent[],
  selfPeerId: string,
): WarmCoreAgent[] {
  const seen = new Set<string>();
  const out: WarmCoreAgent[] = [];
  for (const agent of agents) {
    if (agent.nodeRole !== 'core') continue;
    if (!agent.peerId || agent.peerId === selfPeerId) continue;
    if (seen.has(agent.peerId)) continue;
    seen.add(agent.peerId);
    out.push(agent);
  }
  return out;
}

export interface WarmCoreDeps {
  /** Phonebook lookup — typically `discovery.findAgents()` mapped to {@link WarmCoreAgent}. */
  findCoreAgents: () => Promise<WarmCoreAgent[]>;
  /** This node's peerId string, so we never warm-dial ourselves. */
  selfPeerId: string;
  /** Upper bound on simultaneously pinned Cores (slot-exhaustion guard). */
  maxCores: number;
  /**
   * Trust gate: resolve true if this Core may be pinned. Production wires
   * this to `getIdentityIdForAddress(addr) -> isShardingTableMember(id)`.
   * Best-effort: returns true when gating is unavailable.
   */
  isShardingTableCore: (agentAddress: string | undefined) => Promise<boolean>;
  /** True if a live connection to this peer already exists. */
  isConnected: (peerId: string) => boolean;
  /**
   * Tag the peer keep-alive in the peerStore and dial it. Returns true on a
   * successful dial. Implementation lives in `DKGAgent` (peerStore.merge +
   * libp2p.dial); errors are swallowed by the caller.
   */
  pinAndDial: (peerId: string, ctx: OperationContext) => Promise<boolean>;
  log: (ctx: OperationContext, msg: string) => void;
}

export interface WarmCoreReconcileResult {
  candidates: number;
  pinned: number;
  dialed: number;
  skippedGate: number;
}

/**
 * One reconcile pass: discover Cores, gate them, pin+dial up to `maxCores`.
 * Idempotent — already-connected Cores are re-tagged (cheap) but not
 * re-dialed. Safe to call on a timer and once at startup.
 */
export async function reconcileWarmCoreConnections(
  deps: WarmCoreDeps,
): Promise<WarmCoreReconcileResult> {
  // 'sync' is the closest operation name in the logger's union; the
  // `warm-core` topic is carried in the log message itself.
  const ctx = createOperationContext('sync');
  const agents = await deps.findCoreAgents();
  const candidates = selectWarmCoreCandidates(agents, deps.selfPeerId);

  let pinned = 0;
  let dialed = 0;
  let skippedGate = 0;

  for (const core of candidates) {
    if (pinned >= deps.maxCores) break;

    const allowed = await deps.isShardingTableCore(core.agentAddress).catch(() => false);
    if (!allowed) {
      skippedGate += 1;
      continue;
    }

    pinned += 1;
    if (deps.isConnected(core.peerId)) continue;

    const ok = await deps.pinAndDial(core.peerId, ctx).catch(() => false);
    if (ok) dialed += 1;
  }

  deps.log(
    ctx,
    `warm-core reconcile: candidates=${candidates.length} pinned=${pinned} dialed=${dialed} skippedGate=${skippedGate} (cap=${deps.maxCores})`,
  );

  return { candidates: candidates.length, pinned, dialed, skippedGate };
}
