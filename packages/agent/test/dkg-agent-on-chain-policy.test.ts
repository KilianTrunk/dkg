/**
 * Issue #872 / Codex review round 2, finding B regression tests for
 * `DKGAgent.getContextGraphOnChainPolicy`.
 *
 * The bug: the method's local-triple fallback used to read
 * `dkg:publishPolicy` / `dkg:accessPolicy` triples that
 * `createContextGraph` writes to `_meta` BEFORE on-chain
 * registration. For a CG still in the local-only `unregistered`
 * state those triples reflect the creator's intent, not an on-chain
 * commitment — but the daemon's import-artifact read relaxation
 * (`/api/assertion/import-artifact/{resolve,read-markdown}`) treats
 * a `{accessPolicy:0, publishPolicy:1}` answer as authoritative.
 * The combination meant the owner-guard could be bypassed on a CG
 * the curator hadn't actually committed to making public yet.
 *
 * Fix: gate the local-triple fallback on `isContextGraphRegistered`.
 * If the CG isn't registered on-chain (or replicated from a
 * registered peer), return `{}` and let callers fail closed.
 *
 * These tests bind `DKGAgent.prototype.getContextGraphOnChainPolicy`
 * to a minimal stub (same pattern as `dkg-agent-diagnostics.test.ts`)
 * so the assertions stay focused on the gating logic and don't drag
 * in libp2p / chain / storage initialisation.
 */
import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

interface ChainStub {
  getContextGraphAccessPolicy?: (id: bigint) => Promise<number>;
  getContextGraphPublishPolicy?: (id: bigint) => Promise<{
    publishPolicy: number;
    publishAuthority: string;
  }>;
}

interface AgentStub {
  onChainAccessPolicyCache: Map<string, number>;
  onChainPublishPolicyCache: Map<string, number>;
  subscribedContextGraphs: Map<string, { onChainId?: string }>;
  getContextGraphOnChainId: (id: string) => Promise<string | null>;
  isContextGraphRegistered: (id: string) => Promise<boolean>;
  getStoredContextGraphRegistrationOptions: (id: string) => Promise<{
    publishPolicy?: number;
    publishAuthorityAccountId?: bigint;
  }>;
  readLocalAccessPolicyEnum: (id: string) => Promise<number | undefined>;
  chain?: ChainStub;
  log: { warn: (ctx: unknown, msg: string) => void };
}

function makeStub(overrides: Partial<AgentStub> = {}): AgentStub {
  return {
    onChainAccessPolicyCache: new Map(),
    onChainPublishPolicyCache: new Map(),
    subscribedContextGraphs: new Map(),
    getContextGraphOnChainId: vi.fn(async () => null),
    isContextGraphRegistered: vi.fn(async () => false),
    getStoredContextGraphRegistrationOptions: vi.fn(async () => ({})),
    readLocalAccessPolicyEnum: vi.fn(async () => undefined),
    chain: undefined,
    log: { warn: vi.fn() },
    ...overrides,
  };
}

async function callPolicy(stub: AgentStub, contextGraphId: string) {
  return (DKGAgent.prototype as any).getContextGraphOnChainPolicy.call(stub, contextGraphId);
}

