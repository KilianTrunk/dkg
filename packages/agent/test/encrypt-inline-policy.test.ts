/**
 * Regression coverage for LU-5 inline-payload encryption policy.
 *
 * Numeric context graph ids are chain-owned policy surfaces. If the
 * daemon cannot read chain truth for one of them, publishing must fail
 * closed instead of falling back to plaintext.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/dkg-agent.js';

function makeAgentLike(opts: {
  isPrivate?: boolean;
  accessPolicy?: 0 | 1;
  accessPolicyError?: Error;
  exposeAccessPolicy?: boolean;
  // Numeric ids proven registered on-chain (the isKnownOnChainId gate).
  // Defaults to the "42" used by the public-CG cases below.
  knownOnChainIds?: string[];
} = {}) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const chain: Record<string, unknown> = {};
  if (opts.exposeAccessPolicy !== false) {
    chain.getContextGraphAccessPolicy = vi.fn(async () => {
      if (opts.accessPolicyError) throw opts.accessPolicyError;
      return opts.accessPolicy ?? 0;
    });
  }
  const agentLike = {
    log,
    chain,
    onChainAccessPolicyCache: new Map<string, 0 | 1>(),
    isPrivateContextGraph: vi.fn(async () => opts.isPrivate ?? false),
  } as any;
  // `probeIsCurated` now consults the on-chain-public override first; bind
  // the real prototype method so the harness exercises production code.
  agentLike.isContextGraphPublicOnChain = (DKGAgent.prototype as any).isContextGraphPublicOnChain;
  // #884 review: the numeric branch of `isContextGraphPublicOnChain` calls
  // `this.isKnownOnChainId(...)` to gate the on-chain-id shortcut on proven
  // registration. Stub it to recognise ONLY explicitly-seeded ids (default
  // "42") — NOT every digit-only string — so the suite genuinely exercises
  // the registration-proof gate instead of bypassing it (a regression that
  // starts trusting unregistered numeric ids would now fail a test).
  const knownOnChainIds = new Set(opts.knownOnChainIds ?? ['42']);
  agentLike.isKnownOnChainId = vi.fn((id: string) => knownOnChainIds.has(String(id)));
  // isContextGraphPublicOnChain (bound above) now wraps the chain access-policy
  // read in raceChainPolicyRead — bind it so `this.raceChainPolicyRead` exists.
  agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;
  return agentLike;
}

async function resolveEncryptInlinePayload(
  agentLike: any,
  contextGraphId: string,
  publishContextGraphId?: string,
) {
  // RFC-39 / LU-11 refactor extracted the access-policy probe + curated
  // bootstrap into the private helper `_resolveCuratedChainKeyContext`,
  // which `_resolveEncryptInlinePayload` now delegates to before returning
  // either the AEAD callback or `undefined`. The lightweight `agentLike`
  // harness in this file does not extend `DKGAgent.prototype`, so we must
  // also bind the helper here — otherwise the first call throws
  // `TypeError: this._resolveCuratedChainKeyContext is not a function`
  // before any of the policy assertions below can run. All test cases in
  // this file short-circuit inside the policy probe (public CG → undefined,
  // unknown policy → throw) so they never touch the curated bootstrap
  // dependencies (`createAndDistributeSwmSenderKeyEpoch` etc.).
  agentLike._resolveCuratedChainKeyContext = (DKGAgent.prototype as any)
    ._resolveCuratedChainKeyContext;
  return (DKGAgent.prototype as any)._resolveEncryptInlinePayload.call(
    agentLike,
    contextGraphId,
    undefined,
    undefined,
    publishContextGraphId,
  );
}

describe('DKGAgent._resolveEncryptInlinePayload policy lookup', () => {
  it('keeps non-numeric local public CGs on the plaintext path', async () => {
    const agentLike = makeAgentLike({ exposeAccessPolicy: false });

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg')).resolves.toBeUndefined();
  });

  it('uses chain policy for numeric public CGs before choosing plaintext', async () => {
    const agentLike = makeAgentLike({ accessPolicy: 0 });

    await expect(resolveEncryptInlinePayload(agentLike, '42')).resolves.toBeUndefined();
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
    expect(agentLike.onChainAccessPolicyCache.get('42')).toBe(0);
  });

  it('fails closed when numeric target CG policy lookup is unavailable', async () => {
    const agentLike = makeAgentLike({
      accessPolicyError: new Error('rpc unavailable'),
    });

    await expect(resolveEncryptInlinePayload(agentLike, '42')).rejects.toThrow(
      /publish access-policy is unknown/,
    );
    expect(agentLike.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('treating as UNKNOWN'),
    );
  });

  it('fails closed when numeric target CG policy getter is missing', async () => {
    const agentLike = makeAgentLike({ exposeAccessPolicy: false });

    await expect(resolveEncryptInlinePayload(agentLike, '42')).rejects.toThrow(
      /publish access-policy is unknown/,
    );
  });

  it('does NOT classify an UNREGISTERED numeric id as public (registration-proof gate) (#884 review)', async () => {
    // isKnownOnChainId is seeded with NO ids, so "999" is unproven. Even
    // though the chain getter would return the permissive default (0) for an
    // unknown id, the gate must short-circuit isContextGraphPublicOnChain to
    // false BEFORE any chain read — proving the suite exercises the
    // registration-proof logic rather than blanket-trusting numeric strings.
    const agentLike = makeAgentLike({ accessPolicy: 0, knownOnChainIds: [] });
    await expect(
      (DKGAgent.prototype as any).isContextGraphPublicOnChain.call(agentLike, '999'),
    ).resolves.toBe(false);
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('fails closed when a remap target numeric CG policy cannot be resolved', async () => {
    const agentLike = makeAgentLike({
      accessPolicyError: new Error('rpc unavailable'),
    });

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg', '42')).rejects.toThrow(
      /target CG "42" curated=unknown/,
    );
  });
});

describe('DKGAgent._resolveEncryptInlineChunked nonce domain', () => {
  it('uses publishOperationId, not batchId, as the chunked AEAD nonce domain', async () => {
    const signer = ethers.Wallet.createRandom();
    const agentLike = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      gossip: {
        publish: vi.fn(async () => {}),
      },
      gossipWireIdFor: vi.fn((cgId: string) => cgId),
      _resolveCuratedChainKeyContext: vi.fn(async () => ({
        chainKey: new Uint8Array(32).fill(7),
        aeadCgId: '42',
      })),
      resolveWorkspaceGossipSigningAgent: vi.fn(async () => ({
        privateKey: signer.privateKey,
        agentAddress: signer.address,
      })),
    } as any;

    const encryptInlineChunked = await (DKGAgent.prototype as any)
      ._resolveEncryptInlineChunked.call(agentLike, '42');
    expect(encryptInlineChunked).toBeDefined();

    const batchId = ethers.getBytes(ethers.id('same-merkle-root'));
    const plaintextNquads = new TextEncoder().encode(
      '<urn:a> <urn:p> "one" <urn:g> .\n<urn:b> <urn:p> "two" <urn:g> .',
    );

    const first = await encryptInlineChunked({
      plaintextNquads,
      batchId,
      publishOperationId: 'publish-op-1',
    });
    const second = await encryptInlineChunked({
      plaintextNquads,
      batchId,
      publishOperationId: 'publish-op-2',
    });

    expect(Buffer.from(first.ciphertextChunksRoot).toString('hex'))
      .not.toBe(Buffer.from(second.ciphertextChunksRoot).toString('hex'));
  });
});
