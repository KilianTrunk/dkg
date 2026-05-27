/**
 * PR #716 audit cluster B.4 — Random Sampling prover's curated-path
 * `ciphertextChunkBackfill` orchestrator (`buildCiphertextChunkBackfill`,
 * `packages/agent/src/dkg-agent.ts:11221-11299`).
 *
 * Background:
 *   - OT-RFC-39 wires the prover into the agent via `bindRandomSampling`
 *     (`packages/agent/src/dkg-agent.ts:2832-2870`). The agent supplies a
 *     `ciphertextChunkBackfill` closure that the prover invokes whenever
 *     `extractCiphertextChunksFromStore` reports a
 *     `CiphertextChunksMissingError` (the "late-join" path — this core
 *     missed the curator's chunked publish).
 *   - The closure is `buildCiphertextChunkBackfill(ctx)`. Its job:
 *       1. Resolve the prover's numeric on-chain `cgId` to the local
 *          cleartext id via `resolveLocalCgIdByOnChainId`. If unknown
 *          (chain-event race window), short-circuit with
 *          `reason: 'cg-not-locally-registered'`.
 *       2. Fetch the workspace topic subscribers via
 *          `gossip.getSubscribers(contextGraphWorkspaceTopic(wireId))`,
 *          excluding self. If empty, return `reason: 'no-peers'`.
 *       3. For every missing chunk index, iterate peers and call
 *          `fetchCiphertextChunkFromPeer(peer, localCgId, batchId, idx,
 *          {persist: true})`. Skip on `denied`, break on success.
 *       4. Aggregate the per-chunk fetched/failed counts and the last
 *          `denied` reason for the prover's telemetry.
 *
 * Audit gap:
 *   - The function's individual building blocks
 *     (`fetchCiphertextChunkFromPeer`,
 *     `resolveLocalCgIdByOnChainId`, `gossipWireIdFor`) all have direct
 *     coverage via PR #742 and other tests. But the ORCHESTRATION layer
 *     — peer iteration, self-exclusion, denied/error classification,
 *     aggregation — had zero direct coverage. A refactor that flips the
 *     `continue`/`break` semantics or drops the self-filter would
 *     silently break the late-join contract.
 *
 * Scope of this file:
 *   - Pins the 6 return shapes (`fetched=N/failures=0`,
 *     `cg-not-locally-registered`, `no-peers`, mixed
 *     fetched/failures, `all-denied: <reason>`, `no-responders`).
 *   - Pins self-exclusion (the local peerId must NEVER be in the
 *     candidate set).
 *   - Pins the iteration policy: a denied peer falls through to the
 *     next peer for the SAME chunk; a successful peer ends the
 *     per-chunk inner loop and we move to the next chunk.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  contextGraphWorkspaceTopic,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import {
  CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
  encodeCiphertextChunkCatchupResponse,
} from '../src/swm/ciphertext-chunk-catchup.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

/**
 * `buildCiphertextChunkBackfill(ctx)` is private; cast through to a
 * thin interface that exposes exactly what the test needs to drive
 * it. The closure shape it returns matches the prover's
 * `CiphertextChunkBackfillFn` contract:
 *
 *   (req: { cgId: bigint; batchId: Uint8Array; missingIndexes: number[] })
 *     => Promise<{ fetched: number; failures: number; reason?: string }>
 */
type BackfillFn = (req: {
  cgId: bigint;
  batchId: Uint8Array;
  missingIndexes: number[];
}) => Promise<{ fetched: number; failures: number; reason?: string }>;

/** Constant the test always treats as "the local agent's peerId". */
const SELF_PEER = '12D3KooWStubSelfPeerForBackfillTest';

interface BackfillInternals {
  buildCiphertextChunkBackfill(ctx: ReturnType<typeof createOperationContext>): BackfillFn;
  subscribedContextGraphs: Map<string, { onChainId?: string; onChainHash?: string; subscribed?: boolean; synced?: boolean }>;
  gossipWireIdFor(rawId: string): string;
  messenger?: { sendReliable: (peerId: string, protocol: string, payload: Uint8Array) => Promise<ReliableSendResult> };
  gossip: { getSubscribers(topic: string): string[] };
  node: { peerId: string };
}

