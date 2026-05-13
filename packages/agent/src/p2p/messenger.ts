import type { ProtocolRouter, PeerResolver } from '@origintrail-official/dkg-core';

export interface MessengerDeps {
  resolver: PeerResolver;
  router: ProtocolRouter;
}

export interface SendOpts {
  timeoutMs?: number;
}

/**
 * Single outbound P2P sending primitive.
 *
 * Two responsibilities:
 *  1. Best-effort consult `PeerResolver` to populate the libp2p
 *     peerStore with whatever multiaddrs the resolution order finds
 *     (live conn, DHT, RFC 04 registry, agents-CG, bootstrap seeds).
 *     The patch is the resolver's side effect; this code just
 *     triggers the lookup before dialing.
 *  2. Forward the bytes via `ProtocolRouter.send` (which itself owns
 *     transport-level retry on recoverable errors — see
 *     protocol-router.ts).
 *
 * Centralising this in one place removes a class of "this code path
 * forgot to ensure an address was known" defects (the latent bug
 * behind PR #448's Laptop B invite failure).
 *
 * After RFC 07 PR-2: resolution is delegated to `PeerResolver` rather
 * than inlined. PR-3 of the RFC 07 rollout migrates `ProtocolRouter`
 * itself, after which the resolver is consulted on every dial path
 * (chat / sync / skill invoke / `/api/connect`) — not just chat.
 *
 * See `dkgv10-spec/production_mainnet/07_IN_PROCESS_PEER_RESOLVER.md`.
 */
export class Messenger {
  private readonly resolver: PeerResolver;
  private readonly router: ProtocolRouter;

  constructor(deps: MessengerDeps) {
    this.resolver = deps.resolver;
    this.router = deps.router;
  }

  async sendToPeer(
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    opts: SendOpts = {},
  ): Promise<Uint8Array> {
    // Best-effort: fire the resolver to populate peerStore. Failures
    // are swallowed deliberately — the router's send() will surface
    // a real transport error from dialProtocol if the peer is
    // unreachable, and the resolver itself never throws on resolution
    // failure (it returns an empty array).
    await this.resolver.resolve(peerId).catch(() => undefined);
    return this.router.send(peerId, protocolId, data, opts.timeoutMs);
  }
}
