import { describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TRUST_LEVEL_PREDICATE,
  TrustLevel,
  TypedEventBus,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher, MultiRootPublishNotAtomicError } from '../src/index.js';
import type { PublishResult } from '../src/publisher.js';

const CONTEXT_GRAPH = 'publish-boundary';
const SWM_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
const WORKSPACE_OWNER_PREDICATE = 'http://dkg.io/ontology/workspaceOwner';

function q(subject: string, predicate = 'http://schema.org/name', object = '"value"', graph = SWM_GRAPH): Quad {
  return { subject, predicate, object, graph };
}

async function makePublisher() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  const publishResult: PublishResult = {
    kaId: 1n,
    ual: 'did:dkg:0x0000000000000000000000000000000000000001/1',
    merkleRoot: new Uint8Array(32),
    kaManifest: [
      {
        tokenId: 1n,
        rootEntity: 'urn:test:root:one',
        privateTripleCount: 0,
      },
    ],
    status: 'tentative',
    publicQuads: [],
  };
  const publishSpy = vi.spyOn(publisher, 'publish').mockResolvedValue(publishResult);
  return { publisher, store, publishSpy };
}

describe('publishFromSharedMemory single-root boundary', () => {
  it('allows selection "all" when shared memory resolves to one payload root', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:one', WORKSPACE_OWNER_PREDICATE, '"peer-a"'),
      q('urn:test:root:one', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
      q('urn:test:root:metadata-only', WORKSPACE_OWNER_PREDICATE, '"peer-b"'),
      q('urn:test:root:metadata-only', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
    ]);

    await expect(publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all')).resolves.toMatchObject({
      status: 'tentative',
    });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const publishArgs = publishSpy.mock.calls[0][0];
    expect(publishArgs.quads).toEqual([
      { subject: 'urn:test:root:one', predicate: 'http://schema.org/name', object: '"value"', graph: '' },
    ]);
  });

  it('throws before publish when selection "all" resolves to multiple payload roots', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:two'),
      q('urn:test:root:two', WORKSPACE_OWNER_PREDICATE, '"peer-b"'),
      q('urn:test:root:two', TRUST_LEVEL_PREDICATE, `"${TrustLevel.SelfAttested}"`),
    ]);

    const error = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all').catch((err) => err);

    expect(error).toBeInstanceOf(MultiRootPublishNotAtomicError);
    expect(error).toMatchObject({
      code: 'MULTI_ROOT_PUBLISH_NOT_ATOMIC',
      contextGraphId: CONTEXT_GRAPH,
    });
    expect([...error.rootEntities].sort()).toEqual(['urn:test:root:one', 'urn:test:root:two']);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('throws before publish when explicit rootEntities resolve to multiple payload roots', async () => {
    const { publisher, store, publishSpy } = await makePublisher();
    await store.insert([
      q('urn:test:root:one'),
      q('urn:test:root:two'),
    ]);

    const error = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
      rootEntities: ['urn:test:root:one', 'urn:test:root:two'],
    }).catch((err) => err);

    expect(error).toBeInstanceOf(MultiRootPublishNotAtomicError);
    expect(error).toMatchObject({
      code: 'MULTI_ROOT_PUBLISH_NOT_ATOMIC',
      contextGraphId: CONTEXT_GRAPH,
    });
    expect([...error.rootEntities].sort()).toEqual(['urn:test:root:one', 'urn:test:root:two']);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
