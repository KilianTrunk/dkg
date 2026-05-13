import { multiaddr } from '@multiformats/multiaddr';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import type { DiscoveryClient } from '../discovery.js';

/**
 * Minimal libp2p surface the Messenger needs. Defined locally to keep
 * test mocking trivial — production code passes `node.libp2p`.
 */
interface Libp2pLike {
  getConnections(peerId?: unknown): Array<unknown>;
  peerStore: {
    merge(peer: unknown, update: { multiaddrs: unknown[] }): Promise<void>;
  };
}

export interface MessengerDeps {
  libp2p: Libp2pLike;
  router: ProtocolRouter;
  discovery: DiscoveryClient;
}

export interface SendOpts {
  timeoutMs?: number;
}

/**
 * Single outbound P2P sending primitive.
 *
 * Two responsibilities:
 *  1. Best-effort prime a /p2p-circuit relay route into the libp2p peerStore
 *     before dialling, so NAT'd peers reachable only via a circuit relay can
 *     be dialled by `dialProtocol` (which otherwise falls back to direct dial
 *     and fails for NAT'd peers without an active connection).
 *  2. Forward the bytes via `ProtocolRouter.send` (which itself owns
 *     transport-level retry on recoverable errors — see protocol-router.ts).
 *
 * Centralising this in one place removes a class of "this code path forgot to
 * call ensureCircuitRelayAddress" defects (the latent bug behind PR #448's
 * Laptop B invite failure).
 *
 * Discovery is currently SPARQL-first against the agents context graph; this
 * is preserved verbatim from the previous DKGAgent.ensureCircuitRelayAddress
 * implementation. See dkgv10-spec/production_mainnet/04_NETWORK_STATE_REGISTRY.md
 * for the planned chain-driven replacement, and 07_IN_PROCESS_PEER_RESOLVER.md
 * for the in-process resolver that all dial paths will eventually consume.
 */
export class Messenger {
  private readonly libp2p: Libp2pLike;
  private readonly router: ProtocolRouter;
  private readonly discovery: DiscoveryClient;

  constructor(deps: MessengerDeps) {
    this.libp2p = deps.libp2p;
    this.router = deps.router;
    this.discovery = deps.discovery;
  }

  async sendToPeer(
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    opts: SendOpts = {},
  ): Promise<Uint8Array> {
    await this.ensureCircuitRelayAddress(peerId);
    return this.router.send(peerId, protocolId, data, opts.timeoutMs);
  }

  /**
   * Best-effort: if the peer is not currently connected and the agent
   * registry advertises a relay for them, add a /p2p-circuit multiaddr
   * to the peer store so dialProtocol can route through the relay.
   *
   * Failures are swallowed deliberately — the caller's send() will surface
   * a proper transport error from dialProtocol if the peer is unreachable.
   *
   * TODO(follow-up): prefer chain-driven discovery via the network-state
   * registry (RFC 04) for freshness; SPARQL profile lookup as last-resort
   * fallback.
   */
  private async ensureCircuitRelayAddress(peerIdStr: string): Promise<void> {
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const peerId = peerIdFromString(peerIdStr);

      const conns = this.libp2p.getConnections(peerId);
      if (conns.length > 0) return;

      const agent = await this.discovery.findAgentByPeerId(peerIdStr);
      if (!agent?.relayAddress) return;

      const circuitAddr = multiaddr(
        `${agent.relayAddress}/p2p-circuit/p2p/${peerIdStr}`,
      );
      await this.libp2p.peerStore.merge(peerId, {
        multiaddrs: [circuitAddr],
      });
    } catch {
      // Best-effort — let the caller's send() surface the real error.
    }
  }
}
