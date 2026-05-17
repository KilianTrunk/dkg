import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  DKGAgent,
  agentFromPrivateKey,
  activeWorkspaceEncryptionKeys,
} from '../src/index.js';

const AGENT_GRAPH = 'did:dkg:system/agents';
const DKG = 'https://dkg.network/ontology#';

interface DKGAgentInternals {
  store: { insert(quads: Quad[]): Promise<void> };
  loadEncryptionKeyTriplesByAgent(): Promise<Map<string, any[]>>;
}

/**
 * Build a self-contained "RDF says we published these keys" agent record by
 * inserting the same triples persistAgentToStore() would emit. Returns the
 * agent address and the key URIs so tests can later assert on them.
 */
async function publishAgentWithKeys(
  agent: DKGAgent,
  opts: {
    /** Wallet signs the encryption-key proof + (optionally) revocation. */
    wallet: ethers.HDNodeWallet;
    /** How many keys to publish for this agent. */
    keyCount: number;
    /** If set, indices in [0, keyCount) to revoke (wallet-signed). */
    revokeIndices?: number[];
    /** Name/mode/createdAt fluff for the agent row. */
    name?: string;
  },
): Promise<{ agentAddress: string; keyIds: string[]; publicKeysB64: string[] }> {
  const internals = agent as unknown as DKGAgentInternals;
  const agentAddress = ethers.getAddress(opts.wallet.address);
  const agentUri = `did:dkg:agent:${agentAddress}`;
  const quads: Quad[] = [
    { subject: agentUri, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}Agent`, graph: AGENT_GRAPH },
    { subject: agentUri, predicate: 'https://schema.org/name', object: `"${opts.name ?? 'rdf-only-agent'}"`, graph: AGENT_GRAPH },
    { subject: agentUri, predicate: `${DKG}agentAddress`, object: `"${agentAddress}"`, graph: AGENT_GRAPH },
    { subject: agentUri, predicate: `${DKG}agentMode`, object: `"custodial"`, graph: AGENT_GRAPH },
    { subject: agentUri, predicate: `${DKG}createdAt`, object: `"${new Date().toISOString()}"`, graph: AGENT_GRAPH },
  ];
  const keyIds: string[] = [];
  const publicKeysB64: string[] = [];
  for (let i = 0; i < opts.keyCount; i++) {
    const recipient = generateWorkspaceRecipientEncryptionKey(
      `did:dkg:agent:${agentAddress}`,
      `did:dkg:agent:${agentAddress}#x25519`,
    );
    const publicKeyBytes = recipient.publicKeyBytes!;
    const publicKeyB64 = encodeWorkspaceEncryptionKey(publicKeyBytes);
    const proofPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
    });
    const proof = opts.wallet.signingKey.sign(ethers.hashMessage(proofPayload)).serialized;
    const keyId = workspaceAgentEncryptionKeyId(agentAddress, publicKeyBytes);
    keyIds.push(keyId);
    publicKeysB64.push(publicKeyB64);
    quads.push(
      { subject: agentUri, predicate: `${DKG}publicEncryptionKey`, object: `"${publicKeyB64}"`, graph: AGENT_GRAPH },
      { subject: agentUri, predicate: `${DKG}encryptionKeyAlgorithm`, object: `"${WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519}"`, graph: AGENT_GRAPH },
      { subject: agentUri, predicate: `${DKG}encryptionKeyProof`, object: `"${proof}"`, graph: AGENT_GRAPH },
    );
    if (opts.revokeIndices?.includes(i)) {
      const revokedAt = new Date(Date.UTC(2026, 4, 17, 12, i, 0)).toISOString();
      const revPayload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
        agentAddress,
        encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
        publicKeyBytes,
        revokedAt,
      });
      const revProof = opts.wallet.signingKey.sign(ethers.hashMessage(revPayload)).serialized;
      quads.push(
        { subject: keyId, predicate: `${DKG}revokedAt`, object: `"${revokedAt}"`, graph: AGENT_GRAPH },
        { subject: keyId, predicate: `${DKG}revokedBy`, object: agentUri, graph: AGENT_GRAPH },
        { subject: keyId, predicate: `${DKG}encryptionKeyRevocationProof`, object: `"${revProof}"`, graph: AGENT_GRAPH },
      );
    }
  }
  await internals.store.insert(quads);
  return { agentAddress, keyIds, publicKeysB64 };
}

