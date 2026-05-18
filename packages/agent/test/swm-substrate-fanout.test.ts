import { describe, it, expect } from 'vitest';
import {
  chooseFanOutTier,
  executeSubstrateFanOut,
  type FanOutBookkeeper,
  type FanOutPeerRecord,
  type FanOutSubstrate,
} from '../src/swm/substrate-fanout.js';
import type { CGMemberEnumeration } from '../src/swm/enumerate-cg-members.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

function makeBookkeeper(): { calls: Array<{ cgId: string; record: FanOutPeerRecord }>; bk: FanOutBookkeeper } {
  const calls: Array<{ cgId: string; record: FanOutPeerRecord }> = [];
  return {
    calls,
    bk: {
      recordOutcome(cgId, record) { calls.push({ cgId, record }); },
    },
  };
}

function enumeration(source: CGMemberEnumeration['source'], members: string[]): CGMemberEnumeration {
  return { source, members };
}

describe('chooseFanOutTier', () => {
  /**
   * Curated CGs are the headline win for substrate fan-out:
   * authoritative roster, every member is by definition allowed
   * to receive the share, so substrate-only is both reliable
   * (point-to-point ack within the messenger SLO) AND saves the
   * gossip wire load. We deliberately do NOT truncate curated
   * CGs even when they exceed `maxSubstrateMembers` — see the
   * `chooseFanOutTier` jsdoc for why dropping substrate targets
   * silently regresses curated reliability.
   */
  describe('curated CG (source = allowlist)', () => {
    it('substrate-only for any curated CG, even at or above the threshold', () => {
      const plan = chooseFanOutTier({
        enumeration: enumeration('allowlist', ['peerA', 'peerB', 'peerC']),
        maxSubstrateMembers: 100,
      });

      expect(plan.useSubstrate).toBe(true);
      expect(plan.useGossip).toBe(false);
      expect(plan.substrateMembers).toEqual(['peerA', 'peerB', 'peerC']);
      expect(plan.enumerationSource).toBe('allowlist');
      expect(plan.enumeratedCount).toBe(3);
    });

    it('does NOT truncate curated members above the threshold', () => {
      const members = Array.from({ length: 250 }, (_, i) => `peer${i}`);
      const plan = chooseFanOutTier({
        enumeration: enumeration('allowlist', members),
        maxSubstrateMembers: 100,
      });

      expect(plan.useSubstrate).toBe(true);
      expect(plan.useGossip).toBe(false);
      expect(plan.substrateMembers).toEqual(members);
      expect(plan.enumeratedCount).toBe(250);
    });

    it('handles the curated-with-empty-allowlist edge case (curator kicked everyone)', () => {
      // CGMemberEnumerator returns `{ source: 'allowlist', members: [] }`
      // for a curated CG with an explicitly empty allowlist (NOT to be
      // re-admitted via gossip subscribers). Substrate fan-out has
      // nobody to send to; gossip remains OFF. Caller's local apply
      // already happened; nothing more to do.
      const plan = chooseFanOutTier({
        enumeration: enumeration('allowlist', []),
        maxSubstrateMembers: 100,
      });

      expect(plan.useSubstrate).toBe(true);
      expect(plan.useGossip).toBe(false);
      expect(plan.substrateMembers).toEqual([]);
    });
  });

  /**
   * Public CGs use the gossip topic as the canonical transport
   * (catches latecomer subscribers we don't see yet), with
   * substrate as a top-up for the known subscriber set when small
   * enough to be affordable.
   */
  describe('public CG (source = topic-subscribers)', () => {
    it('substrate + gossip for public CG at or below the threshold', () => {
      const plan = chooseFanOutTier({
        enumeration: enumeration('topic-subscribers', ['peerA', 'peerB']),
        maxSubstrateMembers: 100,
      });

      expect(plan.useSubstrate).toBe(true);
      expect(plan.useGossip).toBe(true);
      expect(plan.substrateMembers).toEqual(['peerA', 'peerB']);
      expect(plan.enumerationSource).toBe('topic-subscribers');
      expect(plan.enumeratedCount).toBe(2);
    });

    it('substrate + gossip exactly AT the threshold (boundary)', () => {
      const members = Array.from({ length: 100 }, (_, i) => `peer${i}`);
      const plan = chooseFanOutTier({
        enumeration: enumeration('topic-subscribers', members),
        maxSubstrateMembers: 100,
      });

      expect(plan.useSubstrate).toBe(true);
      expect(plan.substrateMembers).toEqual(members);
    });

    it('gossip-only for public CG above the threshold', () => {
      const members = Array.from({ length: 101 }, (_, i) => `peer${i}`);
      const plan = chooseFanOutTier({
        enumeration: enumeration('topic-subscribers', members),
        maxSubstrateMembers: 100,
      });

      expect(plan.useSubstrate).toBe(false);
      expect(plan.useGossip).toBe(true);
      expect(plan.substrateMembers).toEqual([]);
      // `enumeratedCount` preserves the pre-truncation count so
      // the caller's WARN log can show "gossip-only because
      // 101 > 100".
      expect(plan.enumeratedCount).toBe(101);
    });
  });

  /**
   * `none` covers two distinct semantic cases collapsed into the
   * same wire behaviour (gossip-only): legacy/bootstrap CGs with
   * no live subscribers yet, AND agent-gated private CGs without
   * an enumerable peer allowlist (which fail closed in
   * CGMemberEnumerator, see enumerate-cg-members.ts bug fix #1).
   * Both end up here for the same reason — we have no roster to
   * substrate-fan-out to. Gossip is safe in both: receiver-side
   * auth gate (`isPrivateContextGraph`) drops payloads at the
   * apply layer for private CGs, and the SWM payload is encrypted
   * with the per-CG key anyway.
   */
  describe('legacy / agent-gated CG (source = none)', () => {
    it('gossip-only with empty substrate set', () => {
      const plan = chooseFanOutTier({
        enumeration: enumeration('none', []),
        maxSubstrateMembers: 100,
      });

      expect(plan.useSubstrate).toBe(false);
      expect(plan.useGossip).toBe(true);
      expect(plan.substrateMembers).toEqual([]);
      expect(plan.enumeratedCount).toBe(0);
    });
  });
});

