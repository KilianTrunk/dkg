/**
 * Regression coverage for LU-5 inline-payload encryption policy.
 *
 * Numeric context graph ids are chain-owned policy surfaces. If the
 * daemon cannot read chain truth for one of them, publishing must fail
 * closed instead of falling back to plaintext.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';

/**
 * Hand-rolled call recorder: a real function that runs `impl` and records
 * every argument tuple it was invoked with. Replaces the vitest spy/mock API
 * with a plain observable seam — `rec.calls` holds the argument tuples in
 * invocation order, so the assertions read the same intent as the former
 * `toHaveBeenCalledWith` / `not.toHaveBeenCalled` checks.
 */
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

/**
 * Build a REAL DKGAgent on the in-memory mock chain so the policy probe runs
 * against production code (real `store`, real `getContextGraphOnChainId` /
 * `contextGraphExists` / `isPrivateContextGraph` / `resolveOnChainAccessPolicyState`
 * / `readLiveOnChainAccessPolicy`). The numeric-id cases need a controlled
 * chain seam: the default mock returns `isContextGraphActiveOnChain(id) ===
 * false` for slots that were never minted, so we reassign the two chain
 * methods with recorders to drive each scenario (live/not-live, public/
 * curated, getter-throws, getter-absent). That is a real agent with a
 * controlled chain seam, not a mock of the agent.
 */
async function makeAgent(opts: {
  isPrivate?: boolean;
  accessPolicy?: 0 | 1;
  accessPolicyError?: Error;
  exposeAccessPolicy?: boolean;
  // chain.isContextGraphActiveOnChain liveness probe — the gate the numeric
  // branch of isContextGraphPublicOnChain now depends on. `true` (default) →
  // the slot is registered & live; `false` → unknown / not live; `'absent'` →
  // the probe isn't implemented.
  activeOnChain?: boolean | 'absent';
} = {}): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'EncryptInlinePolicyTest',
    chainAdapter: new MockChainAdapter(),
  });
  const chain = (agent as any).chain as Record<string, unknown>;

  // Observe log.warn (test 3 asserts the fail-closed diagnostic) by replacing
  // the method with a recorder that swallows the call. Each test builds a
  // fresh agent, so there is nothing to restore afterward.
  (agent as any).log.warn = recorder((..._args: unknown[]) => undefined);

  // Chain seam: getContextGraphAccessPolicy. Present unless the test models a
  // minimal adapter that never implemented the getter.
  if (opts.exposeAccessPolicy !== false) {
    chain.getContextGraphAccessPolicy = recorder(async (..._args: [bigint]) => {
      if (opts.accessPolicyError) throw opts.accessPolicyError;
      return opts.accessPolicy ?? 0;
    });
  } else {
    // `delete` can't remove MockChainAdapter's PROTOTYPE method, so shadow it
    // with an own `undefined` property — production gates on
    // `typeof chain.getContextGraphAccessPolicy === 'function'`, which then
    // reads false and takes the fail-closed "access-policy is unknown" branch.
    chain.getContextGraphAccessPolicy = undefined;
  }

  // Chain seam: isContextGraphActiveOnChain liveness probe.
  if (opts.activeOnChain !== 'absent') {
    chain.isContextGraphActiveOnChain = recorder(async (..._args: [bigint]) => opts.activeOnChain ?? true);
  } else {
    // Same prototype-shadowing as above for the probe-absent branch.
    chain.isContextGraphActiveOnChain = undefined;
  }

  // isPrivateContextGraph drives the 'unregistered' / 'unknown' local-curated
  // fallback. Override with a recorder so the harness controls the local ACL
  // signal (the real store has no CG seeded). Default `false` → public/local.
  (agent as any).isPrivateContextGraph = recorder(async (..._args: [string]) => opts.isPrivate ?? false);

  return agent;
}

async function resolveEncryptInlinePayload(
  agent: DKGAgent,
  contextGraphId: string,
  publishContextGraphId?: string,
) {
  // RFC-39 / LU-11 refactor extracted the access-policy probe + curated
  // bootstrap into the private helper `_resolveCuratedChainKeyContext`,
  // which `_resolveEncryptInlinePayload` now delegates to before returning
  // either the AEAD callback or `undefined`. We run the real production method
  // on a real agent, so the helper and every collaborator already exist on
  // the instance. All test cases in this file short-circuit inside the policy
  // probe (public CG → undefined, unknown policy → throw) so they never touch
  // the curated bootstrap dependencies (`createAndDistributeSwmSenderKeyEpoch`
  // etc.).
  return (agent as any)._resolveEncryptInlinePayload(
    contextGraphId,
    undefined,
    undefined,
    publishContextGraphId,
  );
}

