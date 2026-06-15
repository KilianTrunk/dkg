import { describe, expect, it } from 'vitest';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { generateSubGraphRegistration } from '@origintrail-official/dkg-publisher';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { DKGAgent } from '../src/dkg-agent.js';

describe('ContextGraphMetaProjection', () => {
  it('enumerates declared context graph ids from ontology, agents, and root _meta graphs', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const ontologyId = 'projection-list-ontology';
    const agentsId = 'projection-list-agents';
    const metaId = '0x0000000000000000000000000000000000000abc/projection-list-meta';

    await store.insert([
      {
        subject: contextGraphDataGraphUri(ontologyId),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: contextGraphDataGraphUri(agentsId),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: agentsGraph,
      },
      {
        subject: contextGraphDataGraphUri(metaId),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: contextGraphMetaGraphUri(metaId),
      },
    ]);

    expect(await projection.listDeclaredContextGraphIds()).toEqual([
      agentsId,
      metaId,
      ontologyId,
    ].sort());
  });

  it('lets root _meta scalar fields override older ontology and agents declarations', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-meta-authoritative';
    const uri = contextGraphDataGraphUri(id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(id);

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Old ontology name"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000001', graph: ontologyGraph },
      { subject: uri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: '"101"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION, object: '"Old agents description"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000002', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: '"Fresh meta name"', graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION, object: '"Fresh meta description"', graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000003', graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000004', graph: metaGraph },
      { subject: uri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: '"202"', graph: metaGraph },
    ]);

    const meta = await projection.get(id);
    expect(meta.name).toBe('Fresh meta name');
    expect(meta.description).toBe('Fresh meta description');
    expect(meta.creator).toBe('did:dkg:agent:0x0000000000000000000000000000000000000003');
    expect(meta.curator).toBe('did:dkg:agent:0x0000000000000000000000000000000000000004');
    expect(meta.onChainId).toBe('202');
    expect(meta.creators).toEqual([
      'did:dkg:agent:0x0000000000000000000000000000000000000003',
      'did:dkg:agent:0x0000000000000000000000000000000000000002',
    ]);
    expect(meta.curators).toEqual([
      'did:dkg:agent:0x0000000000000000000000000000000000000004',
      'did:dkg:agent:0x0000000000000000000000000000000000000001',
    ]);
  });

  it('lets root _meta public access policy override older private declarations', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-meta-public-after-private';
    const uri = contextGraphDataGraphUri(id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(id);

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: metaGraph },
    ]);

    expect((await projection.get(id)).accessPolicy).toBe('public');
  });

  it('preserves case-sensitive projected metadata while folding address-only lists', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-case-sensitive-metadata';
    const uri = contextGraphDataGraphUri(id);
    const metaGraph = contextGraphMetaGraphUri(id);
    const address = '0x0000000000000000000000000000000000000aBc';
    const addressVariant = '0x0000000000000000000000000000000000000AbC';
    const peer = '12D3KooWCaseSensitivePeer';
    const peerVariant = '12d3koowcasesensitivepeer';

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER, object: `"${peer}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER, object: `"${peerVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `"did:dkg:agent:${peer}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `"did:dkg:agent:${peerVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, object: `"identity:${peer}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, object: `"identity:${peerVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${address}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${addressVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, object: `"${address}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, object: `"${addressVariant}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: `"${address}"`, graph: metaGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: `"${addressVariant}"`, graph: metaGraph },
    ]);

    const meta = await projection.get(id);
    expect(meta.allowedPeers).toHaveLength(2);
    expect(meta.allowedPeers).toEqual(expect.arrayContaining([peer, peerVariant]));
    expect(meta.creators).toHaveLength(2);
    expect(meta.creators).toEqual(expect.arrayContaining([`did:dkg:agent:${peer}`, `did:dkg:agent:${peerVariant}`]));
    expect(meta.participantIdentityIds).toHaveLength(2);
    expect(meta.participantIdentityIds).toEqual(expect.arrayContaining([`identity:${peer}`, `identity:${peerVariant}`]));
    expect(meta.allowedAgents).toHaveLength(1);
    expect(meta.allowedAgents[0]?.toLowerCase()).toBe(address.toLowerCase());
    expect(meta.participantAgents).toHaveLength(1);
    expect(meta.participantAgents[0]?.toLowerCase()).toBe(address.toLowerCase());
    expect(meta.revokedAgents).toHaveLength(1);
    expect(meta.revokedAgents[0]?.toLowerCase()).toBe(address.toLowerCase());
  });

  it('loads AGENTS graph policy rows and invalidates allowlist mutations', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = '0x0000000000000000000000000000000000000abc/projection-agents-private';
    const uri = contextGraphDataGraphUri(id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(id);

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: ontologyGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0x0000000000000000000000000000000000000111', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: '"0x0000000000000000000000000000000000000333"', graph: agentsGraph },
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: '"0x0000000000000000000000000000000000000111"', graph: metaGraph },
    ]);

    const first = await projection.get(id);
    expect(first.accessPolicy).toBe('private');
    expect(first.curator).toBe('did:dkg:agent:0x0000000000000000000000000000000000000111');
    expect(first.allowedAgents).toEqual(['0x0000000000000000000000000000000000000111']);
    expect(first.revokedAgents).toEqual(['0x0000000000000000000000000000000000000333']);

    const addedAgent: Quad = {
      subject: uri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: '"0x0000000000000000000000000000000000000222"',
      graph: metaGraph,
    };
    await store.insert([addedAgent]);
    expect(projection.markDirtyFromQuads([addedAgent])).toEqual([id]);

    const second = await projection.get(id);
    expect(second.allowedAgents).toHaveLength(2);
    expect(second.allowedAgents).toEqual(expect.arrayContaining([
      '0x0000000000000000000000000000000000000111',
      '0x0000000000000000000000000000000000000222',
    ]));
  });

  it('does not dirty policy entries for unrelated tentative KC metadata', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-tentative-no-thrash';
    const uri = contextGraphDataGraphUri(id);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const metaGraph = contextGraphMetaGraphUri(id);

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
    ]);

    expect((await projection.get(id)).accessPolicy).toBeUndefined();

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: agentsGraph },
    ]);

    const tentativeQuad: Quad = {
      subject: `did:dkg:assertion:${id}:tentative`,
      predicate: 'https://dkg.network/ontology#assertionStatus',
      object: '"TENTATIVE"',
      graph: metaGraph,
    };
    const rootLikeDataQuad: Quad = {
      subject: uri,
      predicate: DKG_ONTOLOGY.SCHEMA_NAME,
      object: '"Not authoritative metadata"',
      graph: contextGraphDataGraphUri('projection-user-data'),
    };
    expect(projection.markDirtyFromQuads([tentativeQuad, rootLikeDataQuad])).toEqual([]);
    expect((await projection.get(id)).accessPolicy).toBeUndefined();

    projection.markDirty(id);
    expect((await projection.get(id)).accessPolicy).toBe('private');
  });

  it('rebuilds for callers that arrive after invalidation during an in-flight rebuild', async () => {
    let releaseFirstQuery!: () => void;
    const firstQuery = new Promise<void>((resolve) => { releaseFirstQuery = resolve; });
    let queryCalls = 0;
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const store = {
      async query(sparql: string) {
        queryCalls += 1;
        const callNumber = queryCalls;
        if (callNumber === 1) await firstQuery;
        if (callNumber <= 4) return { type: 'bindings', bindings: [] };
        if (sparql.includes(`<${agentsGraph}>`)) {
          return {
            type: 'bindings',
            bindings: [{ p: DKG_ONTOLOGY.DKG_ACCESS_POLICY, o: '"private"' }],
          };
        }
        return { type: 'bindings', bindings: [] };
      },
    } as unknown as TripleStore;
    const projection = new ContextGraphMetaProjection(store);

    const first = projection.get('projection-inflight-dirty');
    projection.markDirty('projection-inflight-dirty');
    const afterDirty = projection.get('projection-inflight-dirty');
    releaseFirstQuery();

    expect((await first).accessPolicy).toBeUndefined();
    expect((await afterDirty).accessPolicy).toBe('private');
    expect(queryCalls).toBeGreaterThan(4);
  });

  it('projects sub-graph registrations from the context graph meta graph', async () => {
    const store = new OxigraphStore();
    const projection = new ContextGraphMetaProjection(store);
    const id = 'projection-subgraphs';
    const uri = contextGraphDataGraphUri(id);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const registration = generateSubGraphRegistration({
      contextGraphId: id,
      subGraphName: 'tasks',
      createdBy: 'projection-test',
      description: 'Task memory',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });

    await store.insert([
      { subject: uri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: agentsGraph },
      ...registration,
    ]);
    projection.markDirtyFromQuads(registration);

    expect((await projection.get(id)).subGraphs).toEqual([
      {
        uri: `${uri}/tasks`,
        name: 'tasks',
        createdBy: 'did:dkg:agent:projection-test',
        createdAt: '2026-01-01T00:00:00Z',
        description: 'Task memory',
      },
    ]);
  });

  it('filters projected revoked agents from private participant authorization lists', async () => {
    const revoked = '0x0000000000000000000000000000000000000111';
    const active = '0x0000000000000000000000000000000000000222';
    const agentLike = {
      subscribedContextGraphs: new Map<string, { participantAgents?: string[] }>([
        ['projection-agents-private', { participantAgents: [revoked] }],
      ]),
      getCgMeta: async () => ({
        allowedAgents: [revoked, active],
        participantAgents: [revoked],
        participantIdentityIds: ['identity:legacy'],
        revokedAgents: [revoked],
      }),
    };

    const participants = await (DKGAgent.prototype as unknown as {
      getPrivateContextGraphParticipants(this: unknown, contextGraphId: string): Promise<string[] | null>;
    }).getPrivateContextGraphParticipants.call(agentLike, 'projection-agents-private');

    expect(participants).toEqual([active, 'identity:legacy']);
  });

  it('filters projected revoked agents from registration participant agents', async () => {
    const revoked = '0x0000000000000000000000000000000000000111';
    const active = '0x0000000000000000000000000000000000000222';
    const agentLike = {
      getCgMeta: async () => ({
        allowedAgents: [revoked, active],
        participantAgents: [revoked],
        revokedAgents: [revoked],
      }),
    };

    const participants = await (DKGAgent.prototype as unknown as {
      getContextGraphParticipantAgentAddresses(this: unknown, contextGraphId: string): Promise<string[]>;
    }).getContextGraphParticipantAgentAddresses.call(agentLike, 'projection-agents-private');

    expect(participants).toEqual([active]);
  });
});