describe('executeSubstrateFanOut', () => {
  const PROTOCOL = '/dkg/10.0.1/swm-update';

  function fakeSubstrate(per: (peerId: string) => ReliableSendResult | Error): FanOutSubstrate {
    return {
      async sendReliable(peerId: string) {
        const out = per(peerId);
        if (out instanceof Error) throw out;
        return out;
      },
    };
  }

  it('returns zero counts and skips the bookkeeper when members is empty', async () => {
    const { calls, bk } = makeBookkeeper();
    const result = await executeSubstrateFanOut({
      contextGraphId: 'cg-empty',
      protocolId: PROTOCOL,
      payload: new Uint8Array([1]),
      members: [],
      sendTimeoutMs: 5000,
      substrate: fakeSubstrate(() => ({ delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mid' })),
      bookkeeper: bk,
    });

    expect(result).toEqual({ attempted: 0, delivered: 0, queued: 0, inFlight: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  it('classifies delivered / queued / inFlight / failed across a mixed fan-out', async () => {
    const { calls, bk } = makeBookkeeper();
    const result = await executeSubstrateFanOut({
      contextGraphId: 'cg-mixed',
      protocolId: PROTOCOL,
      payload: new Uint8Array([1, 2, 3]),
      members: ['peerOK', 'peerQueued', 'peerInFlight', 'peerSyncThrow', 'peerHardFail'],
      sendTimeoutMs: 5000,
      substrate: fakeSubstrate((peerId): ReliableSendResult | Error => {
        switch (peerId) {
          case 'peerOK':
            return { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'm-ok' };
          case 'peerQueued':
            return {
              delivered: false,
              queued: true,
              attempts: 2,
              messageId: 'm-q',
              error: 'transient backoff',
              nextAttemptAtMs: 12345,
            };
          case 'peerInFlight':
            return {
              delivered: false,
              queued: false,
              inFlight: true,
              attempts: 0,
              messageId: 'm-if',
              error: 'already in flight',
            };
          case 'peerSyncThrow':
            return new Error('invalid peerId format');
          case 'peerHardFail':
            // A future variant of ReliableSendResult would also land
            // in `failed` via the defensive classifier branch — but
            // exercising the unrecoverable case via the
            // `inFlight: false, queued: false` shape is impossible
            // today because the union doesn't admit that combo.
            // Synchronous throw is the production-shaped "failed".
            return new Error('messenger gone');
          default:
            throw new Error('unreachable');
        }
      }),
      bookkeeper: bk,
    });

    expect(result.attempted).toBe(5);
    expect(result.delivered).toBe(1);
    expect(result.queued).toBe(1);
    expect(result.inFlight).toBe(1);
    expect(result.failed).toBe(2);

    expect(calls).toHaveLength(5);
    const byPeer = new Map(calls.map(c => [c.record.peerId, c.record]));
    expect(byPeer.get('peerOK')).toEqual({
      peerId: 'peerOK', outcome: 'delivered', attempts: 1, messageId: 'm-ok', error: '',
    });
    expect(byPeer.get('peerQueued')).toEqual({
      peerId: 'peerQueued', outcome: 'queued', attempts: 2, messageId: 'm-q', error: 'transient backoff',
    });
    expect(byPeer.get('peerInFlight')).toEqual({
      peerId: 'peerInFlight', outcome: 'inFlight', attempts: 0, messageId: 'm-if', error: 'already in flight',
    });
    expect(byPeer.get('peerSyncThrow')).toEqual({
      peerId: 'peerSyncThrow', outcome: 'failed', attempts: 0, messageId: '', error: 'invalid peerId format',
    });
    expect(byPeer.get('peerHardFail')).toEqual({
      peerId: 'peerHardFail', outcome: 'failed', attempts: 0, messageId: '', error: 'messenger gone',
    });

    // Every record was associated with the right cgId.
    expect(calls.every(c => c.cgId === 'cg-mixed')).toBe(true);
  });

  /**
   * A synchronous throw from sendReliable for one peer MUST NOT
   * abort the fan-out — the other peers must still get their
   * sends. This is what `Promise.allSettled` buys us over
   * `Promise.all` (see substrate-fanout.ts jsdoc), and the
   * try/catch inside the per-peer task makes it explicit.
   */
  it('one peer throwing synchronously does not abort the rest', async () => {
    const { calls, bk } = makeBookkeeper();
    const result = await executeSubstrateFanOut({
      contextGraphId: 'cg-isolation',
      protocolId: PROTOCOL,
      payload: new Uint8Array([9]),
      members: ['ok1', 'boom', 'ok2', 'ok3'],
      sendTimeoutMs: 5000,
      substrate: fakeSubstrate((peerId): ReliableSendResult | Error => {
        if (peerId === 'boom') return new Error('intentional');
        return { delivered: true, response: new Uint8Array(), attempts: 1, messageId: `m-${peerId}` };
      }),
      bookkeeper: bk,
    });

    expect(result).toEqual({ attempted: 4, delivered: 3, queued: 0, inFlight: 0, failed: 1 });
    expect(calls).toHaveLength(4);
  });

  /**
   * Sends MUST run in parallel — sequential execution would
   * pay (sum of per-peer latencies) wall-clock and tail-latency
   * the entire share through the slowest single peer. We assert
   * this by stalling each send on a manually-resolved promise
   * for ~20ms and verifying the total wall-clock is closer to
   * one stall than to N stalls.
   *
   * Uses a small absolute budget (rather than fake timers) so
   * this also exercises the real Promise.allSettled scheduling.
   */
  it('fires sends in PARALLEL, not sequentially', async () => {
    const { bk } = makeBookkeeper();
    const PER_PEER_STALL_MS = 20;
    const MEMBERS = 8;

    const t0 = Date.now();
    const result = await executeSubstrateFanOut({
      contextGraphId: 'cg-parallel',
      protocolId: PROTOCOL,
      payload: new Uint8Array([0]),
      members: Array.from({ length: MEMBERS }, (_, i) => `peer${i}`),
      sendTimeoutMs: 5000,
      substrate: {
        async sendReliable(peerId): Promise<ReliableSendResult> {
          await new Promise<void>((res) => setTimeout(res, PER_PEER_STALL_MS));
          return { delivered: true, response: new Uint8Array(), attempts: 1, messageId: `m-${peerId}` };
        },
      },
      bookkeeper: bk,
    });
    const elapsed = Date.now() - t0;

    expect(result.delivered).toBe(MEMBERS);
    // Sequential would be ~MEMBERS * PER_PEER_STALL_MS = ~160ms.
    // Parallel should be ~PER_PEER_STALL_MS = ~20ms. Loose bound
    // (3x the per-peer stall) to avoid CI flakes from scheduler
    // jitter on heavily loaded runners; still leaves plenty of
    // margin to detect a regression to sequential execution.
    expect(elapsed).toBeLessThan(PER_PEER_STALL_MS * 3);
    expect(elapsed).toBeLessThan(MEMBERS * PER_PEER_STALL_MS / 2);
  });
});
