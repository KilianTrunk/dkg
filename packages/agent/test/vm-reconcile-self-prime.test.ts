/**
 * Regression test for GH #1098 (layer 1) — the chain-driven VM reconcile sweep
 * must SELF-PRIME `onChainId` for a peer that subscribed to a PUBLIC CG BEFORE
 * its first publish. Such a peer has `subscribed: true` but no `onChainId` (only
 * curated CGs bind it on the ContextGraphCreated event; ACK-signers bind via the
 * storage-ACK hook), so the sweep would otherwise skip it forever and the peer
 * never reconciles the published KA into VM.
 *
 * This pins the state transition: a `subscribed && !onChainId` entry whose
 * ontology OnChainId quad is locally present gets bound + persisted, and the
 * sweep then triggers its reconcile. Hermetic — MockChainAdapter, no network.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';

interface AgentInternals {
  runVmReconcileSweep(): Promise<void>;
  selfPrimeSubscriptionOnChainId(
    localCgId: string,
    sub: { subscribed: boolean; coreHosted?: boolean; onChainId?: string },
    targetOnChainId?: bigint,
  ): Promise<string | null>;
  subscribedContextGraphs: Map<string, { subscribed: boolean; coreHosted?: boolean; onChainId?: string }>;
  reconcileCoalescer: { trigger: (cg: string) => void } | null;
  store: TripleStore;
}

// DKGNode getter throws on peerId access without a real start(); stub it so the
// subscription bookkeeping path runs (mirrors core-fills-gap.test.ts).
function stubNode(agent: DKGAgent): void {
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWSelfPrimeTestPeer',
    libp2p: { getPeers: () => [] },
  };
}

describe('GH #1098 — VM reconcile sweep self-primes onChainId for a pre-subscribed CG', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) { await agent.stop().catch(() => undefined); agent = null; }
  });

  it('binds onChainId from the ontology quad, persists, and triggers reconcile for a subscribed-but-unbound CG', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeSweep', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;

    const LOCAL = 'gh1098-presub';
    const ONCHAIN = '4242';

    // The publisher broadcasts the CG's OnChainId quad on the ontology topic at
    // publish time (durable _meta sync also delivers it). Seed it — this is the
    // exact source `getContextGraphOnChainId` reads.
    await internals.store.insert([{
      subject: `did:dkg:context-graph:${LOCAL}`,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      object: `"${ONCHAIN}"`,
      graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
    }]);

    // The #1098 state: a pre-subscribed member CG with NO onChainId bound.
    internals.subscribedContextGraphs.set(LOCAL, { subscribed: true });

    const triggered: string[] = [];
    internals.reconcileCoalescer = { trigger: (cg: string) => { triggered.push(cg); } };

    // Precondition: unbound before the sweep (so the assertion below is meaningful).
    expect(internals.subscribedContextGraphs.get(LOCAL)?.onChainId).toBeUndefined();

    await internals.runVmReconcileSweep();

    // Post-fix: the sweep self-primed onChainId from the ontology quad and then
    // — no longer skipped by the `!onChainId` guard — triggered its reconcile.
    expect(internals.subscribedContextGraphs.get(LOCAL)?.onChainId).toBe(ONCHAIN);
    expect(triggered).toContain(LOCAL);
  });

  it('KACG nudge targeting: binds ONLY the unbound CG whose on-chain id matches the event, not an unrelated one', async () => {
    // This exercises the SAME `selfPrimeSubscriptionOnChainId` helper the live
    // onKARegisteredToContextGraph nudge delegates to, with a `targetOnChainId`
    // (the event's CG id). The nudge loops subscribed-unbound CGs and binds the
    // one whose resolved id matches the event — so an unrelated CG must NOT bind.
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'SelfPrimeTargeted', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;

    const CG_MATCH = 'gh1098-match';
    const CG_OTHER = 'gh1098-other';
    const ON_MATCH = '500';
    const ON_OTHER = '600';
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    await internals.store.insert([
      { subject: `did:dkg:context-graph:${CG_MATCH}`, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${ON_MATCH}"`, graph: ontologyGraph },
      { subject: `did:dkg:context-graph:${CG_OTHER}`, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${ON_OTHER}"`, graph: ontologyGraph },
    ]);
    internals.subscribedContextGraphs.set(CG_MATCH, { subscribed: true });
    internals.subscribedContextGraphs.set(CG_OTHER, { subscribed: true });

    // Event for ON_MATCH: the other CG (resolves to ON_OTHER) must NOT bind.
    const other = await internals.selfPrimeSubscriptionOnChainId(CG_OTHER, internals.subscribedContextGraphs.get(CG_OTHER)!, BigInt(ON_MATCH));
    expect(other).toBeNull();
    expect(internals.subscribedContextGraphs.get(CG_OTHER)?.onChainId).toBeUndefined();

    // The matching CG binds.
    const matched = await internals.selfPrimeSubscriptionOnChainId(CG_MATCH, internals.subscribedContextGraphs.get(CG_MATCH)!, BigInt(ON_MATCH));
    expect(matched).toBe(ON_MATCH);
    expect(internals.subscribedContextGraphs.get(CG_MATCH)?.onChainId).toBe(ON_MATCH);
  });
});
