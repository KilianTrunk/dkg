/**
 * rc.9 PR-C integration test for the substrate fan-out + tier-
 * switch wiring INSIDE DKGAgent (the pure decision + executor
 * logic is covered by `swm-substrate-fanout.test.ts`).
 *
 * The agent's `publishWorkspaceGossip` now consults the
 * CGMemberEnumerator + the tier-switch + (conditionally) the
 * substrate fan-out path. Each share goes through three
 * conceptually independent surfaces:
 *
 *   1. Enumeration: which transport(s) we'll use
 *   2. Substrate fan-out: per-(cgId, outcome) counters
 *   3. Gossip publish: PR-A's loud-fail counter (already
 *      regression-tested in `swm-gossip-publish-failure.test.ts`)
 *
 * The wire-format of `/api/slo` for #2 is regression-tested in
 * `packages/cli/test/api-slo-route.test.ts`. What's left to pin
 * is the AGENT-side wiring: that the tier decision actually
 * flows to the substrate vs gossip path based on enumeration,
 * and that the per-outcome counters update accordingly.
 */

import { describe, it, expect } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

const SELF_PEER = '12D3KooWSelfPubC';

class CapturingGossip {
  publishes: Array<{ topic: string; bytes: number }> = [];
  /** Static roster returned by `getSubscribers` — adjust per-test. */
  subscribers: string[] = [];

  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
  onMessage(_topic: string, _handler: (topic: string, data: Uint8Array, from?: string) => void | Promise<void>): void {}

  async publish(topic: string, data: Uint8Array): Promise<void> {
    this.publishes.push({ topic, bytes: data.byteLength });
  }

  getSubscribers(_topic: string): string[] {
    return [...this.subscribers];
  }
}

/**
 * Narrow stub of Messenger.sendReliable. We don't exercise the
 * envelope wrap / outbox path here — that's covered by the
 * messenger's own tests; we just confirm the agent invokes
 * sendReliable per-substrate-member and that the result is
 * counted into the right per-outcome bucket.
 *
 * `DKGAgent.create()` does NOT initialise `this.messenger` — that
 * happens inside `start()`, which we don't call in this test
 * suite (it would require a real libp2p node). So we install a
 * narrow stub object whose only contract is `sendReliable`; the
 * substrate-fanout module is typed against `FanOutSubstrate`
 * which has only that one method.
 */
function stubMessengerSendReliable(
  results: Map<string, ReliableSendResult> | ((peerId: string) => ReliableSendResult | Error),
): { calls: Array<{ peerId: string; protocolId: string; bytes: number }>; install: (agent: DKGAgent) => void } {
  const calls: Array<{ peerId: string; protocolId: string; bytes: number }> = [];
  const lookup = typeof results === 'function'
    ? results
    : (peerId: string): ReliableSendResult | Error => {
      const r = results.get(peerId);
      if (!r) return new Error(`stubMessengerSendReliable: no result configured for peerId=${peerId}`);
      return r;
    };
  const install = (agent: DKGAgent): void => {
    const stub = {
      sendReliable: async (
        peerId: string,
        protocolId: string,
        payload: Uint8Array,
      ): Promise<ReliableSendResult> => {
        calls.push({ peerId, protocolId, bytes: payload.byteLength });
        const out = lookup(peerId);
        if (out instanceof Error) throw out;
        return out;
      },
    };
    (agent as unknown as { messenger: typeof stub }).messenger = stub;
  };
  return { calls, install };
}

async function createAgent(name: string): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: `${name}-${Math.random().toString(36).slice(2)}`,
    chainAdapter: new MockChainAdapter(),
  });
  // DKGNode.peerId is a getter that delegates into the live libp2p
  // node; without `start()` it throws. Pin it to a deterministic
  // string for the substrate-fanout self-exclusion check (the
  // CGMemberEnumerator captures `selfPeerId: this.peerId` once at
  // agent constructor time).
  Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
    value: SELF_PEER,
    configurable: true,
  });
  return agent;
}