async function bootBackfillAgent(): Promise<{ agent: DKGAgent; internals: BackfillInternals; backfill: BackfillFn; ctx: ReturnType<typeof createOperationContext> }> {
  const chain = new MockChainAdapter();
  chain.setMockACKSigner(ethers.Wallet.createRandom());
  const agent = await DKGAgent.create({
    name: 'BackfillOrchestrationTest',
    chainAdapter: chain,
  });
  const internals = agent as unknown as BackfillInternals;
  const ctx = createOperationContext('share');
  // Replace the gossip layer with a stub. The closure only calls
  // `getSubscribers(topic)` on it; setting just that method is
  // sufficient for every code path under test.
  internals.gossip = { getSubscribers: () => [] };
  // The agent's `peerId` getter delegates `this.node.peerId`. In
  // production `node` is a `DKGNode` instance whose `peerId` getter
  // returns a string. Mirror that shape here so the closure's
  // `p !== selfPeer` strict-equality filter actually fires.
  (internals as unknown as { node: { peerId: string } }).node = { peerId: SELF_PEER };
  const backfill = internals.buildCiphertextChunkBackfill(ctx);
  return { agent, internals, backfill, ctx };
}

/**
 * Set up the agent so `resolveLocalCgIdByOnChainId(cgId)` resolves
 * to `localCgId`. Mirrors what the chain-event subscribe handler
 * does in production.
 */
function registerLocalCg(
  internals: BackfillInternals,
  opts: { localCgId: string; onChainId: bigint },
): { wireId: string; workspaceTopic: string } {
  internals.subscribedContextGraphs.set(opts.localCgId, {
    onChainId: opts.onChainId.toString(),
    subscribed: true,
    synced: true,
  });
  const wireId = internals.gossipWireIdFor(opts.localCgId);
  const workspaceTopic = contextGraphWorkspaceTopic(wireId);
  return { wireId, workspaceTopic };
}

function stubSubscribers(internals: BackfillInternals, byTopic: Map<string, string[]>): void {
  internals.gossip.getSubscribers = (topic: string) => byTopic.get(topic) ?? [];
}

type PerCallResult = ReliableSendResult;

function stubMessengerSequence(
  internals: BackfillInternals,
  resultFor: (peerId: string, callOrdinal: number) => PerCallResult,
): { calls: { peer: string; protocol: string }[] } {
  const calls: { peer: string; protocol: string }[] = [];
  internals.messenger = {
    sendReliable: async (peer: string, protocol: string, _payload: Uint8Array): Promise<PerCallResult> => {
      const ordinal = calls.length;
      calls.push({ peer, protocol });
      return resultFor(peer, ordinal);
    },
  };
  return { calls };
}

/**
 * Build the wire-shape response a peer's responder would emit.
 * Matches what `decodeCiphertextChunkCatchupResponse` expects.
 */
function ackBytes(opts: {
  contextGraphId: string;
  batchId: Uint8Array;
  chunkIndex: number;
  ciphertextB64?: string;
  denied?: string;
}): Uint8Array {
  return encodeCiphertextChunkCatchupResponse({
    version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
    contextGraphId: opts.contextGraphId,
    batchIdHex: ethers.hexlify(opts.batchId),
    chunkIndex: opts.chunkIndex,
    ...(opts.ciphertextB64 !== undefined ? { ciphertextB64: opts.ciphertextB64 } : {}),
    ...(opts.denied !== undefined ? { denied: opts.denied } : {}),
  });
}