describe('loadEncryptionKeyTriplesByAgent: RDF recovery source for workspace encryption keys', () => {
  it('rebuilds the (key, algorithm, proof) tuples for a multi-key agent from RDF alone', async () => {
    const agent = await DKGAgent.create({ name: 'RdfRecoverySimple', chainAdapter: new MockChainAdapter() });
    const wallet = ethers.Wallet.createRandom();
    const { agentAddress, keyIds } = await publishAgentWithKeys(agent, { wallet, keyCount: 2 });

    const byAgent = await (agent as unknown as DKGAgentInternals).loadEncryptionKeyTriplesByAgent();
    const entries = byAgent.get(agentAddress.toLowerCase());
    expect(entries).toBeDefined();
    expect(entries!.map((e) => e.encryptionKeyId).sort()).toEqual([...keyIds].sort());
    for (const entry of entries!) {
      expect(entry.encryptionKeyAlgorithm).toBe(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519);
      expect(entry.encryptionKeyProof).toMatch(/^0x[0-9a-f]+$/);
      expect(entry.privateEncryptionKey).toBeUndefined();
      expect(entry.revokedAt).toBeUndefined();
    }
  });

  it('preserves wallet-signed revocations from RDF (revokedAt + revocationProof recovered)', async () => {
    const agent = await DKGAgent.create({ name: 'RdfRecoveryRevoked', chainAdapter: new MockChainAdapter() });
    const wallet = ethers.Wallet.createRandom();
    const { agentAddress, keyIds } = await publishAgentWithKeys(agent, {
      wallet,
      keyCount: 3,
      revokeIndices: [0, 2],
    });

    const byAgent = await (agent as unknown as DKGAgentInternals).loadEncryptionKeyTriplesByAgent();
    const entries = byAgent.get(agentAddress.toLowerCase())!;
    expect(entries).toHaveLength(3);

    const revoked = entries.filter((e) => e.revokedAt);
    expect(revoked.map((e) => e.encryptionKeyId).sort()).toEqual([keyIds[0], keyIds[2]].sort());
    for (const r of revoked) {
      expect(r.revocationProof).toMatch(/^0x[0-9a-f]+$/);
      expect(r.revokedAt).toBeTruthy();
    }
    const active = entries.find((e) => e.encryptionKeyId === keyIds[1]);
    expect(active?.revokedAt).toBeUndefined();
  });

  it('drops keys whose proof was signed by another wallet (cartesian-product mismatches filtered by EIP-191 verify)', async () => {
    // RDF will hold one valid (key, proof) pair plus a planted bogus proof
    // triple from an unrelated wallet. The bogus proof must be silently
    // ignored — otherwise an attacker who can insert into the agents graph
    // could resurrect arbitrary keys for someone else's agent.
    const agent = await DKGAgent.create({ name: 'RdfRecoveryAttacker', chainAdapter: new MockChainAdapter() });
    const realWallet = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const { agentAddress, keyIds } = await publishAgentWithKeys(agent, { wallet: realWallet, keyCount: 1 });

    // Insert a second publicEncryptionKey + a proof signed by the attacker.
    const evilRecipient = generateWorkspaceRecipientEncryptionKey(
      `did:dkg:agent:${agentAddress}`,
      `did:dkg:agent:${agentAddress}#x25519`,
    );
    const evilPublicKeyBytes = evilRecipient.publicKeyBytes!;
    const evilPublicKeyB64 = encodeWorkspaceEncryptionKey(evilPublicKeyBytes);
    const evilProofPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes: evilPublicKeyBytes,
    });
    const evilProof = attacker.signingKey.sign(ethers.hashMessage(evilProofPayload)).serialized;
    await (agent as unknown as DKGAgentInternals).store.insert([
      { subject: `did:dkg:agent:${agentAddress}`, predicate: `${DKG}publicEncryptionKey`, object: `"${evilPublicKeyB64}"`, graph: AGENT_GRAPH },
      { subject: `did:dkg:agent:${agentAddress}`, predicate: `${DKG}encryptionKeyProof`, object: `"${evilProof}"`, graph: AGENT_GRAPH },
    ]);

    const byAgent = await (agent as unknown as DKGAgentInternals).loadEncryptionKeyTriplesByAgent();
    const entries = byAgent.get(agentAddress.toLowerCase())!;
    // Only the legitimate key survives. The attacker's key — paired in the
    // cartesian with both the real proof AND the evil proof — fails EIP-191
    // verify in both directions (real proof recovers the wrong address; evil
    // proof recovers the attacker, not the agent).
    expect(entries.map((e) => e.encryptionKeyId)).toEqual([keyIds[0]]);
  });

  it('returns an empty map when the agents graph has no agents (clean boot)', async () => {
    const agent = await DKGAgent.create({ name: 'RdfRecoveryEmpty', chainAdapter: new MockChainAdapter() });
    const byAgent = await (agent as unknown as DKGAgentInternals).loadEncryptionKeyTriplesByAgent();
    expect(byAgent.size).toBe(0);
  });

  it('does not auto-mint a replacement when RDF carries published keys without a private half', async () => {
    // The "lost keystore" recovery path: a custodial wallet is loaded but
    // the keystore has none of its previous encryption keys. RDF still has
    // them. We expect the merge logic to adopt the RDF entries as
    // public-only so peers' view of the agent stays stable, and we do NOT
    // mint a fresh key behind the operator's back (that would publish a
    // brand-new key the network doesn't recognise).

    const agent = await DKGAgent.create({ name: 'RdfRecoveryNoMint', chainAdapter: new MockChainAdapter() });
    const internals = agent as unknown as DKGAgentInternals;
    const wallet = ethers.Wallet.createRandom();
    const { agentAddress, keyIds } = await publishAgentWithKeys(agent, { wallet, keyCount: 1 });

    // Simulate fresh-boot reload: the record has the wallet privkey but no
    // workspaceEncryptionKeys[] in the keystore (this is the lost-keystore
    // case). We seed it directly into localAgents and then merge RDF.
    const record = agentFromPrivateKey(wallet.privateKey, 'recovered');
    record.workspaceEncryptionKeys = [];
    delete record.publicEncryptionKey;
    delete record.privateEncryptionKey;
    delete record.encryptionKeyAlgorithm;
    delete record.encryptionKeyProof;

    const rdf = await internals.loadEncryptionKeyTriplesByAgent();
    const rdfForAgent = rdf.get(agentAddress.toLowerCase()) ?? [];
    expect(rdfForAgent).toHaveLength(1);

    for (const rdfEntry of rdfForAgent) {
      record.workspaceEncryptionKeys.push({ ...rdfEntry });
    }

    expect(record.workspaceEncryptionKeys).toHaveLength(1);
    expect(record.workspaceEncryptionKeys[0].encryptionKeyId).toBe(keyIds[0]);
    expect(record.workspaceEncryptionKeys[0].privateEncryptionKey).toBeUndefined();
    expect(activeWorkspaceEncryptionKeys(record)).toHaveLength(1);
  });
});
