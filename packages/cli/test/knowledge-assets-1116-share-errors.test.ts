/**
 * #1116 (review C + A1) — route error→HTTP mapping for the seal-by-default
 * share contract, driven over real HTTP against `handleKnowledgeAssetsRoutes`
 * with a MINIMAL fake agent (same proven pattern as
 * `promote-route-not-persisted.test.ts`). The ENGINE outcomes (fail-closed +
 * WM-preserved + subset-not-sealable) are pinned at the agent e2e level
 * (`packages/agent/test/e2e-memory-layers.test.ts`, #1116 block); this pins the
 * ROUTE's catch branches so the HTTP surface can't silently drift:
 *
 *   - swm/share: a default full share whose internal seal fails with a residual
 *     capability gap throws `code:'UNSEALED_SHARE_BLOCKED'` → route 409
 *     `{ code, error, recovery }`. The live-daemon suite explicitly can NOT
 *     reach this (it always has a signing key + V10 chain), so it's covered
 *     here with a fake agent.
 *   - wm/finalize (layer:swm): a subset-shared asset throws
 *     `code:'SWM_SUBSET_NOT_SEALABLE'` → route 409 `{ code, error }`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';

const CG_ID = 'issue-1116-cg';
const ASSERTION_NAME = 'seal-asset';

describe('#1116 share/seal route error mapping (fake agent)', () => {
  let server: Server | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
  });

  async function startWith(assertion: Record<string, unknown>) {
    const agent = {
      async listContextGraphs() {
        return [{
          id: CG_ID,
          uri: `did:dkg:context-graph:${CG_ID}`,
          name: CG_ID,
          subscribed: true,
          synced: true,
        }];
      },
      async contextGraphExists(cgId: string) {
        return cgId === CG_ID;
      },
      resolveAgentByToken: () => undefined,
      assertion,
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        await handleKnowledgeAssetsRoutes({
          req,
          res,
          agent,
          publisherControl: {},
          publisherRuntime: null,
          config: {},
          startedAt: Date.now(),
          dashDb: { insertNotification: () => 1 },
          opWallets: {},
          network: {},
          tracker: {},
          memoryManager: {},
          bridgeAuthToken: undefined,
          nodeVersion: 'test',
          nodeCommit: 'test',
          catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
          extractionRegistry: {},
          fileStore: {},
          extractionStatus: new Map(),
          assertionImportLocks: new Map(),
          vectorStore: {},
          embeddingProvider: null,
          validTokens: new Set(),
          apiHost: '127.0.0.1',
          apiPortRef: { value: 0 },
          url,
          path: url.pathname,
          requestToken: undefined,
          requestAgentAddress: 'did:dkg:agent:test',
          emitMemoryGraphChanged: () => {},
          emitNotification: () => {},
        } as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Unhandled: ${err?.message ?? err}` }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server!.address();
    if (!addr || typeof addr === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async function post(pathSuffix: string, body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/knowledge-assets/${ASSERTION_NAME}/${pathSuffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  it('swm/share: UNSEALED_SHARE_BLOCKED → 409 { code, error, recovery }', async () => {
    await startWith({
      promote: async () => {
        throw Object.assign(
          new Error('Cannot seal "seal-asset" for sharing to Shared Memory — the asset would be left unpublishable and Working Memory was NOT emptied. no local signing key'),
          {
            code: 'UNSEALED_SHARE_BLOCKED',
            recovery: 'Resolve the signing capability, then retry; or pass skipSeal:true.',
          },
        );
      },
    });

    const res = await post('swm/share', { contextGraphId: CG_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNSEALED_SHARE_BLOCKED');
    expect(String(res.body.error)).toContain('Working Memory was NOT emptied');
    expect(String(res.body.recovery)).toContain('skipSeal');
  });

  it('wm/finalize (layer:swm): SWM_SUBSET_NOT_SEALABLE → 409 { code, error }', async () => {
    await startWith({
      finalize: async () => {
        throw Object.assign(
          new Error('Cannot seal-in-SWM: this asset was not fully shared to SWM — subset shares are not publishable. Share the full asset (entities:"all") first, then finalize(layer:"swm").'),
          { code: 'SWM_SUBSET_NOT_SEALABLE' },
        );
      },
    });

    const res = await post('wm/finalize', { contextGraphId: CG_ID, layer: 'swm' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SWM_SUBSET_NOT_SEALABLE');
    expect(String(res.body.error)).toContain('subset shares are not publishable');
  });

  it('swm/share: an unrelated promote error still propagates (not silently 409ed)', async () => {
    // Guard: the new 409 branch must only catch UNSEALED_SHARE_BLOCKED. Any
    // other error rethrows to the outer handler (→ 500 here).
    await startWith({
      promote: async () => {
        throw new Error('some unrelated engine failure');
      },
    });

    const res = await post('swm/share', { contextGraphId: CG_ID });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
