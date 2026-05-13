/**
 * NetworkStateRegistry — RFC 04 §3.3 / RFC 07 §3.1 step 3.
 *
 * In-memory index of multiaddrs keyed on peerId, populated by
 * PROTOCOL_SYNC delivery of `system-dkg-network` attestation KCs.
 * `PeerResolver` consults it as step 3 of the resolution order.
 *
 * **v1 stub.** Returns empty arrays from `lookup()` until RFC 04
 * Phase 2 (submitProofV2 + per-round attestation KCs) lands. The
 * interface is fixed so the future PR-4 of the RFC 07 rollout can
 * wire the real implementation in without touching consumers.
 */
import type { NodeIdentity, Address } from './network.js';

export interface NetworkStateRegistry {
  /**
   * Return the multiaddrs the network registry knows for `peerId`.
   * Empty array means "no record" — which is the entire population
   * today, because no attestation KCs are minted before RFC 04
   * Phase 2 lands.
   */
  lookup(peerId: NodeIdentity): Address[];
}

/**
 * Stub implementation. Always returns `[]`. Used during RFC 07
 * PRs 1-4; replaced by the real registry in the PR that wires
 * `system-dkg-network` syncs to in-memory state.
 */
export class StubNetworkStateRegistry implements NetworkStateRegistry {
  lookup(_peerId: NodeIdentity): Address[] {
    return [];
  }
}
