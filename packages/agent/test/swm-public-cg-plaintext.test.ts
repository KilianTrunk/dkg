/**
 * Regression coverage for the WM→SWM promote / publish gating bug on a
 * PUBLIC-on-chain context graph that carries a `DKG_ALLOWED_AGENT` list.
 *
 * On a public CG the allowedAgent list governs *publish authority*
 * (`publishPolicy`), not *read access*. The store-only recipient resolver
 * (`resolveWorkspaceAgentRecipients`) can't see chain truth, so it flags
 * any allowlisted CG as requiring encryption — which then bootstraps a
 * sender-key handshake that non-gated recipients reject ("not DKG-agent
 * gated"), surfacing as an HTTP 500 on promote (and later on publish).
 *
 * The fix gates the SWM-encryption decision on the CG's on-chain access
 * policy: a definitively-public CG (policy 0) takes the plaintext path
 * regardless of any allowedAgent list, while curated / invite-only /
 * unknown CGs keep encrypting (fail-closed).
 */
import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

type Policy = 0 | 1;

function makeAgentLike(opts: {
  onChainId?: string | null;
  accessPolicy?: Policy;
  accessPolicyError?: Error;
  exposeAccessPolicy?: boolean;
  cache?: Map<string, number>;
  isPrivate?: boolean;
  onChainIdError?: Error;
} = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const chain: Record<string, unknown> = {};
  if (opts.exposeAccessPolicy !== false) {
    chain.getContextGraphAccessPolicy = vi.fn(async (_id: bigint) => {
      if (opts.accessPolicyError) throw opts.accessPolicyError;
      return opts.accessPolicy ?? 0;
    });
  }
  const storeQuery = vi.fn(async () => ({ type: 'bindings', bindings: [] as unknown[] }));
  const agentLike: any = {
    log,
    chain,
    store: { query: storeQuery },
    onChainAccessPolicyCache: opts.cache ?? new Map<string, number>(),
    getContextGraphOnChainId: vi.fn(async () => {
      if (opts.onChainIdError) throw opts.onChainIdError;
      // `undefined` opt → default to a resolvable numeric id; explicit
      // `null` → unresolvable (local-only CG).
      return opts.onChainId === undefined ? '1' : opts.onChainId;
    }),
    isPrivateContextGraph: vi.fn(async () => opts.isPrivate ?? false),
  };
  // Bind the prototype methods under test so `this` resolves to agentLike.
  agentLike.isContextGraphPublicOnChain = (DKGAgent.prototype as any).isContextGraphPublicOnChain;
  agentLike.resolveWorkspaceRecipientsGated = (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated;
  agentLike._resolveCuratedChainKeyContext = (DKGAgent.prototype as any)._resolveCuratedChainKeyContext;
  return agentLike;
}

const isPublic = (a: any, cgId = '0xCURATOR/experimental-music') =>
  (DKGAgent.prototype as any).isContextGraphPublicOnChain.call(a, cgId);

describe('DKGAgent.isContextGraphPublicOnChain', () => {
  it('returns true for a CG whose on-chain access policy is public (0)', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0 });
    await expect(isPublic(agentLike)).resolves.toBe(true);
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(1n);
    expect(agentLike.onChainAccessPolicyCache.get('1')).toBe(0);
  });

  it('returns false for a CG whose on-chain access policy is private (1)', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 1 });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect(agentLike.onChainAccessPolicyCache.get('1')).toBe(1);
  });

  it('uses the cached policy without an extra chain RPC', async () => {
    const cache = new Map<string, number>([['1', 0]]);
    const agentLike = makeAgentLike({ onChainId: '1', cache, accessPolicy: 1 });
    await expect(isPublic(agentLike)).resolves.toBe(true);
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('fails closed (false) when the on-chain id cannot be resolved', async () => {
    const agentLike = makeAgentLike({ onChainId: null });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('fails closed (false) when the chain access-policy getter is missing', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', exposeAccessPolicy: false });
    await expect(isPublic(agentLike)).resolves.toBe(false);
  });

  it('fails closed (false) when the chain RPC throws', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicyError: new Error('rpc unavailable') });
    await expect(isPublic(agentLike)).resolves.toBe(false);
  });

  it('fails closed (false) when on-chain id resolution throws', async () => {
    const agentLike = makeAgentLike({ onChainIdError: new Error('store offline') });
    await expect(isPublic(agentLike)).resolves.toBe(false);
  });
});

describe('DKGAgent.resolveWorkspaceRecipientsGated (gate-before)', () => {
  it('returns plaintext for a public CG WITHOUT resolving recipient keys', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0 });
    const resolution = await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '0xCURATOR/experimental-music' },
    );
    expect(resolution).toEqual({ requiresEncryption: false, recipients: [] });
    // The store resolver MUST be skipped — a public CG never resolves
    // recipient keys (which would otherwise throw "Missing public
    // encryption key" for an allowlisted agent whose key isn't local).
    expect(agentLike.store.query).not.toHaveBeenCalled();
  });

  it('delegates to the store resolver for a non-public (curated) CG', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 1 });
    const resolution = await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '0xCURATOR/curated-cg' },
    );
    // Empty store bindings → no allowedAgents → store resolver returns
    // requiresEncryption=false, but it WAS consulted (delegation path).
    expect(resolution.requiresEncryption).toBe(false);
    expect(agentLike.store.query).toHaveBeenCalled();
  });

  it('delegates to the store resolver when the policy is unknown (fail-closed to encrypted path)', async () => {
    const agentLike = makeAgentLike({ onChainId: null });
    await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '0xCURATOR/unknown-cg' },
    );
    expect(agentLike.store.query).toHaveBeenCalled();
  });
});

describe('DKGAgent publish-inline gating respects on-chain public policy', () => {
  const resolveInline = (agentLike: any, cgId: string) =>
    (DKGAgent.prototype as any)._resolveEncryptInlinePayload.call(agentLike, cgId, undefined, undefined, undefined);

  it('keeps a public-on-chain CG on the plaintext path even when the allowlist heuristic marks it private', async () => {
    // `isPrivateContextGraph` returns true (its allowlist-implies-private
    // heuristic fires for a public CG with a publish-authority allowlist),
    // but the on-chain policy is public — the override must win.
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, isPrivate: true });
    await expect(resolveInline(agentLike, '0xCURATOR/experimental-music')).resolves.toBeUndefined();
    expect(agentLike.isPrivateContextGraph).not.toHaveBeenCalled();
  });
});
