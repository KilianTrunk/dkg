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
 * policy — but only AFTER a LIVE on-chain proof. A definitively-public,
 * LIVE CG (policy 0) takes the plaintext path regardless of any allowedAgent
 * list, while curated / invite-only / unknown / not-live CGs keep encrypting
 * (fail-closed). The liveness gate is essential: chain adapters return
 * access-policy 0 (= public) for UNKNOWN ids (Solidity default-zero), and
 * every local signal (policy cache, rehydrated subscription, persisted
 * `...OnChainId` triple, local `accessPolicy` literal) can be stale or
 * probe-poisoned after a devnet reset / partial registration.
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
  // chain.isContextGraphActiveOnChain liveness probe — the GATE that any
  // "public ⇒ plaintext" decision now depends on. `true` (default) → the slot
  // is registered & live; `false` → unknown / stale / not live; `'absent'` →
  // the probe isn't implemented (older chain adapter); Error → the probe throws.
  activeOnChain?: boolean | 'absent' | Error;
} = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const chain: Record<string, unknown> = {};
  if (opts.exposeAccessPolicy !== false) {
    chain.getContextGraphAccessPolicy = vi.fn(async (_id: bigint) => {
      if (opts.accessPolicyError) throw opts.accessPolicyError;
      return opts.accessPolicy ?? 0;
    });
  }
  if (opts.activeOnChain !== 'absent') {
    chain.isContextGraphActiveOnChain = vi.fn(async (_id: bigint) => {
      if (opts.activeOnChain instanceof Error) throw opts.activeOnChain;
      // Default true: a registered, live slot. Tests opt out with `false`.
      return opts.activeOnChain ?? true;
    });
  }
  // The store resolver (resolveWorkspaceAgentRecipients) is the only consumer
  // of store.query on these paths; an empty result → no allowlist → it returns
  // requiresEncryption=false while still proving it WAS consulted (delegation).
  const storeQuery = vi.fn(async () => ({ type: 'bindings', bindings: [] as unknown[] }));
  const agentLike: any = {
    log,
    chain,
    store: { query: storeQuery },
    onChainAccessPolicyCache: opts.cache ?? new Map<string, number>(),
    getContextGraphOnChainId: vi.fn(async () => {
      if (opts.onChainIdError) throw opts.onChainIdError;
      // `undefined` opt → default to a resolvable numeric id; explicit
      // `null` → unresolvable (no local CG with this id).
      return opts.onChainId === undefined ? '1' : opts.onChainId;
    }),
    isPrivateContextGraph: vi.fn(async () => opts.isPrivate ?? false),
  };
  // Bind the prototype methods under test so `this` resolves to agentLike.
  agentLike.isContextGraphPublicOnChain = (DKGAgent.prototype as any).isContextGraphPublicOnChain;
  agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;
  agentLike.resolveWorkspaceRecipientsGated = (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated;
  agentLike._resolveCuratedChainKeyContext = (DKGAgent.prototype as any)._resolveCuratedChainKeyContext;
  return agentLike;
}

const isPublic = (a: any, cgId = '0xCURATOR/experimental-music') =>
  (DKGAgent.prototype as any).isContextGraphPublicOnChain.call(a, cgId);

