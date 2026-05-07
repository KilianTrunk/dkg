import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  computeGossipSigningPayload,
  decodeEncryptedWorkspacePayload,
  decodeGossipEnvelope,
  decodeWorkspacePublishRequest,
  DKG_ONTOLOGY,
  decryptWorkspacePayload,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  decodeWorkspaceEncryptionKey,
  workspaceAgentEncryptionKeyId,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GOSSIP_ENVELOPE_VERSION,
  contextGraphDataUri,
  contextGraphMetaUri,
  paranetWorkspaceTopic,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, agentFromPrivateKey, type AgentKeyRecord } from '../src/index.js';

interface DKGAgentInternals {
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  encodeWorkspaceGossipMessage(contextGraphId: string, message: Uint8Array): Promise<Uint8Array>;
}

class CapturingGossip {
  messages: Array<{ topic: string; data: Uint8Array }> = [];

  async publish(topic: string, data: Uint8Array): Promise<void> {
    this.messages.push({ topic, data });
  }
}

async function insertAgentGate(
  agent: DKGAgent,
  contextGraphId: string,
  predicate: string,
  agentAddress: string,
): Promise<void> {
  await agent.store.insert([{
    subject: contextGraphDataUri(contextGraphId),
    predicate,
    object: `"${agentAddress}"`,
    graph: contextGraphMetaUri(contextGraphId),
  }]);
}

function expectSignedEnvelope(
  wireMessage: Uint8Array,
  contextGraphId: string,
  payload: Uint8Array,
  expectedAgentAddress: string,
): void {
  const envelope = decodeGossipEnvelope(wireMessage);

  expect(envelope.version).toBe(GOSSIP_ENVELOPE_VERSION);
  expect(envelope.type).toBe(GOSSIP_TYPE_WORKSPACE_PUBLISH);
  expect(envelope.contextGraphId).toBe(contextGraphId);
  expect(envelope.agentAddress).toBe(expectedAgentAddress);
  expect(Array.from(envelope.payload)).toEqual(Array.from(payload));

  const recovered = ethers.verifyMessage(
    computeGossipSigningPayload(envelope.type, envelope.contextGraphId, envelope.timestamp, envelope.payload),
    ethers.hexlify(envelope.signature),
  );
  expect(recovered).toBe(expectedAgentAddress);
}

function recipientPrivateKeyFromRecord(record: AgentKeyRecord): WorkspaceRecipientEncryptionKey {
  if (
    record.encryptionKeyAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519 ||
    !record.publicEncryptionKey ||
    !record.privateEncryptionKey
  ) {
    throw new Error('test agent is missing workspace encryption key material');
  }
  const publicKeyBytes = decodeWorkspaceEncryptionKey(record.publicEncryptionKey);
  return {
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    recipientId: `did:dkg:agent:${record.agentAddress}`,
    recipientKeyId: workspaceAgentEncryptionKeyId(record.agentAddress, publicKeyBytes),
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
    privateKeyBytes: decodeWorkspaceEncryptionKey(record.privateEncryptionKey),
  };
}

