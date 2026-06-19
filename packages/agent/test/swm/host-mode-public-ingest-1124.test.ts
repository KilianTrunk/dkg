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
  getContextGraphOnChainPolicy(
    cgId: string,
    options?: { forcePublishPolicyChainRead?: boolean },
  ): Promise<{ accessPolicy?: number; publishPolicy?: number }>;
}

interface IngestInternals {
  getContextGraphOnChainPolicy(cgId: string): Promise<{ accessPolicy?: number; publishPolicy?: number }>;
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

  it('open read + open publish (accessPolicy 0, publishPolicy 1) → public', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 });
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(true);
  });

  it('public READ but curated PUBLISH (accessPolicy 0, publishPolicy 0) → NOT self-publishable', async () => {
    // The #1239-r3 🔴: read visibility ≠ write authority. A publicly-readable CG
    // can still restrict who may publish; the self-signed path must NOT apply.
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 0 });
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('curated read (accessPolicy 1) → NOT public, regardless of publishPolicy', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 1, publishPolicy: 1 });
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('UNKNOWN policy (either axis undefined — chain-event race) → NOT public (the misclassification guard)', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0 }); // publishPolicy unresolved
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
    g.getContextGraphOnChainPolicy = async () => ({}); // both unresolved
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('policy resolver THROWS → NOT public (fail-safe)', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => { throw new Error('chain unavailable'); };
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('forces a FRESH publishPolicy chain read for the admission gate (no ≤60s stale-permissive window)', async () => {
    // publishPolicy is mutable on-chain; the cache is only ≤60s-TTL'd. This
    // security-positive gate must re-verify on-chain, so it MUST pass
    // forcePublishPolicyChainRead. (Branimir review #1239: an open→curated
    // downgrade must not leave a stale-permissive admission window.)
    const g = (await makeCore()) as unknown as ClassifierInternals;
    let capturedOpts: { forcePublishPolicyChainRead?: boolean } | undefined;
    g.getContextGraphOnChainPolicy = async (_cg, opts) => { capturedOpts = opts; return { accessPolicy: 0, publishPolicy: 1 }; };
    await g.isConfirmedPublicForHostMode('cg');
    expect(capturedOpts?.forcePublishPolicyChainRead).toBe(true);
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

  // Drive the REAL classifier via the resolver it depends on (getContextGraphOnChainPolicy),
  // NOT by stubbing isConfirmedPublicForHostMode — so these exercise the actual
  // public-policy resolution + the two ingest gates end to end.
  it('CONFIRMED-PUBLIC: a signed plaintext SWM envelope is STORED (was dropped pre-#1124)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-public';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 }); // resolves fully-open (public read + open publish)
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(cg));
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(await entriesFor(g, cg)).toBe(1);
  });

  it('CURATED (accessPolicy 1): a plaintext envelope is DROPPED (Gate 1 — curated must be ciphertext)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-curated';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 1, publishPolicy: 0 });
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(cg));
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(await entriesFor(g, cg)).toBe(0);
  });

  it('UNKNOWN policy (unresolved): a plaintext envelope is DROPPED (safe default — heals via catchup)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-unknown';
    g.getContextGraphOnChainPolicy = async () => ({}); // accessPolicy undefined
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(cg));
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(await entriesFor(g, cg)).toBe(0);
  });

  it('PUBLIC but TAMPERED signature: DROPPED (shared verifier rejects bad signature/freshness)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-public-forged';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 });
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(cg));
    const tampered = Uint8Array.from(env);
    for (let i = 1; i <= 8 && i <= tampered.length; i++) tampered[tampered.length - i] ^= 0xff;
    await g.ingestSwmHostModeEnvelope(cg, tampered, PEER);
    expect(await entriesFor(g, cg)).toBe(0);
  });

  it('PUBLIC but inner request targets a DIFFERENT CG: DROPPED (no cross-CG injection)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cgEnvelope = 'cg-ingest-A';
    const cgInner = 'cg-ingest-B';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 }); // both fully-open (isolate the CG-binding check)
    // Envelope is signed for CG-A but its inner WorkspacePublishRequest targets CG-B.
    const env = await g.encodeWorkspaceGossipMessage(cgEnvelope, plaintextRequest(cgInner));
    await g.ingestSwmHostModeEnvelope(cgEnvelope, env, PEER);
    expect(await entriesFor(g, cgEnvelope)).toBe(0);
    expect(await entriesFor(g, cgInner)).toBe(0);
  });

  it('PUBLIC but inner publisherPeerId names a DIFFERENT peer than the sender: DROPPED (no publisher spoof)', async () => {
    // Host catchup later applies stored entries with trustedReplay (skipping the
    // publisherPeerId↔sender binding), so it must be enforced at ingest: a peer
    // relaying an honestly-signed envelope whose inner publisherPeerId names
    // ANOTHER peer must NOT be stored (otherwise catchup applies it under the
    // spoofed publisher/ownership identity).
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-spoof';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 });
    // plaintextRequest(cg) sets publisherPeerId = PEER; deliver it from a DIFFERENT sender.
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(cg));
    await g.ingestSwmHostModeEnvelope(cg, env, '12D3KooWSomeOtherRelayPeerNotThePublisher');
    expect(await entriesFor(g, cg)).toBe(0);
  });
});
