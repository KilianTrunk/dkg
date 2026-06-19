/**
 * GH #1124 — public context graphs must be able to publish to Verifiable Memory.
 *
 * Host-mode cores dropped a PUBLIC CG's plaintext SWM share at two gates in
 * `ingestSwmHostModeEnvelope` (the `isCiphertext` sniff + the curated-agent
 * authority check), so a public CG's storage-ACK quorum was unreachable on a
 * host-mode sharded topology. The fix opens BOTH gates — but ONLY for a CG that
 * can be positively confirmed public via `isConfirmedPublicForHostMode`.
 *
 * The SECURITY-CRITICAL property is that helper's bias: a curated CG (including
 * one whose on-chain policy hasn't loaded yet — the chain-event race) must NEVER
 * be misclassified as public, because that would admit an unauthenticated
 * plaintext envelope into curated storage. `isConfirmedPublicForHostMode`
 * delegates to the shared `getContextGraphOnChainPolicy` resolver (cache + _meta
 * + chain RPC, key-independent) and treats ONLY `accessPolicy === 0` as public;
 * curated (1) and unknown (undefined/throw) both → false.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWorkspacePublishRequest } from '@origintrail-official/dkg-core';
import { DKGAgent, agentFromPrivateKey, type AgentKeyRecord } from '../../src/index.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

interface ClassifierInternals {
  isConfirmedPublicForHostMode(cgId: string): Promise<boolean>;
  getContextGraphOnChainPolicy(cgId: string): Promise<{ accessPolicy?: number; publishPolicy?: number }>;
}

interface IngestInternals {
  isConfirmedPublicForHostMode(cgId: string): Promise<boolean>;
  encodeWorkspaceGossipMessage(contextGraphId: string, message: Uint8Array): Promise<Uint8Array>;
  ingestSwmHostModeEnvelope(contextGraphId: string, data: Uint8Array, fromPeerId: string): Promise<void>;
  swmHostModeStore?: SwmHostModeStore;
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  getSwmHostModeStats(): Promise<{ perCg?: Record<string, { entries: number; bytes: number }> } | undefined>;
}

describe('GH #1124 — isConfirmedPublicForHostMode safety bias (only accessPolicy===0 is public)', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeCore(): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-1124-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({ name: 'Pub1124Core', listenHost: '127.0.0.1', dataDir, nodeRole: 'core' });
    agents.push(core);
    return core;
  }

  it('on-chain accessPolicy === 0 → public', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0 });
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(true);
  });

  it('on-chain accessPolicy === 1 (curated) → NOT public', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 1 });
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('UNKNOWN policy (accessPolicy undefined — chain-event race) → NOT public (the misclassification guard)', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({}); // unresolved
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('policy resolver THROWS → NOT public (fail-safe)', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => { throw new Error('chain unavailable'); };
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });
});

describe('GH #1124 — ingestSwmHostModeEnvelope gate behaviour (signed plaintext gossip end-to-end)', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeHostCore(): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-1124-ingest-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({ name: 'Ingest1124Host', listenHost: '127.0.0.1', dataDir, nodeRole: 'core', swmHostMode: { enabled: true } });
    agents.push(core);
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    const g = core as unknown as IngestInternals;
    g.swmHostModeStore = store;
    // Register a local signing agent so encodeWorkspaceGossipMessage produces a
    // real SIGNED gossip envelope (otherwise it returns the raw, undecodable payload).
    const signer = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'signer');
    g.localAgents.set(signer.agentAddress, signer);
    g.defaultAgentAddress = signer.agentAddress;
    return core;
  }

  const PEER = '12D3KooWHostModePublisherPeerForIngestTest';
  // A valid PLAINTEXT WorkspacePublishRequest (public SWM share) — not ciphertext,
  // and decodable by the host's verifyHostModeEnvelopeAuthority path.
  const plaintextRequest = (cg: string): Uint8Array => encodeWorkspacePublishRequest({
    contextGraphId: cg,
    nquads: new TextEncoder().encode('<urn:p01124:s> <http://schema.org/name> "Public1124" .'),
    manifest: [{ rootEntity: 'urn:p01124:s' }],
    publisherPeerId: PEER,
    shareOperationId: `op-1124-${cg}`,
    timestampMs: 1_700_000_000_000,
  });

  async function entriesFor(g: IngestInternals, cg: string): Promise<number> {
    const stats = await g.getSwmHostModeStats();
    return stats?.perCg?.[cg]?.entries ?? 0;
  }

  it('CONFIRMED-PUBLIC: a signed plaintext SWM envelope is STORED (was dropped pre-#1124)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-public';
    g.isConfirmedPublicForHostMode = async () => true; // positively public
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(cg));
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(await entriesFor(g, cg)).toBe(1);
  });

  it('CURATED: a plaintext envelope is DROPPED (Gate 1 — curated must be ciphertext)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-curated';
    g.isConfirmedPublicForHostMode = async () => false; // curated/not-public
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(cg));
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(await entriesFor(g, cg)).toBe(0);
  });

  it('UNKNOWN policy: a plaintext envelope is DROPPED (safe default — heals via catchup)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-unknown';
    g.isConfirmedPublicForHostMode = async () => false; // unknown resolves to not-public
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(cg));
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(await entriesFor(g, cg)).toBe(0);
  });

  it('PUBLIC but TAMPERED signature: DROPPED (public path verifies signature self-consistency)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-public-forged';
    g.isConfirmedPublicForHostMode = async () => true; // public, but…
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(cg));
    // Corrupt the trailing signature bytes so it no longer recovers to the signer.
    const tampered = Uint8Array.from(env);
    for (let i = 1; i <= 8 && i <= tampered.length; i++) tampered[tampered.length - i] ^= 0xff;
    await g.ingestSwmHostModeEnvelope(cg, tampered, PEER);
    expect(await entriesFor(g, cg)).toBe(0);
  });
});
