import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  decodeWorkspaceEncryptionKey,
} from '@origintrail-official/dkg-core';
import {
  DKGAgent,
  agentFromPrivateKey,
  registerSelfSovereignAgent,
  activeWorkspaceEncryptionKeys,
  type AgentKeyRecord,
} from '../src/index.js';

interface DKGAgentInternals {
  localAgents: Map<string, AgentKeyRecord>;
}

async function bootAgentWithCustodialRecord(): Promise<{
  agent: DKGAgent;
  record: AgentKeyRecord;
}> {
  const agent = await DKGAgent.create({ name: 'RotateTest', chainAdapter: new MockChainAdapter() });
  const internals = agent as unknown as DKGAgentInternals;
  const record = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'rotator');
  internals.localAgents.set(record.agentAddress, record);
  return { agent, record };
}

describe('DKGAgent.rotateWorkspaceEncryptionKey', () => {
  it('appends a fresh key and keeps the previous one active when retireOld is omitted', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const originalKeyId = record.workspaceEncryptionKeys[0].encryptionKeyId;

    const result = await agent.rotateWorkspaceEncryptionKey(record.agentAddress);

    expect(result.newKeyId).not.toBe(originalKeyId);
    expect(result.retiredKeyId).toBeUndefined();
    expect(record.workspaceEncryptionKeys).toHaveLength(2);
    expect(activeWorkspaceEncryptionKeys(record)).toHaveLength(2);
  });

  it('mints + revokes in one call when retireOld is true, leaving one active key', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const originalKeyId = record.workspaceEncryptionKeys[0].encryptionKeyId;

    const result = await agent.rotateWorkspaceEncryptionKey(record.agentAddress, { retireOld: true });

    expect(result.newKeyId).not.toBe(originalKeyId);
    expect(result.retiredKeyId).toBe(originalKeyId);
    expect(record.workspaceEncryptionKeys).toHaveLength(2);
    expect(activeWorkspaceEncryptionKeys(record)).toHaveLength(1);
    expect(activeWorkspaceEncryptionKeys(record)[0].encryptionKeyId).toBe(result.newKeyId);

    // The revocation must be wallet-signed and ecrecover correctly.
    const revoked = record.workspaceEncryptionKeys.find((k) => k.encryptionKeyId === originalKeyId);
    expect(revoked?.revokedAt).toBeTruthy();
    expect(revoked?.revocationProof).toMatch(/^0x[0-9a-f]+$/);
    const payload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
      agentAddress: ethers.getAddress(record.agentAddress),
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes: decodeWorkspaceEncryptionKey(revoked!.publicEncryptionKey),
      revokedAt: revoked!.revokedAt!,
    });
    expect(ethers.verifyMessage(payload, revoked!.revocationProof!).toLowerCase())
      .toBe(record.agentAddress.toLowerCase());
  });

  it('refuses to rotate on a self-sovereign agent (daemon has no wallet to sign the new proof)', async () => {
    const agent = await DKGAgent.create({ name: 'RotateSelfSov', chainAdapter: new MockChainAdapter() });
    const internals = agent as unknown as DKGAgentInternals;
    const wallet = ethers.Wallet.createRandom();
    const record = registerSelfSovereignAgent('selfsov', wallet.signingKey.publicKey);
    internals.localAgents.set(record.agentAddress, record);

    await expect(agent.rotateWorkspaceEncryptionKey(record.agentAddress))
      .rejects.toThrow(/non-custodial agent/);
  });

  it('throws on unknown local agents', async () => {
    const agent = await DKGAgent.create({ name: 'RotateUnknown', chainAdapter: new MockChainAdapter() });
    const unknown = ethers.Wallet.createRandom().address;
    await expect(agent.rotateWorkspaceEncryptionKey(unknown))
      .rejects.toThrow(/Unknown local agent/);
  });
});

describe('DKGAgent.revokeWorkspaceEncryptionKey', () => {
  it('revokes a specific key when other active keys remain', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const original = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await agent.rotateWorkspaceEncryptionKey(record.agentAddress);

    const result = await agent.revokeWorkspaceEncryptionKey(record.agentAddress, original);

    expect(result.revokedKeyId).toBe(original);
    expect(result.revokedAt).toBeTruthy();
    expect(activeWorkspaceEncryptionKeys(record)).toHaveLength(1);
  });

  it('refuses to revoke the only active key (would brick SWM access)', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const onlyKey = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await expect(agent.revokeWorkspaceEncryptionKey(record.agentAddress, onlyKey))
      .rejects.toThrow(/Refusing to revoke the only active encryption key/);
    expect(activeWorkspaceEncryptionKeys(record)).toHaveLength(1);
  });

  it('throws on an unknown key id', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    await expect(agent.revokeWorkspaceEncryptionKey(record.agentAddress, 'did:dkg:agent:0x0#x25519-nonexistent'))
      .rejects.toThrow(/Encryption key .* not found/);
  });

  it('is idempotent on an already-revoked key (no re-signing, no re-publish)', async () => {
    const { agent, record } = await bootAgentWithCustodialRecord();
    const original = record.workspaceEncryptionKeys[0].encryptionKeyId;
    await agent.rotateWorkspaceEncryptionKey(record.agentAddress);
    const first = await agent.revokeWorkspaceEncryptionKey(record.agentAddress, original);
    const second = await agent.revokeWorkspaceEncryptionKey(record.agentAddress, original);
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('refuses self-sovereign agents (use attachRevocationToWorkspaceEncryptionKey for those)', async () => {
    const agent = await DKGAgent.create({ name: 'RevokeSelfSov', chainAdapter: new MockChainAdapter() });
    const internals = agent as unknown as DKGAgentInternals;
    const wallet = ethers.Wallet.createRandom();
    const record = registerSelfSovereignAgent('selfsov', wallet.signingKey.publicKey);
    internals.localAgents.set(record.agentAddress, record);
    await expect(agent.revokeWorkspaceEncryptionKey(record.agentAddress, 'did:dkg:agent:0x0#x25519-x'))
      .rejects.toThrow(/non-custodial agent/);
  });
});
