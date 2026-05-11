// Regression for codex round-3 finding on PR #451:
// `POST /api/publisher/enqueue` reconstructs the LiftRequest by
// explicitly listing fields, so any new field added to
// `LiftRequest` is silently dropped at the HTTP boundary unless
// the route is updated. This test pins the wire contract for
// `allowPublisherFallbackSeal`.

import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function createResponse() {
  return {
    statusCode: 0,
    headers: undefined as Record<string, string> | undefined,
    body: '',
    writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(body?: string) {
      this.body = body ?? '';
      this.writableEnded = true;
      return this;
    },
  };
}

function createEnqueueRequest(body: unknown): RequestContext['req'] {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(request, {
    method: 'POST',
    url: '/api/publisher/enqueue',
    headers: {},
  });
  return request as RequestContext['req'];
}

function createContext(
  body: unknown,
  liftCapture: (req: unknown) => Promise<string>,
): RequestContext {
  const url = new URL('http://127.0.0.1/api/publisher/enqueue');
  return {
    req: createEnqueueRequest(body),
    res: createResponse() as unknown as ServerResponse,
    agent: {} as RequestContext['agent'],
    publisherControl: {
      lift: liftCapture,
    } as unknown as RequestContext['publisherControl'],
    publisherRuntime: null,
    config: {} as RequestContext['config'],
    startedAt: 0,
    dashDb: {} as RequestContext['dashDb'],
    opWallets: { adminWallet: { address: '0x0', privateKey: '0x0' }, wallets: [] } as RequestContext['opWallets'],
    network: null as RequestContext['network'],
    tracker: {} as RequestContext['tracker'],
    memoryManager: {} as RequestContext['memoryManager'],
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'test',
    catchupTracker: {} as RequestContext['catchupTracker'],
    extractionRegistry: {} as RequestContext['extractionRegistry'],
    fileStore: {} as RequestContext['fileStore'],
    extractionStatus: new Map(),
    assertionImportLocks: new Map(),
    vectorStore: {} as RequestContext['vectorStore'],
    embeddingProvider: null,
    validTokens: new Set(),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    url,
    path: url.pathname,
    requestToken: undefined,
    requestAgentAddress: '0x0',
  };
}

const BASE_BODY = {
  contextGraphId: 'cg-test',
  shareOperationId: 'op-1',
  roots: ['urn:local:/rihana'],
  namespace: 'aloha',
  scope: 'person-profile',
  authorityProofRef: 'proof:owner:1',
};

describe('POST /api/publisher/enqueue allowPublisherFallbackSeal threading', () => {
  it('forwards allowPublisherFallbackSeal=true into the LiftRequest', async () => {
    let captured: any;
    const ctx = createContext(
      { ...BASE_BODY, allowPublisherFallbackSeal: true },
      async (req) => {
        captured = req;
        return 'job-1';
      },
    );

    await handlePublisherRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(captured).toBeDefined();
    expect(captured.allowPublisherFallbackSeal).toBe(true);
  });

  it('omits allowPublisherFallbackSeal when caller did not set it', async () => {
    let captured: any;
    const ctx = createContext({ ...BASE_BODY }, async (req) => {
      captured = req;
      return 'job-2';
    });

    await handlePublisherRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(captured).toBeDefined();
    expect('allowPublisherFallbackSeal' in captured).toBe(false);
  });

  it('accepts allowPublisherFallbackSeal=false explicitly', async () => {
    let captured: any;
    const ctx = createContext(
      { ...BASE_BODY, allowPublisherFallbackSeal: false },
      async (req) => {
        captured = req;
        return 'job-3';
      },
    );

    await handlePublisherRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(captured).toBeDefined();
    expect(captured.allowPublisherFallbackSeal).toBe(false);
  });
});
