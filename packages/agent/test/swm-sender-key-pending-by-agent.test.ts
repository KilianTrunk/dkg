// PR-2 (SWM-fanout plan): soft-success on missing peerId.
//
// Pre-PR-2 a recipient agent with no `dkg:peerId` triple was a HARD
// failure inside `createAndDistributeSwmSenderKeyEpoch`. If EVERY key
// for an agent landed in that branch, the publish threw — one
// never-seen member could block writes for everyone else in the
// context graph.
//
// PR-2 turns the no-peerId branch into a soft success: we durably
// remember the package bytes in `pendingSenderKeyByAgent` (keyed by
// lowercased recipientAgentAddress) and return success up the loop.
// A subsequent `connection:open` event for the missing recipient
// drives `drainPendingSenderKeyForPeer`, which resolves the peer's
// agent address and replays each queued package via
// `messenger.sendReliable`.
//
// Three contracts pinned here:
//   1. no-peerId no longer throws (publish proceeds; row enqueued).
//   2. drain replays the queued package once we know the peerId,
//      and removes the row when the messenger confirms delivery.
//   3. enqueuing a newer epoch for the same (sender, recipient)
//      evicts older epochs — they're superseded by definition.

import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  generateWorkspaceRecipientEncryptionKey,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  DKGAgent,
  agentFromPrivateKey,
  type AgentKeyRecord,
  type DiscoveredAgent,
  type PendingSenderKeyEntry,
} from '../src/index.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

type StubMessenger = {
  sendReliable: (
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
  ) => Promise<ReliableSendResult>;
};

interface PendingInternals {
  messenger: StubMessenger;
  node: { peerId: { toString(): string } };
  discovery: { findAgentByPeerId(peerId: string): Promise<DiscoveredAgent | null> };
  pendingSenderKeyByAgent: Map<string, PendingSenderKeyEntry[]>;
  createAndDistributeSwmSenderKeyEpoch(input: {
    contextGraphId: string;
    subGraphName?: string;
    sender: AgentKeyRecord & { privateKey: string };
    recipients: readonly FakeRecipient[];
    membershipHash: string;
    ctx: OperationContext;
  }): Promise<unknown>;
  drainPendingSenderKeyForPeer(peerId: string): Promise<number>;
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

function makeFakeRecipient(opts: { peerId?: string } = {}): FakeRecipient {
  const wallet = ethers.Wallet.createRandom();
  const agentAddress = wallet.address;
  const recipientId = `did:dkg:agent:${agentAddress.toLowerCase()}`;
  const recipientKeyId = `${recipientId}#x25519-${ethers.id(wallet.privateKey).slice(2, 34)}`;
  const key = generateWorkspaceRecipientEncryptionKey(recipientId, recipientKeyId);
  return {
    agentAddress,
    peerId: opts.peerId, // explicitly undefined for the no-peerId branch
    recipientKeyId,
    recipientId,
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes: key.publicKeyBytes!,
  };
}

function installStubMessenger(
  internals: PendingInternals,
  sendReliable: StubMessenger['sendReliable'],
): void {
  internals.messenger = { sendReliable };
  if (!internals.node) {
    (internals as { node: { peerId: { toString(): string } } }).node = {
      peerId: { toString: () => '12D3KooWStubLocalPeerForPendingTest' },
    };
  }
}

function installStubDiscovery(
  internals: PendingInternals,
  byPeerId: (peerId: string) => DiscoveredAgent | null,
): void {
  (internals as { discovery: PendingInternals['discovery'] }).discovery = {
    findAgentByPeerId: async (peerId: string) => byPeerId(peerId),
  };
}

async function bootAgent(): Promise<{ agent: DKGAgent; internals: PendingInternals }> {
  const agent = await DKGAgent.create({
    name: 'PendingSenderKeyTest',
    chainAdapter: new MockChainAdapter(),
  });
  const internals = agent as unknown as PendingInternals;
  return { agent, internals };
}

describe('createAndDistributeSwmSenderKeyEpoch: missing-peerId soft success', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it('does not throw when every recipient has no peerId; enqueues each', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    // No messenger.sendReliable should be invoked when peerId is absent;
    // install a stub that throws so a regression that calls it would
    // fail loudly.
    installStubMessenger(internals, async () => {
      throw new Error('sendReliable must not be called on no-peerId branch');
    });

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const recipients = [makeFakeRecipient(), makeFakeRecipient()];

    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/no-peerid',
        sender,
        recipients,
        membershipHash: 'sha256:no-peerid',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).resolves.toBeDefined();

    // Two distinct recipient agents → two queue entries (one per agent).
    expect(internals.pendingSenderKeyByAgent.size).toBe(2);
    for (const recipient of recipients) {
      const queue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
      expect(queue).toBeDefined();
      expect(queue!).toHaveLength(1);
      expect(queue![0].recipientKeyId).toBe(recipient.recipientKeyId);
      expect(queue![0].packageBytes.byteLength).toBeGreaterThan(0);
    }
  });

  it('delivers pending package once the recipient peer connects', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sendCalls: { peerId: string; payload: Uint8Array }[] = [];
    installStubMessenger(internals, async (peerId, _protocolId, payload) => {
      sendCalls.push({ peerId, payload });
      return { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'm-drain' };
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });

    expect(sendCalls).toHaveLength(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    // Now simulate connection:open by stubbing the discovery resolver
    // and calling the drain helper directly.
    const knownPeerId = '12D3KooWFinallyOnlineForDrainTest';
    installStubDiscovery(internals, (peerId) => {
      if (peerId !== knownPeerId) return null;
      return {
        agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
        name: 'drain-target',
        peerId,
        agentAddress: recipient.agentAddress,
      };
    });

    const drained = await internals.drainPendingSenderKeyForPeer(knownPeerId);
    expect(drained).toBe(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].peerId).toBe(knownPeerId);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('keeps the row queued when messenger soft-queues (delivered=false)', async () => {
    // Verifies that delivered=false leaves the row in place for the next
    // drain attempt — the connection happened but the recipient still
    // couldn't be reached synchronously (e.g. they accepted the
    // connection then dropped before processing the protocol).
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => ({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: 'm-soft',
      error: 'stream reset mid-protocol',
      nextAttemptAtMs: Date.now() + 60_000,
    }));

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain-soft',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain-soft',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    installStubDiscovery(internals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'drain-target',
      peerId: '12D3KooWSoftDrainTest',
      agentAddress: recipient.agentAddress,
    }));

    const drained = await internals.drainPendingSenderKeyForPeer('12D3KooWSoftDrainTest');
    expect(drained).toBe(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
  });

  it('supersedes older epochs for the same (sender, recipient) pair', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => {
      throw new Error('sendReliable must not be called on no-peerId branch');
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    // First publish — enqueues epoch-1.
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/super',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:super-1',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    const queueAfterFirst = internals.pendingSenderKeyByAgent.get(
      recipient.agentAddress.toLowerCase(),
    )!;
    expect(queueAfterFirst).toHaveLength(1);
    const firstEpochId = queueAfterFirst[0].epochId;

    // Second publish with a NEW membership hash — forces a new epoch.
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/super',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:super-2',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    const queueAfterSecond = internals.pendingSenderKeyByAgent.get(
      recipient.agentAddress.toLowerCase(),
    )!;
    expect(queueAfterSecond).toHaveLength(1);
    expect(queueAfterSecond[0].epochId).not.toBe(firstEpochId);
  });
});