describe('DKGAgent.isContextGraphPublicOnChain', () => {
  it('returns true for a LIVE CG whose on-chain access policy is public (0)', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0 });
    await expect(isPublic(agentLike)).resolves.toBe(true);
    expect(agentLike.chain.isContextGraphActiveOnChain).toHaveBeenCalledWith(1n);
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(1n);
    expect(agentLike.onChainAccessPolicyCache.get('1')).toBe(0);
  });

  it('returns false for a LIVE CG whose on-chain access policy is private (1)', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 1 });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect(agentLike.onChainAccessPolicyCache.get('1')).toBe(1);
  });

  it('uses the cached policy without an extra access-policy RPC (still proves liveness)', async () => {
    // The cache only short-circuits the POLICY read; the live-on-chain proof
    // always runs first, so a probe-poisoned default-0 for an unregistered id
    // can never be served from cache (that id would not be live).
    const cache = new Map<string, number>([['1', 0]]);
    const agentLike = makeAgentLike({ onChainId: '1', cache, accessPolicy: 1 });
    await expect(isPublic(agentLike)).resolves.toBe(true);
    expect(agentLike.chain.isContextGraphActiveOnChain).toHaveBeenCalledWith(1n);
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('fails closed (false) when the on-chain id cannot be resolved', async () => {
    const agentLike = makeAgentLike({ onChainId: null });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect(agentLike.chain.isContextGraphActiveOnChain).not.toHaveBeenCalled();
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

  it('fails closed when the slot is NOT live on-chain — never reads (default-zero) policy (#884 review)', async () => {
    // The core safety gate. A resolvable id (local mapping or bare numeric)
    // that the chain reports as NOT active must NOT be trusted: an unregistered
    // id reads back access-policy 0 (Solidity default-zero) and would leak
    // plaintext. Liveness fails → fail closed, no policy read.
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, activeOnChain: false });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect(agentLike.chain.isContextGraphActiveOnChain).toHaveBeenCalledWith(1n);
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('fails closed when no liveness probe is available (older chain adapter) (#884 review)', async () => {
    // Without isContextGraphActiveOnChain we cannot prove the slot is live, so
    // we never trust a (possibly default-zero / stale) access policy.
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, activeOnChain: 'absent' });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('fails closed when the liveness probe throws (#884 review)', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, activeOnChain: new Error('rpc flake') });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('trusts a bare numeric on-chain id only after a LIVE proof — public CG stays plaintext (#884 numeric-id case)', async () => {
    // `getContextGraphOnChainId` returns null for a bare numeric id (no local
    // CG by that name). A public registered CG addressed by its numeric
    // on-chain id — e.g. share('42', ...) — must still be detected as public,
    // but ONLY because the chain confirms slot 42 is live & public.
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 0, activeOnChain: true });
    await expect(isPublic(agentLike, '42')).resolves.toBe(true);
    expect(agentLike.chain.isContextGraphActiveOnChain).toHaveBeenCalledWith(42n);
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
    expect(agentLike.onChainAccessPolicyCache.get('42')).toBe(0);
  });

  it('does NOT trust an UNKNOWN numeric id (unregistered / not live) — fail-closed (#884 review)', async () => {
    // A local graph whose user-chosen id is numeric (e.g.
    // createContextGraph({ id: "42", private: true })) but is NOT registered
    // reports not-live on-chain. The bare-numeric path must fail closed even
    // though the chain would default an unknown id to policy 0.
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 0, activeOnChain: false });
    await expect(isPublic(agentLike, '42')).resolves.toBe(false);
    expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  it('returns false for a LIVE numeric on-chain id whose policy is private (#884 fail-closed)', async () => {
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 1, activeOnChain: true });
    await expect(isPublic(agentLike, '7')).resolves.toBe(false);
    expect(agentLike.chain.isContextGraphActiveOnChain).toHaveBeenCalledWith(7n);
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(7n);
  });

  it('resolves a REGISTERED numeric-named local CG to its mapped on-chain policy (#884 review)', async () => {
    // Local-id resolution is AUTHORITATIVE for ADDRESSING: a registered CG
    // whose user-chosen local id happens to be numeric ("42") maps to its
    // actual on-chain id (here "99"). The helper proves slot 99 is live, then
    // reads policy for that mapped id — it never regresses a genuinely-
    // registered local graph onto the encrypted path just because its local id
    // looks like a number, nor reads policy for the wrong (bare "42") slot.
    const agentLike = makeAgentLike({ onChainId: '99', accessPolicy: 0, activeOnChain: true });
    await expect(isPublic(agentLike, '42')).resolves.toBe(true);
    expect(agentLike.getContextGraphOnChainId).toHaveBeenCalledWith('42');
    expect(agentLike.chain.isContextGraphActiveOnChain).toHaveBeenCalledWith(99n);
    expect(agentLike.chain.getContextGraphAccessPolicy).toHaveBeenCalledWith(99n);
  });

  it('logs a diagnostic (not silent) when a lookup flakes before failing closed (#884 review 🟡)', async () => {
    const agentLike = makeAgentLike({ accessPolicyError: new Error('rpc unavailable') });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    // Operators get a signal explaining WHY the public override was skipped.
    expect(agentLike.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('isContextGraphPublicOnChain'),
    );
  });

  it('bounds the liveness read — a HUNG RPC fails closed instead of hanging (#884 review)', async () => {
    vi.useFakeTimers();
    try {
      const agentLike = makeAgentLike({ onChainId: '1' });
      // Liveness probe hangs (never resolves / never rejects) instead of failing.
      agentLike.chain.isContextGraphActiveOnChain = vi.fn(() => new Promise(() => {}));
      const pending = isPublic(agentLike);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe(false);
      expect(agentLike.log.warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('timed out'),
      );
      // A hung liveness read must never reach the policy read.
      expect(agentLike.chain.getContextGraphAccessPolicy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the access-policy read — a HUNG RPC fails closed instead of hanging (#884 review)', async () => {
    vi.useFakeTimers();
    try {
      const agentLike = makeAgentLike({ onChainId: '1' });
      // Liveness resolves (live), but the policy read hangs.
      agentLike.chain.getContextGraphAccessPolicy = vi.fn(() => new Promise(() => {}));
      const pending = isPublic(agentLike);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe(false);
      expect(agentLike.log.warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('timed out'),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DKGAgent.resolveWorkspaceRecipientsGated (gate-before)', () => {
  it('returns plaintext for a LIVE public CG WITHOUT resolving recipient keys', async () => {
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

  it('delegates (encrypted path) when the on-chain probe cannot prove the CG is live — NO local-metadata bypass (#884 review)', async () => {
    // A local accessPolicy="public" literal (or any local signal) must NOT
    // override a failed on-chain liveness proof: a pre-registration / stale
    // local graph would otherwise leak allowlisted traffic in plaintext. With
    // liveness false we delegate to the store resolver (encrypted path).
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, activeOnChain: false });
    await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '0xCURATOR/not-yet-live' },
    );
    expect(agentLike.store.query).toHaveBeenCalled();
  });

  it('returns plaintext for a LIVE public CG addressed by its numeric on-chain id WITHOUT the store resolver (#884)', async () => {
    // The end-to-end shape of the bug: share('42', ...) on a public,
    // registered & live CG must take the plaintext path. Pre-fix, the numeric
    // id didn't resolve, isContextGraphPublicOnChain returned false, and this
    // fell through to resolveWorkspaceAgentRecipients (the encrypted/gated
    // path that triggered the HTTP 500).
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 0, activeOnChain: true });
    const resolution = await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '42' },
    );
    expect(resolution).toEqual({ requiresEncryption: false, recipients: [] });
    expect(agentLike.store.query).not.toHaveBeenCalled();
  });
});

describe('DKGAgent publish-inline gating respects on-chain public policy', () => {
  const resolveInline = (agentLike: any, cgId: string) =>
    (DKGAgent.prototype as any)._resolveEncryptInlinePayload.call(agentLike, cgId, undefined, undefined, undefined);

  it('keeps a public-on-chain CG on the plaintext path even when the allowlist heuristic marks it private', async () => {
    // `isPrivateContextGraph` returns true (its allowlist-implies-private
    // heuristic fires for a public CG with a publish-authority allowlist),
    // but the on-chain policy is public & live — the override must win.
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, isPrivate: true });
    await expect(resolveInline(agentLike, '0xCURATOR/experimental-music')).resolves.toBeUndefined();
    expect(agentLike.isPrivateContextGraph).not.toHaveBeenCalled();
  });
});
