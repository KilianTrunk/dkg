// PR-1 latency pin: `createAndDistributeSwmSenderKeyEpoch` must fan out to
// all recipients in parallel.
//
// Pre-rc.12 the function awaited each `messenger.sendReliable` sequentially
// inside a `for (const recipient of input.recipients)` loop. With the
// per-send timeout floor at 20 s and a quorum of 5+ keys, foreground
// publish latency scaled to ~minutes when any one recipient stalled. We
// now wrap every per-recipient closure in `Promise.allSettled`, so the
// wall-clock cost is bounded by the slowest individual send rather than
// the sum of all sends.
//
// This test pins the parallelism by injecting a fake messenger whose
// `sendReliable` sleeps a controllable amount, then asserting that the
// total elapsed time for N recipients is closer to one slot than to N.
//
// Failure mode this catches: a future refactor that re-introduces an
// `await` inside the loop (e.g. "we need to read X synchronously before
// the next send"). The latency assertion is generous on purpose — CI
// jitter makes tight wall-clock bounds flaky — but the gap between
// "parallel" and "serial" is 6x for N=6, well outside any reasonable
// noise floor.

import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  encodeSwmSenderKeyPackageAck,
  generateWorkspaceRecipientEncryptionKey,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  DKGAgent,
  agentFromPrivateKey,
  type AgentKeyRecord,
} from '../src/index.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

// The fanout function lives on the agent class but is `private`. The
// existing swm-sender-key-stale-target test reaches it via the same
// `as unknown as` cast pattern; we mirror that here. `messenger` is
// public on the agent but only populated by `start()`, which spins
// the full libp2p stack — heavier than this unit test needs. We
// inject a fake messenger directly into the field instead.
type StubMessenger = {
  sendReliable: (
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
  ) => Promise<ReliableSendResult>;
};
interface FanoutInternals {
  messenger: StubMessenger;
  node: { peerId: { toString(): string } };
  createAndDistributeSwmSenderKeyEpoch(input: {
    contextGraphId: string;
    subGraphName?: string;
    sender: AgentKeyRecord & { privateKey: string };
    recipients: readonly FakeRecipient[];
    membershipHash: string;
    ctx: OperationContext;
  }): Promise<unknown>;
}

interface FakeRecipient {
  agentAddress: string;
  peerId?: string;
  recipientKeyId: string;
  recipientId: string;
  purpose: typeof WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE;
  encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  publicKeyBytes: Uint8Array;
}

function makeFakeRecipient(): FakeRecipient {
  const wallet = ethers.Wallet.createRandom();
  const agentAddress = wallet.address;
  const recipientId = `did:dkg:agent:${agentAddress.toLowerCase()}`;
  const recipientKeyId = `${recipientId}#x25519-${ethers.id(wallet.privateKey).slice(2, 34)}`;
  const key = generateWorkspaceRecipientEncryptionKey(recipientId, recipientKeyId);
  return {
    agentAddress,
    peerId: `12D3KooWFakeTestPeer${ethers.id(agentAddress).slice(2, 18)}`,
    recipientKeyId,
    recipientId,
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes: key.publicKeyBytes!,
  };
}

function installStubMessenger(
  internals: FanoutInternals,
  sendReliable: StubMessenger['sendReliable'],
): void {
  internals.messenger = { sendReliable };
  // `node.peerId.toString()` is referenced when the recipient happens
  // to be the local agent (fan-in branch); our fakeRecipients never
  // are, but the field is read on every call so keep it defined.
  if (!internals.node) {
    (internals as { node: { peerId: { toString(): string } } }).node = {
      peerId: { toString: () => '12D3KooWStubLocalPeerForFanoutTest' },
    };
  }
}

async function bootAgent(): Promise<{ agent: DKGAgent; internals: FanoutInternals }> {
  const agent = await DKGAgent.create({
    name: 'FanoutLatencyTest',
    chainAdapter: new MockChainAdapter(),
  });
  const internals = agent as unknown as FanoutInternals;
  return { agent, internals };
}

describe('createAndDistributeSwmSenderKeyEpoch: parallel fanout latency', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it('fans out concurrently (N recipients ≈ one slot, not N slots)', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const N = 6;
    const SEND_DELAY_MS = 200;

    // Inject a stub messenger whose `sendReliable` sleeps SEND_DELAY_MS
    // then returns an "accepted" ack. We bypass `agent.start()` to keep
    // the test free of libp2p plumbing — the fanout function only needs
    // the messenger surface to fire each recipient send.
    installStubMessenger(internals, async (): Promise<ReliableSendResult> => {
      await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
      const ack = encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: true,
      });
      return { delivered: true, response: ack, attempts: 1, messageId: 'm-test' };
    });

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    const recipients = Array.from({ length: N }, makeFakeRecipient);
    const start = Date.now();
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/fanout-latency',
      sender,
      recipients,
      membershipHash: 'sha256:fanout-latency-test',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    const elapsed = Date.now() - start;

    // Parallel: ~SEND_DELAY_MS. Serial: ~N * SEND_DELAY_MS.
    // Pick a threshold roughly halfway through that gap, biased toward
    // the parallel side to leave headroom for CI scheduler jitter +
    // ack-encoding cost. With SEND_DELAY=200ms and N=6, the gap is
    // 200ms (parallel) vs 1200ms (serial); 600ms reliably distinguishes
    // them while accommodating slow runners.
    const PARALLEL_BUDGET_MS = SEND_DELAY_MS * 3;
    expect(elapsed).toBeLessThan(PARALLEL_BUDGET_MS);
  });

  it('aggregates per-recipient hard failures into a single throw', async () => {
    // Sanity check on the post-settle aggregation: when EVERY key for
    // an agent fails (here the messenger always returns an "accepted=false"
    // ack), we must surface a fatal-agents throw rather than silently
    // returning a state. This pins the existing C2 contract through the
    // new aggregation path.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async (): Promise<ReliableSendResult> => {
      const ack = encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: false,
        reason: 'bad membership hash',
      });
      return { delivered: true, response: ack, attempts: 1, messageId: 'm-test' };
    });

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    const recipients = [makeFakeRecipient(), makeFakeRecipient()];
    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/fanout-fatal',
        sender,
        recipients,
        membershipHash: 'sha256:fanout-fatal',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).rejects.toThrow(/SWM Sender Key setup rejected by 2 agent\(s\)/);
  });

  it('classifies delivered=false as soft success (no throw)', async () => {
    // Soft-success contract: when messenger.sendReliable returns
    // `delivered: false, queued: true`, the recipient is durably queued
    // and the publish must proceed. Pre-PR-1 the per-iteration `continue`
    // already implemented this; the new Promise.allSettled flow keeps
    // it via the `return { kind: 'success' }` branch inside the
    // delivered=false handler.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: 'm-queued',
      error: 'recipient offline',
      nextAttemptAtMs: Date.now() + 60_000,
    }));

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    const recipients = [makeFakeRecipient(), makeFakeRecipient(), makeFakeRecipient()];
    const state = await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/fanout-soft',
      sender,
      recipients,
      membershipHash: 'sha256:fanout-soft',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(state).toBeDefined();
  });
});
