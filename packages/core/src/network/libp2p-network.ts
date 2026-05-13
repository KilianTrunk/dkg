/**
 * Libp2p implementation of the {@link Network} interface — RFC 07 §5.
 *
 * Thin facade over an existing {@link DKGNode}: every method delegates
 * directly to the libp2p instance the node already owns. No state is
 * duplicated; lifecycle is shared.
 *
 * v1 ships this as the only `Network` implementation. The interface
 * boundary is what RFC 07 commits to architecturally; the implementation
 * is libp2p because that's what the rest of V10 already runs on.
 */
import type { Stream, Connection } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { Network, NodeIdentity, Address, DialOpts, ProtocolHandler } from './network.js';
import type { DKGNode } from '../node.js';

const DEFAULT_DIAL_TIMEOUT_MS = 10_000;
const DEFAULT_FIND_PEER_TIMEOUT_MS = 5_000;

export class LibP2PNetwork implements Network {
  private readonly node: DKGNode;

  constructor(node: DKGNode) {
    this.node = node;
  }

  get localId(): NodeIdentity {
    return this.node.peerId;
  }

  get localAddresses(): Address[] {
    return this.node.multiaddrs;
  }

  get isStarted(): boolean {
    return this.node.isStarted;
  }

  async start(): Promise<void> {
    if (!this.node.isStarted) {
      await this.node.start();
    }
  }

  async stop(): Promise<void> {
    if (this.node.isStarted) {
      await this.node.stop();
    }
  }

  async dialProtocol(
    peerId: NodeIdentity,
    protocolId: string,
    opts?: DialOpts,
  ): Promise<Stream> {
    const pid = peerIdFromString(peerId);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS;
    // libp2p dialProtocol accepts an AbortSignal directly. If the
    // caller supplied one, honour it as-is; otherwise mint one off the
    // timeout so a runaway dial doesn't pin a stream slot indefinitely.
    const signal = opts?.signal ?? AbortSignal.timeout(timeoutMs);
    return this.node.libp2p.dialProtocol(pid, protocolId, { signal });
  }

  async handle(protocolId: string, handler: ProtocolHandler): Promise<void> {
    await this.node.libp2p.handle(protocolId, (stream, connection) => {
      void handler(stream, connection.remotePeer.toString());
    });
  }

  async unhandle(protocolId: string): Promise<void> {
    await this.node.libp2p.unhandle(protocolId);
  }

  getConnections(peerId: NodeIdentity): Connection[] {
    const pid = peerIdFromString(peerId);
    return this.node.libp2p.getConnections(pid);
  }

  async addKnownAddresses(peerId: NodeIdentity, addrs: Address[]): Promise<void> {
    if (addrs.length === 0) return;
    const pid = peerIdFromString(peerId);
    const ma = addrs.map((a) => multiaddr(a));
    await this.node.libp2p.peerStore.merge(pid, { multiaddrs: ma });
  }

  async findPeer(
    peerId: NodeIdentity,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Address[]> {
    const pid = peerIdFromString(peerId);
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_FIND_PEER_TIMEOUT_MS;
    const signal = opts?.signal ?? AbortSignal.timeout(timeoutMs);
    const info = await this.node.libp2p.peerRouting.findPeer(pid, { signal });
    return (info?.multiaddrs ?? []).map((m) => m.toString());
  }
}