describe('DKGAgent.buildCiphertextChunkBackfill — prover-side backfill orchestration (LU-11 / OT-RFC-39)', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it('cg-not-locally-registered: numeric on-chain cgId with no local mapping short-circuits without fetching', async () => {
    // The transient race window when a tick fires before the
    // chain-event handler has populated `subscribedContextGraphs`.
    // Must surface `cg-not-locally-registered` so the prover logs
    // `kc-not-synced` and re-ticks.
    const boot = await bootBackfillAgent();
    agent = boot.agent;

    const { calls } = stubMessengerSequence(boot.internals, () => {
      throw new Error('messenger MUST NOT be invoked when the cgId is unknown');
    });

    const result = await boot.backfill({
      cgId: 999_999_999n,
      batchId: ethers.getBytes(ethers.id('cg-unknown-batch')),
      missingIndexes: [0, 1, 2],
    });

    expect(result).toEqual({
      fetched: 0,
      failures: 3,
      reason: 'cg-not-locally-registered',
    });
    expect(calls).toEqual([]);
  });

  it('no-peers: known cgId but workspace topic has zero subscribers (after self-exclusion) returns no-peers', async () => {
    const boot = await bootBackfillAgent();
    agent = boot.agent;

    const onChainId = 42n;
    const localCgId = 'cg-no-peers';
    const { workspaceTopic } = registerLocalCg(boot.internals, { localCgId, onChainId });

    // Topic has only OUR OWN peerId — that gets filtered out, so no
    // candidates remain.
    stubSubscribers(boot.internals, new Map([[workspaceTopic, [SELF_PEER]]]));

    const { calls } = stubMessengerSequence(boot.internals, () => {
      throw new Error('messenger MUST NOT be invoked when no peers are available');
    });

    const result = await boot.backfill({
      cgId: onChainId,
      batchId: ethers.getBytes(ethers.id('no-peers-batch')),
      missingIndexes: [5],
    });

    expect(result).toEqual({
      fetched: 0,
      failures: 1,
      reason: 'no-peers',
    });
    expect(calls).toEqual([]);
  });

  it('happy path: one peer answers every chunk → returns fetched=N, failures=0, no reason', async () => {
    const boot = await bootBackfillAgent();
    agent = boot.agent;

    const onChainId = 1234n;
    const localCgId = 'cg-happy';
    const { workspaceTopic } = registerLocalCg(boot.internals, { localCgId, onChainId });

    const peerA = '12D3KooWFakePeerHappyA';
    stubSubscribers(boot.internals, new Map([[workspaceTopic, [peerA]]]));

    const batchId = ethers.getBytes(ethers.id('happy-batch'));
    const { calls } = stubMessengerSequence(boot.internals, (_peer, callOrdinal) => ({
      delivered: true,
      response: ackBytes({
        contextGraphId: localCgId,
        batchId,
        chunkIndex: callOrdinal,
        ciphertextB64: Buffer.from(`chunk-${callOrdinal}`).toString('base64'),
      }),
      attempts: 1,
      messageId: `m-${callOrdinal}`,
    }));

    const result = await boot.backfill({
      cgId: onChainId,
      batchId,
      missingIndexes: [0, 1, 2],
    });

    expect(result).toEqual({ fetched: 3, failures: 0 });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.peer === peerA)).toBe(true);
  });

  it('partial success: 2-of-3 chunks land, third has no responder → fetched=2, failures=1, no aggregated reason (mixed result has no single cause)', async () => {
    const boot = await bootBackfillAgent();
    agent = boot.agent;

    const onChainId = 555n;
    const localCgId = 'cg-partial';
    const { workspaceTopic } = registerLocalCg(boot.internals, { localCgId, onChainId });
    const peerA = '12D3KooWFakePeerPartialA';
    stubSubscribers(boot.internals, new Map([[workspaceTopic, [peerA]]]));

    const batchId = ethers.getBytes(ethers.id('partial-batch'));
    // Chunks 0 and 1 land; chunk 2 throws (peer unreachable) →
    // failure recorded. Reason field MUST be absent because the
    // mixed result has no single dominant cause (the
    // `failures > 0 && fetched === 0` predicate gates `reason`).
    stubMessengerSequence(boot.internals, (_peer, callOrdinal) => {
      if (callOrdinal < 2) {
        return {
          delivered: true,
          response: ackBytes({
            contextGraphId: localCgId,
            batchId,
            chunkIndex: callOrdinal,
            ciphertextB64: Buffer.from(`chunk-${callOrdinal}`).toString('base64'),
          }),
          attempts: 1,
          messageId: `m-${callOrdinal}`,
        };
      }
      return {
        delivered: false,
        queued: false,
        attempts: 3,
        messageId: `m-${callOrdinal}-fail`,
        error: 'peer-disconnected',
      };
    });

    const result = await boot.backfill({
      cgId: onChainId,
      batchId,
      missingIndexes: [0, 1, 2],
    });

    expect(result.fetched).toBe(2);
    expect(result.failures).toBe(1);
    expect(result.reason).toBeUndefined();
  });

  it('all-denied: every peer denies every chunk → returns reason "all-denied: <last denied reason>"', async () => {
    const boot = await bootBackfillAgent();
    agent = boot.agent;

    const onChainId = 7n;
    const localCgId = 'cg-all-denied';
    const { workspaceTopic } = registerLocalCg(boot.internals, { localCgId, onChainId });

    const peerA = '12D3KooWFakePeerDenyA';
    const peerB = '12D3KooWFakePeerDenyB';
    stubSubscribers(boot.internals, new Map([[workspaceTopic, [peerA, peerB]]]));

    const batchId = ethers.getBytes(ethers.id('all-denied-batch'));
    // Both peers say "denied" with distinguishable reasons so we
    // can confirm the LAST one is surfaced (the closure overwrites
    // `lastDenied` on each denial — operators see the most recent
    // root cause, which on a homogeneous fleet is usually the
    // representative one).
    stubMessengerSequence(boot.internals, (peer) => {
      const reason = peer === peerA ? 'peer-not-in-agent-allowlist' : 'peer-rate-limited';
      return {
        delivered: true,
        response: ackBytes({
          contextGraphId: localCgId,
          batchId,
          chunkIndex: 0,
          denied: reason,
        }),
        attempts: 1,
        messageId: 'm-denied',
      };
    });

    const result = await boot.backfill({
      cgId: onChainId,
      batchId,
      missingIndexes: [0],
    });

    expect(result.fetched).toBe(0);
    expect(result.failures).toBe(1);
    // Reason is `all-denied: <lastDeniedReason>` — at least one
    // peer's denial reason MUST surface. We don't pin a specific
    // peer ordering because the closure iterates the candidate
    // set in insertion order (Set-from-Array preserves order), but
    // pinning a specific peer would entangle this test with an
    // unrelated implementation detail.
    expect(result.reason).toMatch(/^all-denied: (peer-not-in-agent-allowlist|peer-rate-limited)$/);
  });

  it('all-errored (no denied, all transport failures): returns reason "no-responders"', async () => {
    const boot = await bootBackfillAgent();
    agent = boot.agent;

    const onChainId = 99n;
    const localCgId = 'cg-all-errored';
    const { workspaceTopic } = registerLocalCg(boot.internals, { localCgId, onChainId });

    const peerA = '12D3KooWFakePeerErrA';
    const peerB = '12D3KooWFakePeerErrB';
    stubSubscribers(boot.internals, new Map([[workspaceTopic, [peerA, peerB]]]));

    const batchId = ethers.getBytes(ethers.id('all-errored-batch'));
    stubMessengerSequence(boot.internals, () => ({
      delivered: false,
      queued: false,
      attempts: 3,
      messageId: 'm-transport-fail',
      error: 'peer-unreachable',
    }));

    const result = await boot.backfill({
      cgId: onChainId,
      batchId,
      missingIndexes: [0],
    });

    expect(result.fetched).toBe(0);
    expect(result.failures).toBe(1);
    // No denied responses, only transport errors → "no-responders"
    // gets the operator's attention as "the network couldn't even
    // give me an ACK", different from "I was authoritatively told no".
    expect(result.reason).toBe('no-responders');
  });

  it('per-chunk peer iteration: first peer denies → fall through to next peer for the SAME chunk; second peer succeeds → no failure recorded', async () => {
    // The inner peer loop semantics are critical: a `denied` ACK
    // MUST NOT mark the chunk as fetched, and MUST NOT count as a
    // failure either — it just continues to the next peer. Only
    // after exhausting every peer for a chunk do we tally the
    // failure. This pins both halves: per-chunk fall-through on
    // denial, and successful inner-loop short-circuit on the second
    // peer.
    const boot = await bootBackfillAgent();
    agent = boot.agent;

    const onChainId = 333n;
    const localCgId = 'cg-fallthrough';
    const { workspaceTopic } = registerLocalCg(boot.internals, { localCgId, onChainId });

    const peerA = '12D3KooWFakePeerFallthroughA';
    const peerB = '12D3KooWFakePeerFallthroughB';
    stubSubscribers(boot.internals, new Map([[workspaceTopic, [peerA, peerB]]]));

    const batchId = ethers.getBytes(ethers.id('fallthrough-batch'));
    const { calls } = stubMessengerSequence(boot.internals, (peer) => {
      if (peer === peerA) {
        return {
          delivered: true,
          response: ackBytes({
            contextGraphId: localCgId,
            batchId,
            chunkIndex: 0,
            denied: 'not-in-allowlist-for-this-peer',
          }),
          attempts: 1,
          messageId: 'm-A-denied',
        };
      }
      return {
        delivered: true,
        response: ackBytes({
          contextGraphId: localCgId,
          batchId,
          chunkIndex: 0,
          ciphertextB64: Buffer.from('chunk-0-from-B').toString('base64'),
        }),
        attempts: 1,
        messageId: 'm-B-success',
      };
    });

    const result = await boot.backfill({
      cgId: onChainId,
      batchId,
      missingIndexes: [0],
    });

    expect(result).toEqual({ fetched: 1, failures: 0 });
    // BOTH peers were contacted — peerA denied, peerB delivered.
    // If the loop had `break`ed on denial we'd only see peerA.
    // If it had `break`ed before peerA finished we'd only see peerB.
    expect(calls.map((c) => c.peer)).toEqual([peerA, peerB]);
  });

  it('self-exclusion: local peerId is filtered out of candidates even when subscribed to its own topic', async () => {
    // The closure does `filter((p) => p && p !== selfPeer)` because
    // GossipSub's `getSubscribers` includes the local node when the
    // local node has subscribed. Without the filter the prover
    // would try to fetch its own chunks from itself — guaranteed
    // failure mode that wastes a slot in the candidate set and
    // muddles the telemetry.
    const boot = await bootBackfillAgent();
    agent = boot.agent;

    const onChainId = 88n;
    const localCgId = 'cg-self-exclusion';
    const { workspaceTopic } = registerLocalCg(boot.internals, { localCgId, onChainId });

    const otherPeer = '12D3KooWFakeOtherPeer';
    stubSubscribers(boot.internals, new Map([[workspaceTopic, [SELF_PEER, otherPeer]]]));

    const batchId = ethers.getBytes(ethers.id('self-exclusion-batch'));
    const { calls } = stubMessengerSequence(boot.internals, (_peer) => ({
      delivered: true,
      response: ackBytes({
        contextGraphId: localCgId,
        batchId,
        chunkIndex: 0,
        ciphertextB64: Buffer.from('chunk-0-from-other').toString('base64'),
      }),
      attempts: 1,
      messageId: 'm-other',
    }));

    const result = await boot.backfill({
      cgId: onChainId,
      batchId,
      missingIndexes: [0],
    });

    expect(result).toEqual({ fetched: 1, failures: 0 });
    // ONLY the non-self peer was contacted.
    expect(calls.map((c) => c.peer)).toEqual([otherPeer]);
  });

  it('zero missing indexes: fast short-circuit with fetched=0/failures=0/no reason and no messenger calls', async () => {
    // Defense against the prover passing in an empty list (e.g.
    // after a partial backfill that completed every gap). The
    // closure must not invoke `getSubscribers` either — the early
    // return is BEFORE the topic resolution.
    const boot = await bootBackfillAgent();
    agent = boot.agent;

    let getSubscribersCalls = 0;
    boot.internals.gossip.getSubscribers = (topic: string) => {
      getSubscribersCalls++;
      return [topic];
    };
    const { calls } = stubMessengerSequence(boot.internals, () => {
      throw new Error('messenger MUST NOT be invoked when there are zero missing indexes');
    });

    const result = await boot.backfill({
      cgId: 1n,
      batchId: ethers.getBytes(ethers.id('zero-indexes-batch')),
      missingIndexes: [],
    });

    expect(result).toEqual({ fetched: 0, failures: 0 });
    expect(getSubscribersCalls).toBe(0);
    expect(calls).toEqual([]);
  });
});
