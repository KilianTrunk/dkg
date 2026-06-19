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
 * plaintext envelope into curated storage. This pins: confirmed-public → true;
 * curated marker → false; UNKNOWN → false (safe default, heals via catchup).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../../src/index.js';

interface Internals {
  isConfirmedPublicForHostMode(cgId: string): Promise<boolean>;
  subscribedContextGraphs: Map<string, { subscribed: boolean; synced?: boolean; onChainHash?: string; onChainId?: string }>;
  onChainAccessPolicyCache: Map<string, number>;
  getExplicitAccessPolicy(cgId: string, opts?: unknown): Promise<'public' | 'private' | null>;
}

describe('GH #1124 — isConfirmedPublicForHostMode safety bias (curated/unknown are NEVER public)', () => {
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

  it('curated via onChainHash → NOT public (even if _meta would say public)', async () => {
    const g = (await makeCore()) as unknown as Internals;
    const cg = 'cg-curated-hash';
    g.subscribedContextGraphs.set(cg, { subscribed: true, onChainHash: ethers.keccak256(ethers.toUtf8Bytes(cg)) });
    g.getExplicitAccessPolicy = async () => 'public'; // must NOT override the curated marker
    expect(await g.isConfirmedPublicForHostMode(cg)).toBe(false);
  });

  it('curated via on-chain accessPolicy cache === 1 → NOT public', async () => {
    const g = (await makeCore()) as unknown as Internals;
    const cg = 'cg-curated-cache';
    g.subscribedContextGraphs.set(cg, { subscribed: true, onChainId: '4242' });
    g.onChainAccessPolicyCache.set('4242', 1);
    g.getExplicitAccessPolicy = async () => 'public';
    expect(await g.isConfirmedPublicForHostMode(cg)).toBe(false);
  });

  it('confirmed public via on-chain accessPolicy cache === 0 → public', async () => {
    const g = (await makeCore()) as unknown as Internals;
    const cg = 'cg-public-cache';
    g.subscribedContextGraphs.set(cg, { subscribed: true, onChainId: '5151' });
    g.onChainAccessPolicyCache.set('5151', 0);
    expect(await g.isConfirmedPublicForHostMode(cg)).toBe(true);
  });

  it('confirmed public via explicit _meta accessPolicy "public" → public', async () => {
    const g = (await makeCore()) as unknown as Internals;
    const cg = 'cg-public-meta';
    g.getExplicitAccessPolicy = async () => 'public';
    expect(await g.isConfirmedPublicForHostMode(cg)).toBe(true);
  });

  it('explicit _meta accessPolicy "private" → NOT public', async () => {
    const g = (await makeCore()) as unknown as Internals;
    const cg = 'cg-private-meta';
    g.getExplicitAccessPolicy = async () => 'private';
    expect(await g.isConfirmedPublicForHostMode(cg)).toBe(false);
  });

  it('UNKNOWN policy (null — chain-event race) → NOT public (safe default; the misclassification guard)', async () => {
    const g = (await makeCore()) as unknown as Internals;
    const cg = 'cg-unknown';
    g.getExplicitAccessPolicy = async () => null; // policy not loaded yet
    expect(await g.isConfirmedPublicForHostMode(cg)).toBe(false);
  });

  it('policy lookup THROWS → NOT public (fail-safe)', async () => {
    const g = (await makeCore()) as unknown as Internals;
    const cg = 'cg-throws';
    g.getExplicitAccessPolicy = async () => { throw new Error('chain unavailable'); };
    expect(await g.isConfirmedPublicForHostMode(cg)).toBe(false);
  });
});