describe('DKGAgent SWM gossip signing', () => {
  it('wraps open-graph SWM gossip with a local agent key even when the default cannot sign', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmFallbackSigner',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as DKGAgentInternals;

    const defaultRecord = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'default');
    delete defaultRecord.privateKey;
    const fallbackRecord = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'fallback');

    internals.localAgents.set(defaultRecord.agentAddress, defaultRecord);
    internals.localAgents.set(fallbackRecord.agentAddress, fallbackRecord);
    internals.defaultAgentAddress = defaultRecord.agentAddress;

    const contextGraphId = 'open-swm-cg';
    const payload = new TextEncoder().encode('raw shared-memory payload');
    const wireMessage = await internals.encodeWorkspaceGossipMessage(contextGraphId, payload);
    expectSignedEnvelope(wireMessage, contextGraphId, payload, fallbackRecord.agentAddress);
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('wraps agent-gated SWM gossip with the local %s key', async (_label, predicate) => {
    const agent = await DKGAgent.create({
      name: 'SwmGatedSigner',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as DKGAgentInternals;

    const defaultRecord = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'default');
    const gatedRecord = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'gated');

    internals.localAgents.set(defaultRecord.agentAddress, defaultRecord);
    internals.localAgents.set(gatedRecord.agentAddress, gatedRecord);
    internals.defaultAgentAddress = defaultRecord.agentAddress;

    const contextGraphId = `gated-swm-cg-${predicate.endsWith('allowedAgent') ? 'allowed' : 'participant'}`;
    await insertAgentGate(agent, contextGraphId, predicate, gatedRecord.agentAddress);

    const payload = new TextEncoder().encode('gated shared-memory payload');
    const wireMessage = await internals.encodeWorkspaceGossipMessage(contextGraphId, payload);

    expectSignedEnvelope(wireMessage, contextGraphId, payload, gatedRecord.agentAddress);
  });

  it('rejects outgoing agent-gated SWM gossip when no local allowed signing key exists', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmGatedNoSigner',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as DKGAgentInternals;

    const localRecord = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'local');
    const remoteAllowed = ethers.Wallet.createRandom();
    internals.localAgents.set(localRecord.agentAddress, localRecord);
    internals.defaultAgentAddress = localRecord.agentAddress;

    const contextGraphId = 'gated-swm-cg-no-local-signer';
    await insertAgentGate(agent, contextGraphId, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, remoteAllowed.address);

    const payload = new TextEncoder().encode('gated payload without a local signer');
    await expect(internals.encodeWorkspaceGossipMessage(contextGraphId, payload))
      .rejects.toThrow(/no local allowed signing agent key/);
  });

  it('encrypts agent-gated SWM wire payloads and only an allowed DKG agent recipient can decrypt them', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmEncryptedWire',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as DKGAgentInternals;
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => '12D3KooWEncryptedWireLocal' },
      configurable: true,
    });

    const allowedRecord = await agent.registerAgent('allowed-encryption-recipient');
    const deniedRecord = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'denied');
    internals.defaultAgentAddress = allowedRecord.agentAddress;
    const contextGraphId = 'gated-swm-encrypted-wire';
    await insertAgentGate(agent, contextGraphId, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowedRecord.agentAddress);

    await agent.share(contextGraphId, [{
      subject: 'urn:test:encrypted-wire',
      predicate: 'http://schema.org/name',
      object: '"wire secret"',
      graph: '',
    }]);

    expect(gossip.messages).toHaveLength(1);
    expect(gossip.messages[0]?.topic).toBe(paranetWorkspaceTopic(contextGraphId));
    const envelope = decodeGossipEnvelope(gossip.messages[0]!.data);
    expect(envelope.agentAddress).toBe(allowedRecord.agentAddress);
    let decodedAsPlainWorkspace = false;
    try {
      const request = decodeWorkspacePublishRequest(envelope.payload);
      decodedAsPlainWorkspace = request.paranetId === contextGraphId &&
        new TextDecoder().decode(request.nquads).includes('wire secret');
    } catch {
      decodedAsPlainWorkspace = false;
    }
    expect(decodedAsPlainWorkspace).toBe(false);

    const encrypted = decodeEncryptedWorkspacePayload(envelope.payload);
    const wireText = Buffer.from(envelope.payload).toString('utf8');
    expect(wireText).not.toContain('wire secret');
    await expect(
      decryptWorkspacePayload(encrypted, [recipientPrivateKeyFromRecord(deniedRecord)]),
    ).rejects.toThrow('No matching recipient encryption key could decrypt workspace payload');

    const decrypted = await decryptWorkspacePayload(encrypted, [recipientPrivateKeyFromRecord(allowedRecord)]);
    const request = decodeWorkspacePublishRequest(decrypted.plaintext);
    expect(new TextDecoder().decode(request.nquads)).toContain('wire secret');
  });

  it('keeps legacy raw SWM gossip for open graphs when no local signing key exists', async () => {
    const agent = await DKGAgent.create({
      name: 'SwmOpenNoSigner',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as DKGAgentInternals;

    const contextGraphId = 'open-swm-cg-no-signer';
    const payload = new TextEncoder().encode('legacy raw shared-memory payload');
    const wireMessage = await internals.encodeWorkspaceGossipMessage(contextGraphId, payload);

    expect(Array.from(wireMessage)).toEqual(Array.from(payload));
  });
});