describe('DKGAgent.getContextGraphOnChainPolicy', () => {
  // Cache-hit path: chain-event-populated entries answer immediately
  // without consulting registration status or local triples.
  it('returns cached on-chain policies when both enums are present', async () => {
    const stub = makeStub({
      onChainAccessPolicyCache: new Map([['cg-1', 0]]),
      onChainPublishPolicyCache: new Map([['cg-1', 1]]),
    });
    const result = await callPolicy(stub, 'cg-1');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    // Cache hit short-circuits before registration status / local
    // fallback — neither stub should have been invoked.
    expect(stub.isContextGraphRegistered).not.toHaveBeenCalled();
    expect(stub.getStoredContextGraphRegistrationOptions).not.toHaveBeenCalled();
    expect(stub.readLocalAccessPolicyEnum).not.toHaveBeenCalled();
  });

  // Round 2, finding B: the regression test. A CG that exists
  // locally (with public + open create-time triples) but has NOT
  // been confirmed on-chain must NOT contribute a positive policy
  // answer via the local fallback — that would let the daemon's
  // read relaxation bypass the owner guard on a CG the curator
  // hasn't actually committed to making public yet.
  it('returns {} when on-chain caches miss AND the CG is not registered (#872 Codex round 2 finding B)', async () => {
    const stub = makeStub({
      isContextGraphRegistered: vi.fn(async () => false),
      // These stubs would return public + open if the fallback ran —
      // the gating must short-circuit BEFORE calling them. Use
      // `.toHaveBeenCalled` to prove the gate fired.
      getStoredContextGraphRegistrationOptions: vi.fn(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: vi.fn(async () => 0),
    });
    const result = await callPolicy(stub, 'cg-unregistered');
    expect(result).toEqual({});
    expect(stub.isContextGraphRegistered).toHaveBeenCalledWith('cg-unregistered');
    expect(stub.getStoredContextGraphRegistrationOptions).not.toHaveBeenCalled();
    expect(stub.readLocalAccessPolicyEnum).not.toHaveBeenCalled();
  });

  // Companion: when the CG IS registered, the local-triple fallback
  // still runs so creators and gossip-recipients of a registered CG
  // get the relaxation immediately after a daemon restart (no chain
  // RPC required). This is the original #872 fallback behaviour;
  // round 2's gate doesn't break it for registered CGs.
  it('falls back to local triples when the CG is registered but caches are cold', async () => {
    const stub = makeStub({
      isContextGraphRegistered: vi.fn(async () => true),
      getStoredContextGraphRegistrationOptions: vi.fn(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: vi.fn(async () => 0),
    });
    const result = await callPolicy(stub, 'cg-registered');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect(stub.isContextGraphRegistered).toHaveBeenCalledWith('cg-registered');
    expect(stub.getStoredContextGraphRegistrationOptions).toHaveBeenCalledWith('cg-registered');
    expect(stub.readLocalAccessPolicyEnum).toHaveBeenCalledWith('cg-registered');
  });

  // Defensive: `isContextGraphRegistered` failing (e.g. SPARQL
  // store transient error) must NOT unlock the fallback. We
  // catch-and-treat-as-false in the production code so the gate
  // remains closed even when the registration probe itself errors.
  it('treats isContextGraphRegistered() rejections as not-registered', async () => {
    const stub = makeStub({
      isContextGraphRegistered: vi.fn(async () => { throw new Error('store unavailable'); }),
      getStoredContextGraphRegistrationOptions: vi.fn(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: vi.fn(async () => 0),
    });
    const result = await callPolicy(stub, 'cg-probe-failed');
    expect(result).toEqual({});
    expect(stub.getStoredContextGraphRegistrationOptions).not.toHaveBeenCalled();
    expect(stub.readLocalAccessPolicyEnum).not.toHaveBeenCalled();
  });

  // Mixed cache hit: when only one enum is cached AND the CG is
  // registered, the fallback fills in the missing half.
  it('uses local triples only for the half of the answer that the cache misses (registered CG)', async () => {
    const stub = makeStub({
      onChainAccessPolicyCache: new Map([['cg-2', 0]]),
      onChainPublishPolicyCache: new Map(),
      isContextGraphRegistered: vi.fn(async () => true),
      getStoredContextGraphRegistrationOptions: vi.fn(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: vi.fn(async () => 0),
    });
    const result = await callPolicy(stub, 'cg-2');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    // Access policy was a cache hit; we still ran the registered
    // gate then filled in publishPolicy from local triples. The
    // access-policy local lookup may or may not run depending on
    // ordering; the only invariant we need is that the answer is
    // correct.
    expect(stub.getStoredContextGraphRegistrationOptions).toHaveBeenCalled();
  });

  // Round 3, the regression test. Non-creator peers never receive
  // the `dkg:publishPolicy` triple — it's only written to local
  // `_meta` by the creator's `createContextGraph` call. After a
  // daemon restart, the in-memory chain-event cache is empty too,
  // so the only durable answer for `publishPolicy` is the chain
  // itself. The fallback runs `chain.getContextGraphPublishPolicy`
  // (and `getContextGraphAccessPolicy` for parity) when the CG is
  // confirmed registered, populates the cache, and returns the
  // chain values.
  it('falls back to chain RPC when a registered CG has no local publishPolicy (non-creator peer) (#872 Codex round 3)', async () => {
    const getContextGraphPublishPolicy = vi.fn(async () => ({
      publishPolicy: 1,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const getContextGraphAccessPolicy = vi.fn(async () => 0);
    const stub = makeStub({
      // Subscribed CG — cleartext id maps to a numeric on-chain id.
      // The fallback must look up that mapping (creators get it
      // from `subscribedContextGraphs`; non-creator peers via the
      // local ontology triple read by `getContextGraphOnChainId`).
      subscribedContextGraphs: new Map([['cg-public-open', { onChainId: '42' }]]),
      isContextGraphRegistered: vi.fn(async () => true),
      // Non-creator peer: no creator-written local triples.
      getStoredContextGraphRegistrationOptions: vi.fn(async () => ({})),
      readLocalAccessPolicyEnum: vi.fn(async () => undefined),
      chain: { getContextGraphPublishPolicy, getContextGraphAccessPolicy },
    });
    const result = await callPolicy(stub, 'cg-public-open');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect(getContextGraphPublishPolicy).toHaveBeenCalledWith(42n);
    expect(getContextGraphAccessPolicy).toHaveBeenCalledWith(42n);
    // Cache populated under the numeric on-chain id so subsequent
    // calls don't re-RPC.
    expect(stub.onChainPublishPolicyCache.get('42')).toBe(1);
    expect(stub.onChainAccessPolicyCache.get('42')).toBe(0);
  });

  // Round 3, defensive: chain RPC failure must not throw out of
  // `getContextGraphOnChainPolicy`. The function logs a warning
  // and leaves the field undefined; the daemon route then falls
  // back to the strict guard (fail-closed).
  it('treats chain.getContextGraphPublishPolicy() rejections as unknown and logs a warning', async () => {
    const getContextGraphPublishPolicy = vi.fn(async () => { throw new Error('rpc unavailable'); });
    const stub = makeStub({
      subscribedContextGraphs: new Map([['cg-rpc-fail', { onChainId: '7' }]]),
      isContextGraphRegistered: vi.fn(async () => true),
      // accessPolicy IS available locally (open-CG ontology
      // triple); only publishPolicy needs the chain.
      readLocalAccessPolicyEnum: vi.fn(async () => 0),
      chain: { getContextGraphPublishPolicy },
    });
    const result = await callPolicy(stub, 'cg-rpc-fail');
    expect(result).toEqual({ accessPolicy: 0 });
    expect(getContextGraphPublishPolicy).toHaveBeenCalledWith(7n);
    expect(stub.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: expect.any(String) }),
      expect.stringMatching(/chain\.getContextGraphPublishPolicy\(7\) failed/),
    );
    // Cache MUST NOT be populated with an undefined value.
    expect(stub.onChainPublishPolicyCache.has('7')).toBe(false);
  });

  // Round 3 cross-check with round 2's gate. The unregistered case
  // MUST NOT hit the chain — the round-2 fail-closed return short-
  // circuits before any RPC.
  it('does NOT make a chain RPC call when the CG is unregistered (round 2 gate still holds)', async () => {
    const getContextGraphPublishPolicy = vi.fn(async () => ({
      publishPolicy: 1,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const getContextGraphAccessPolicy = vi.fn(async () => 0);
    const stub = makeStub({
      subscribedContextGraphs: new Map([['cg-unregistered', { onChainId: '99' }]]),
      isContextGraphRegistered: vi.fn(async () => false),
      chain: { getContextGraphPublishPolicy, getContextGraphAccessPolicy },
    });
    const result = await callPolicy(stub, 'cg-unregistered');
    expect(result).toEqual({});
    expect(getContextGraphPublishPolicy).not.toHaveBeenCalled();
    expect(getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  // Round 3 — creator's local-triple path stays fast: when local
  // triples answer both fields, no chain RPC is issued.
  it('does NOT make a chain RPC call when local triples cover both fields (creator path)', async () => {
    const getContextGraphPublishPolicy = vi.fn(async () => ({
      publishPolicy: 1,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const getContextGraphAccessPolicy = vi.fn(async () => 0);
    const stub = makeStub({
      subscribedContextGraphs: new Map([['cg-creator', { onChainId: '11' }]]),
      isContextGraphRegistered: vi.fn(async () => true),
      getStoredContextGraphRegistrationOptions: vi.fn(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: vi.fn(async () => 0),
      chain: { getContextGraphPublishPolicy, getContextGraphAccessPolicy },
    });
    const result = await callPolicy(stub, 'cg-creator');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect(getContextGraphPublishPolicy).not.toHaveBeenCalled();
    expect(getContextGraphAccessPolicy).not.toHaveBeenCalled();
  });

  // Round 4 — the regression test for the daemon-ready hang. If
  // the configured chain RPC stack is exhausted (every endpoint
  // returning 429 / hanging on connect / unreachable), the
  // fallback RPC call would block indefinitely waiting for the
  // chain client to give up. That's catastrophic on the daemon-
  // ready path (the CLI-7 `register exhausts configured chain RPC
  // endpoints` test exceeds its 45s readiness budget). The fix is
  // a bounded 2.5s per-call timeout inside the fallback: the race
  // returns `TIMEOUT_SENTINEL`, the policy field is left
  // undefined, a warning is logged, and the caller fails-closed.
  it('returns undefined (with warning) when the chain-RPC fallback exceeds the bounded timeout (#872 Codex round 4)', async () => {
    vi.useFakeTimers();
    try {
      // Promise that never resolves — emulates an RPC stack that
      // hasn't given up yet because every endpoint is 429-ing.
      const neverResolves = new Promise<{ publishPolicy: number; publishAuthority: string }>(() => {});
      const getContextGraphPublishPolicy = vi.fn(() => neverResolves);
      const stub = makeStub({
        subscribedContextGraphs: new Map([['cg-slow-rpc', { onChainId: '13' }]]),
        isContextGraphRegistered: vi.fn(async () => true),
        // accessPolicy answered locally so the test isolates the
        // publishPolicy timeout path.
        readLocalAccessPolicyEnum: vi.fn(async () => 0),
        chain: { getContextGraphPublishPolicy },
      });
      const promise = callPolicy(stub, 'cg-slow-rpc');
      // Drain microtasks (so the fallback is awaiting the race)
      // and then trip the 2.5s timer.
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await promise;
      expect(result).toEqual({ accessPolicy: 0 });
      expect(getContextGraphPublishPolicy).toHaveBeenCalledWith(13n);
      expect(stub.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: expect.any(String) }),
        expect.stringMatching(/getContextGraphPublishPolicy\(13\) timed out after 2500ms/),
      );
      // Cache MUST NOT be populated with an undefined / partial answer.
      expect(stub.onChainPublishPolicyCache.has('13')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Round 3 — degenerate state: registered locally but the on-chain
  // id resolution fails (e.g. corrupted ontology graph). We can't
  // RPC without a numeric id, so we return whatever local triples
  // gave us and let the caller fail-closed.
  it('returns whatever local triples gave us when registered but on-chain id cannot be resolved', async () => {
    const getContextGraphPublishPolicy = vi.fn();
    const stub = makeStub({
      // No subscribed entry, and the SPARQL lookup returns null too.
      subscribedContextGraphs: new Map(),
      getContextGraphOnChainId: vi.fn(async () => null),
      isContextGraphRegistered: vi.fn(async () => true),
      readLocalAccessPolicyEnum: vi.fn(async () => 0),
      chain: { getContextGraphPublishPolicy },
    });
    const result = await callPolicy(stub, 'cg-no-onchain-id');
    expect(result).toEqual({ accessPolicy: 0 });
    expect(getContextGraphPublishPolicy).not.toHaveBeenCalled();
  });
});