describe('DKGAgent SWM substrate fan-out integration (rc.9 PR-C)', () => {
  it('reports zero substrate-fanout counters before any share', async () => {
    const agent = await createAgent('SubstrateFanoutZero');
    const stats = agent.getSwmSubstrateFanoutStats();

    expect(stats).toEqual({
      delivered: {},
      queued: {},
      inFlight: {},
      failed: {},
      overflow: { delivered: 0, queued: 0, inFlight: 0, failed: 0 },
      truncated: false,
    });
  });

  /**
   * Public CG with no live subscribers + no allowlist =>
   * `source: 'none'` => gossip-only path. No substrate sends,
   * no per-outcome counters move, gossip publish fires exactly
   * once. This is the PR-A pre-PR-C behavior (verifies PR-C
   * didn't regress the gossip-only branch).
   */
  it('source=none takes gossip-only branch and does NOT call sendReliable', async () => {
    const agent = await createAgent('SubstrateFanoutNone');
    const gossip = new CapturingGossip();
    gossip.subscribers = [];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    const { calls, install } = stubMessengerSendReliable(new Map());
    install(agent);

    await agent.share('cg-no-roster', [{
      subject: 'urn:test:none', predicate: 'http://schema.org/name', object: '"hi"', graph: '',
    }]);

    expect(gossip.publishes).toHaveLength(1);
    expect(gossip.publishes[0]?.topic).toMatch(/shared-memory$/);
    expect(calls).toEqual([]);
    expect(agent.getSwmSubstrateFanoutStats()).toEqual({
      delivered: {},
      queued: {},
      inFlight: {},
      failed: {},
      overflow: { delivered: 0, queued: 0, inFlight: 0, failed: 0 },
      truncated: false,
    });
  });

  /**
   * Public CG with live subscribers <= cap (default 100) =>
   * `source: 'topic-subscribers'` => substrate fan-out RUNS in
   * parallel with gossip publish. Each substrate send is counted
   * by outcome. `delivered` for the success, `queued` for the
   * one that the messenger persisted for retry, `failed` for the
   * synchronous-throw classification path.
   */
  it('source=topic-subscribers fans out via substrate AND publishes via gossip, counters reflect mixed outcomes', async () => {
    const agent = await createAgent('SubstrateFanoutPublic');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeerA', '12D3KooWPeerB', '12D3KooWPeerC'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { calls, install } = stubMessengerSendReliable((peerId): ReliableSendResult | Error => {
      switch (peerId) {
        case '12D3KooWPeerA':
          return { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mA' };
        case '12D3KooWPeerB':
          return {
            delivered: false, queued: true, attempts: 2, messageId: 'mB',
            error: 'transient', nextAttemptAtMs: Date.now() + 1000,
          };
        case '12D3KooWPeerC':
          return new Error('peerC connection refused');
        default:
          return new Error(`unexpected peerId=${peerId}`);
      }
    });
    install(agent);

    await agent.share('cg-public-mixed', [{
      subject: 'urn:test:mixed', predicate: 'http://schema.org/name', object: '"mixed"', graph: '',
    }]);

    // Gossip publish should have fired exactly once for the topic.
    expect(gossip.publishes).toHaveLength(1);
    expect(gossip.publishes[0]?.topic).toMatch(/shared-memory$/);

    // Substrate fan-out should have hit all three subscribers
    // (self is excluded by the enumerator, and self isn't in
    // this fixture's subscriber list anyway).
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.protocolId === '/dkg/10.0.1/swm-update')).toBe(true);
    // All three sends carry the same wire bytes as the gossip
    // publish — same `encodeWorkspaceGossipMessage` output.
    expect(calls.every(c => c.bytes === gossip.publishes[0]?.bytes)).toBe(true);

    const stats = agent.getSwmSubstrateFanoutStats();
    expect(stats.delivered).toEqual({ 'cg-public-mixed': 1 });
    expect(stats.queued).toEqual({ 'cg-public-mixed': 1 });
    expect(stats.inFlight).toEqual({});
    expect(stats.failed).toEqual({ 'cg-public-mixed': 1 });
    expect(stats.overflow).toEqual({ delivered: 0, queued: 0, inFlight: 0, failed: 0 });
    expect(stats.truncated).toBe(false);
  });

  /**
   * Self should be excluded from the substrate fan-out roster.
   * If our own peerId appears in the GossipSub subscribers list
   * (which it does after we subscribe to our own CG), substrate
   * fan-out MUST skip it — we already applied the share locally
   * in the caller, and sending it to ourselves over the
   * messenger would be wasted work + a redundantApplies bump.
   */
  it('excludes self from substrate fan-out even when self is a topic subscriber', async () => {
    const agent = await createAgent('SubstrateFanoutSelfExclude');
    const gossip = new CapturingGossip();
    // CGMemberEnumerator filters self out via the `selfPeerId` dep,
    // which is wired to `this.peerId` (set above to SELF_PEER).
    gossip.subscribers = [SELF_PEER, '12D3KooWPeerOther'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { calls, install } = stubMessengerSendReliable(new Map([
      ['12D3KooWPeerOther', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mO' }],
    ]));
    install(agent);

    await agent.share('cg-self-exclude', [{
      subject: 'urn:test:se', predicate: 'http://schema.org/name', object: '"self"', graph: '',
    }]);

    expect(calls.map(c => c.peerId)).toEqual(['12D3KooWPeerOther']);
    expect(agent.getSwmSubstrateFanoutStats().delivered).toEqual({ 'cg-self-exclude': 1 });
  });

  /**
   * Counters MUST isolate per cgId so operator-facing /api/slo
   * shows which CGs are healthy vs which are dragging the
   * delivery rate down.
   */
  it('per-cgId outcome counters are isolated across multiple shares to different CGs', async () => {
    const agent = await createAgent('SubstrateFanoutIsolation');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeerOnly'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(new Map([
      ['12D3KooWPeerOnly', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mOK' }],
    ]));
    install(agent);

    await agent.share('cg-iso-1', [{
      subject: 'urn:test:i1', predicate: 'http://schema.org/name', object: '"a"', graph: '',
    }]);
    await agent.share('cg-iso-2', [{
      subject: 'urn:test:i2', predicate: 'http://schema.org/name', object: '"b"', graph: '',
    }]);
    await agent.share('cg-iso-1', [{
      subject: 'urn:test:i1b', predicate: 'http://schema.org/name', object: '"c"', graph: '',
    }]);

    const stats = agent.getSwmSubstrateFanoutStats();
    expect(stats.delivered).toEqual({
      'cg-iso-1': 2,
      'cg-iso-2': 1,
    });
  });
});
