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
});
