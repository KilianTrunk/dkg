import { describe, expect, it } from 'vitest';
import { createOperationContext, contextGraphSharedMemoryUri } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPhase } from '../src/sync/auth/request-build.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';

const CG_ID = 'sync-owned-cg';
const SUB_GRAPH = 'code';
const ROOT_ENTITY = 'urn:swm:shared-root';
const ROOT_GRAPH = contextGraphSharedMemoryUri(CG_ID);
const SUB_GRAPH_SWM = contextGraphSharedMemoryUri(CG_ID, SUB_GRAPH);

function page(quads: Quad[], phase: SyncPhase): SyncPageResult {
  return {
    quads,
    bytesReceived: 1,
    resumedFromOffset: 0,
    nextOffset: quads.length,
    checkpointKey: `${phase}-checkpoint`,
    completed: true,
  };
}

describe('runSharedMemorySync ownership hydration', () => {
  it('hydrates root and sub-graph SWM ownership under separate keys', async () => {
    const ownedMaps = new Map<string, Map<string, string>>();
    const inserted: Quad[] = [];
    const deletedCheckpoints: string[] = [];

    const dataQuads: Quad[] = [
      { graph: ROOT_GRAPH, subject: ROOT_ENTITY, predicate: 'http://schema.org/name', object: '"root"' },
      { graph: SUB_GRAPH_SWM, subject: ROOT_ENTITY, predicate: 'http://schema.org/name', object: '"sub"' },
    ];

    const summary = await runSharedMemorySync({
      ctx: createOperationContext('sync'),
      remotePeerId: '12D3KooWRequesterOwnership',
      contextGraphIds: [CG_ID],
      createContextGraphSyncDeadline: () => Date.now() + 30_000,
      fetchSyncPages: async (_ctx, _peer, _cg, _includeSwm, phase) => (
        phase === 'data' ? page(dataQuads, phase) : page([], phase)
      ),
      processSharedMemoryBatch: async () => ({
        verifiedData: dataQuads,
        verifiedMeta: [],
        totalFetchedDataQuads: dataQuads.length,
        totalFetchedMetaQuads: 0,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [
          { dataGraph: ROOT_GRAPH, entity: ROOT_ENTITY, creator: 'peer-root' },
          { dataGraph: SUB_GRAPH_SWM, entity: ROOT_ENTITY, creator: 'peer-sub' },
        ],
      }),
      ensureContextGraph: async () => {},
      storeInsert: async (quads) => {
        inserted.push(...quads);
      },
      deleteCheckpoint: (key) => {
        deletedCheckpoints.push(key);
      },
      setCheckpoint: () => {},
      ensureOwnedMap: (key) => {
        let map = ownedMaps.get(key);
        if (!map) {
          map = new Map<string, string>();
          ownedMaps.set(key, map);
        }
        return map;
      },
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    });

    expect(summary.failedPeers).toBe(0);
    expect(summary.insertedDataTriples).toBe(2);
    expect(inserted).toHaveLength(2);
    expect(deletedCheckpoints.sort()).toEqual(['data-checkpoint', 'meta-checkpoint']);
    expect(ownedMaps.get(CG_ID)?.get(ROOT_ENTITY)).toBe('peer-root');
    expect(ownedMaps.get(`${CG_ID}\0${SUB_GRAPH}`)?.get(ROOT_ENTITY)).toBe('peer-sub');
  });
});
