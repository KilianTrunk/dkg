import { describe, it, expect } from 'vitest';
import { DkgClient } from '../src/client.js';
import { makeConfig } from './harness.js';

// ── OT-RFC-43 §10.5 — knowledge-assets client contract ──────────────────────
// Pins the request body shapes for the VM-publish / finalize options the daemon
// supports, mirroring the cli ApiClient reference. Regression for the review on
// PR #978: these options were dropped, so external-signer / publish-control
// flows were unreachable through the MCP KA surface.
describe('DkgClient knowledge-assets — publish/finalize option serialization', () => {
  const makeClient = () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new DkgClient({
      config: makeConfig(),
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    return { client, calls };
  };

  it('knowledgeAssetPublish nests finalized-publish controls under `options`', async () => {
    const { client, calls } = makeClient();
    await client.knowledgeAssetPublish({
      contextGraphId: 'cg-1',
      name: 'f',
      subGraphName: 'sg',
      clearAfter: true,
      publishEpochs: 3,
      publisherNodeIdentityIdOverride: '42',
    });
    expect(calls[0].url).toContain('/api/knowledge-assets/f/vm/publish');
    // `clearAfter` is the SDK spelling; the daemon expects `clearSharedMemoryAfter`.
    // JSON-facing callers send the uint64 override as a decimal string.
    expect(calls[0].body).toMatchObject({
      contextGraphId: 'cg-1',
      subGraphName: 'sg',
      options: {
        clearSharedMemoryAfter: true,
        publishEpochs: 3,
        publisherNodeIdentityIdOverride: '42',
      },
    });
  });

  it('knowledgeAssetPublish omits `options` when no controls are passed', async () => {
    const { client, calls } = makeClient();
    await client.knowledgeAssetPublish({ contextGraphId: 'cg-1', name: 'f', subGraphName: 'sg' });
    expect(calls[0].body).toEqual({ contextGraphId: 'cg-1', subGraphName: 'sg' });
  });

  it('knowledgeAssetPublish rejects numeric publisher identity overrides before HTTP serialization', async () => {
    const { client, calls } = makeClient();
    await expect(client.knowledgeAssetPublish({
      contextGraphId: 'cg-1',
      name: 'f',
      publisherNodeIdentityIdOverride: Number.MAX_SAFE_INTEGER + 1,
    } as any)).rejects.toThrow(/decimal string/);
    expect(calls).toHaveLength(0);
  });

  it('knowledgeAssetFinalize forwards external-signer fields', async () => {
    const { client, calls } = makeClient();
    await client.knowledgeAssetFinalize({
      contextGraphId: 'cg-1',
      name: 'f',
      authorAgentAddress: '0xauthor',
      preSignedAuthorAttestation: { address: '0xauthor', signature: { r: '0xr', vs: '0xvs' } },
      schemeVersion: 1,
    });
    expect(calls[0].url).toContain('/api/knowledge-assets/f/wm/finalize');
    expect(calls[0].body).toMatchObject({
      contextGraphId: 'cg-1',
      authorAgentAddress: '0xauthor',
      preSignedAuthorAttestation: { address: '0xauthor', signature: { r: '0xr', vs: '0xvs' } },
      schemeVersion: 1,
    });
  });

  it('createKnowledgeAsset translates an alsoPublishVm options object', async () => {
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({
      contextGraphId: 'cg-1',
      name: 'f',
      alsoPublishVm: { clearAfter: true, publishEpochs: 2, publisherNodeIdentityIdOverride: '7' },
    });
    expect(calls[0].body.alsoPublishVm).toEqual({
      clearSharedMemoryAfter: true,
      publishEpochs: 2,
      publisherNodeIdentityIdOverride: '7',
    });
  });

  it('createKnowledgeAsset passes a boolean alsoPublishVm through unchanged', async () => {
    const { client, calls } = makeClient();
    await client.createKnowledgeAsset({ contextGraphId: 'cg-1', name: 'f', alsoPublishVm: true });
    expect(calls[0].body.alsoPublishVm).toBe(true);
  });
});