describe('DKGAgent._resolveEncryptInlinePayload policy lookup', () => {
  it('keeps non-numeric local public CGs on the plaintext path', async () => {
    const agent = await makeAgent({ exposeAccessPolicy: false });
    try {
      await expect(resolveEncryptInlinePayload(agent, 'local-public-cg')).resolves.toBeUndefined();
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('uses chain policy for numeric public CGs before choosing plaintext', async () => {
    const agent = await makeAgent({ accessPolicy: 0 });
    try {
      await expect(resolveEncryptInlinePayload(agent, '42')).resolves.toBeUndefined();
      expect((agent as any).chain.getContextGraphAccessPolicy.calls.at(-1)).toEqual([42n]);
      expect((agent as any).onChainAccessPolicyCache.get('42')).toBe(0);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('fails closed when numeric target CG policy lookup is unavailable', async () => {
    const agent = await makeAgent({
      accessPolicyError: new Error('rpc unavailable'),
    });
    try {
      await expect(resolveEncryptInlinePayload(agent, '42')).rejects.toThrow(
        /publish access-policy is unknown/,
      );
      expect((agent as any).log.warn.calls.at(-1)).toEqual([
        expect.anything(),
        expect.stringContaining('treating as UNKNOWN'),
      ]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('fails closed when numeric target CG policy getter is missing', async () => {
    const agent = await makeAgent({ exposeAccessPolicy: false });
    try {
      await expect(resolveEncryptInlinePayload(agent, '42')).rejects.toThrow(
        /publish access-policy is unknown/,
      );
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does NOT classify an UNREGISTERED (not live) numeric id as public (liveness gate) (#884 review)', async () => {
    // The liveness probe reports slot 999 NOT active. Even though the chain
    // getter would return the permissive default (0) for an unknown id, the
    // gate must short-circuit isContextGraphPublicOnChain to false BEFORE any
    // access-policy read — proving the suite exercises the live-on-chain proof
    // rather than blanket-trusting numeric strings.
    const agent = await makeAgent({ accessPolicy: 0, activeOnChain: false });
    try {
      await expect(
        (agent as any).isContextGraphPublicOnChain('999'),
      ).resolves.toBe(false);
      expect((agent as any).chain.getContextGraphAccessPolicy.calls).toEqual([]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('fails closed when a remap target numeric CG policy cannot be resolved', async () => {
    const agent = await makeAgent({
      accessPolicyError: new Error('rpc unavailable'),
    });
    try {
      await expect(resolveEncryptInlinePayload(agent, 'local-public-cg', '42')).rejects.toThrow(
        /target CG "42" curated=unknown/,
      );
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('treats an explicit numeric remap target as a raw on-chain slot', async () => {
    const contextGraphExists = vi.fn(async (id: string) => {
      if (id === '42') throw new Error('numeric local lookup should not run');
      return false;
    });
    const agentLike = {
      ...makeAgentLike({ accessPolicy: 0 }),
      getContextGraphOnChainId: vi.fn(async () => null),
      contextGraphExists,
    };

    await expect(resolveEncryptInlinePayload(agentLike, 'local-public-cg', '42')).resolves.toBeUndefined();
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
    expect(contextGraphExists).not.toHaveBeenCalledWith('42');
  });
});

describe('DKGAgent._publish inline encryption routing', () => {
  it('does not trust caller accessPolicy=public to bypass chain-confirmed encryption resolution', async () => {
    const encryptInlinePayload = vi.fn(async (plaintext: Uint8Array) => plaintext);
    const encryptInlineChunked = vi.fn();
    const publisherPublish = vi.fn(async () => ({
      status: 'confirmed',
      kaId: '1',
    }));
    const agentLike = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      subscribedContextGraphs: new Set(['local-cg']),
      contextGraphExists: vi.fn(async () => true),
      createV10ACKProvider: vi.fn(() => undefined),
      getContextGraphOnChainId: vi.fn(async () => '42'),
      chain: {},
      peerId: 'peer-1',
      publisher: {
        publish: publisherPublish,
      },
      broadcastPublish: vi.fn(async () => undefined),
      _resolveEncryptInlinePayload: vi.fn(async () => encryptInlinePayload),
      _resolveEncryptInlineChunked: vi.fn(async () => encryptInlineChunked),
    } as any;

    await (DKGAgent.prototype as any)._publish.call(
      agentLike,
      'local-cg',
      [{ subject: 's', predicate: 'p', object: 'o', graph: 'g' }],
      undefined,
      {
        accessPolicy: 'public',
        subGraphName: 'sg-a',
        publisherNodeIdentityIdOverride: 0n,
      },
    );

    expect(agentLike._resolveEncryptInlinePayload).toHaveBeenCalledWith(
      'local-cg',
      'sg-a',
      undefined,
      '42',
    );
    expect(agentLike._resolveEncryptInlineChunked).toHaveBeenCalledWith(
      'local-cg',
      'sg-a',
      undefined,
      '42',
    );
    expect(publisherPublish).toHaveBeenCalledWith(expect.objectContaining({
      accessPolicy: 'public',
      publisherNodeIdentityIdOverride: 0n,
      encryptInlinePayload,
      encryptInlineChunked,
    }));
  });
});

describe('DKGAgent._resolveEncryptInlineChunked nonce domain', () => {
  it('uses publishOperationId, not batchId, as the chunked AEAD nonce domain', async () => {
    const signer = ethers.Wallet.createRandom();
    // The chunked-emit closure consults a handful of DI seams
    // (`_resolveCuratedChainKeyContext` for the chainKey, `gossipWireIdFor` /
    // `gossip.publish` for the SWM fan-out, `resolveWorkspaceGossipSigningAgent`
    // for the envelope signer). This test isolates the AEAD nonce-domain
    // behaviour, so each seam is a hand-rolled recorder rather than a real
    // gossip/curated-CG stack: the chainKey is fixed and the signer is a real
    // ethers wallet so the only variable across the two emits is the
    // publishOperationId.
    const agentLike = {
      log: {
        info: recorder((..._args: unknown[]) => undefined),
        warn: recorder((..._args: unknown[]) => undefined),
        error: recorder((..._args: unknown[]) => undefined),
        debug: recorder((..._args: unknown[]) => undefined),
      },
      gossip: {
        publish: recorder(async (..._args: unknown[]) => {}),
      },
      gossipWireIdFor: recorder((cgId: string) => cgId),
      _resolveCuratedChainKeyContext: recorder(async (..._args: unknown[]) => ({
        chainKey: new Uint8Array(32).fill(7),
        aeadCgId: '42',
      })),
      resolveWorkspaceGossipSigningAgent: recorder(async (..._args: unknown[]) => ({
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
