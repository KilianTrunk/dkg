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
   * Tag the peer keep-alive in the peerStore (idempotent, no dial). Called for
   * every selected Core — including already-connected ones — so libp2p's
   * connection manager protects + auto-redials it after a disconnect.
   */
  pin: (peerId: string, ctx: OperationContext) => Promise<void>;
  /**
   * Remove the keep-alive tag from a peer that fell out of the warm set, so
   * the pinned count can't drift above `maxCores` over time.
   */
  unpin: (peerId: string, ctx: OperationContext) => Promise<void>;
  /**
   * Dial the peer. Returns true on a successful dial. Only called for Cores
   * that aren't already connected. Errors are swallowed by the caller.
   */
  dial: (peerId: string, ctx: OperationContext) => Promise<boolean>;
  /**
   * The set of Cores pinned on the previous reconcile pass. Cores in here that
   * are NOT re-selected this pass get {@link unpin}ned. The caller owns this
   * set across ticks; {@link WarmCoreReconcileResult.warmed} is the value to
   * carry into the next pass.
   */
  previouslyWarmed?: ReadonlySet<string>;
  log: (ctx: OperationContext, msg: string) => void;
}

export interface WarmCoreReconcileResult {
  candidates: number;
  pinned: number;
  dialed: number;
  skippedGate: number;
  unpinned: number;
  /** Cores pinned this pass — feed back as `previouslyWarmed` next tick. */
  warmed: Set<string>;
}

/**
 * One reconcile pass: discover Cores, gate them, pin (+ dial when not yet
 * connected) up to `maxCores`, then unpin any Core that was warm last pass but
 * is no longer selected. Idempotent and safe to call on a timer and at startup.
 */
export async function reconcileWarmCoreConnections(
  deps: WarmCoreDeps,
): Promise<WarmCoreReconcileResult> {
  // 'sync' is the closest operation name in the logger's union; the
  // `warm-core` topic is carried in the log message itself.
  const ctx = createOperationContext('sync');
  const agents = await deps.findCoreAgents();
  const candidates = selectWarmCoreCandidates(agents, deps.selfPeerId);

  const warmed = new Set<string>();
  let dialed = 0;
  let skippedGate = 0;

  for (const core of candidates) {
    if (warmed.size >= deps.maxCores) break;

    const allowed = await deps.isShardingTableCore(core.agentAddress).catch(() => false);
    if (!allowed) {
      skippedGate += 1;
      continue;
    }

    // Pin BEFORE the connected-check so an already-connected Core still gets
    // (and keeps) its keep-alive tag — otherwise libp2p won't auto-redial it.
    // Only claim the slot when the pin actually succeeded: a malformed peer id
    // or a `peerStore.merge` failure must fall through to the next healthy
    // candidate instead of burning a `maxCores` slot on a peer we never tagged
    // (and never dialed).
    const pinned = await deps.pin(core.peerId, ctx).then(() => true).catch(() => false);
    if (!pinned) continue;
    warmed.add(core.peerId);

    if (deps.isConnected(core.peerId)) continue;
    const ok = await deps.dial(core.peerId, ctx).catch(() => false);
    if (ok) dialed += 1;
  }

  // Prune: drop the keep-alive tag from Cores warmed last pass but not this
  // one, so the pinned set tracks the live selection and never exceeds the cap.
  let unpinned = 0;
  if (deps.previouslyWarmed) {
    for (const peerId of deps.previouslyWarmed) {
      if (!warmed.has(peerId)) {
        await deps.unpin(peerId, ctx).catch(() => {});
        unpinned += 1;
      }
    }
  }

  deps.log(
    ctx,
    `warm-core reconcile: candidates=${candidates.length} pinned=${warmed.size} dialed=${dialed} skippedGate=${skippedGate} unpinned=${unpinned} (cap=${deps.maxCores})`,
  );

  return { candidates: candidates.length, pinned: warmed.size, dialed, skippedGate, unpinned, warmed };
}
