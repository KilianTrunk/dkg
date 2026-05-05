import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleEpcisRoutes } from '../src/daemon/routes/epcis.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const VALID_OBJECT_EVENT_DOC = {
  '@context': {
    '@vocab': 'https://gs1.github.io/EPCIS/',
    epcis: 'https://gs1.github.io/EPCIS/',
    cbv: 'https://ref.gs1.org/cbv/',
    type: '@type',
    id: '@id',
    eventID: '@id',
  },
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  creationDate: '2024-03-01T08:00:00Z',
  epcisBody: {
    eventList: [
      {
        eventID: 'urn:uuid:fixture-obj-1',
        type: 'ObjectEvent',
        eventTime: '2024-03-01T08:00:00.000Z',
        eventTimeZoneOffset: '+00:00',
        epcList: ['urn:epc:id:sgtin:4012345.011111.1001'],
        action: 'ADD',
        bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
        disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
        readPoint: { id: 'urn:epc:id:sgln:4012345.00001.0' },
        bizLocation: { id: 'urn:epc:id:sgln:4012345.00001.0' },
      },
    ],
  },
};

function createResponse() {
  const response = {
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
  return response;
}

function createRequest(body?: unknown): RequestContext['req'] {
  const request = body === undefined
    ? new Readable({ read() { this.push(null); } })
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(request, {
    method: 'POST',
    url: '/api/epcis/capture',
    headers: {},
  });
  return request as RequestContext['req'];
}

function createContext(overrides: Partial<RequestContext> = {}): RequestContext {
  const url = new URL('http://127.0.0.1/api/epcis/capture');
  return {
    req: createRequest(),
    res: createResponse() as unknown as ServerResponse,
    agent: {
      publishAsync: async () => {
        throw new Error('publishAsync should not be called when publisher runtime is unavailable');
      },
    } as unknown as RequestContext['agent'],
    publisherControl: {} as RequestContext['publisherControl'],
    publisherRuntime: null,
    config: {
      epcis: { contextGraphId: 'epcis-test' },
      publisher: { enabled: true },
    } as RequestContext['config'],
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
    ...overrides,
  };
}

function responseBody(ctx: RequestContext): Record<string, unknown> {
  return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>;
}

describe('EPCIS async capture publisher readiness', () => {
  it('returns 503 when publisher config is enabled but the async runtime is not running', async () => {
    const ctx = createContext();

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(503);
    expect(responseBody(ctx)).toMatchObject({
      error: 'PublisherUnavailable',
    });
  });

  it('keeps disabled publisher config mapped to PublisherDisabled', async () => {
    const ctx = createContext({
      config: {
        epcis: { contextGraphId: 'epcis-test' },
        publisher: { enabled: false },
      } as RequestContext['config'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(503);
    expect(responseBody(ctx)).toMatchObject({
      error: 'PublisherDisabled',
    });
  });

  it('accepts capture and publishes bare documents as private content without route public wrapping', async () => {
    const published: Array<{ contextGraphId: string; content: unknown; opts: unknown }> = [];
    const ctx = createContext({
      req: createRequest({
        epcisDocument: VALID_OBJECT_EVENT_DOC,
        publishOptions: { accessPolicy: 'allowList', allowedPeers: ['peer-a'] },
      }),
      agent: {
        publishAsync: async (contextGraphId: string, content: unknown, opts: unknown) => {
          published.push({ contextGraphId, content, opts });
          return { captureID: 'capture-route-1' };
        },
      } as unknown as RequestContext['agent'],
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(202);
    expect(responseBody(ctx)).toMatchObject({
      captureID: 'capture-route-1',
      status: 'accepted',
      eventCount: 1,
    });
    expect(published).toEqual([
      {
        contextGraphId: 'epcis-test',
        content: { private: VALID_OBJECT_EVENT_DOC },
        opts: { accessPolicy: 'allowList', allowedPeers: ['peer-a'] },
      },
    ]);
  });

  it('uses per-request contextGraphId and threads subGraphName into publisher opts', async () => {
    const published: Array<{ contextGraphId: string; content: unknown; opts: unknown }> = [];
    const ctx = createContext({
      req: createRequest({
        contextGraphId: 'per-request-cg',
        subGraphName: 'research',
        epcisDocument: VALID_OBJECT_EVENT_DOC,
      }),
      agent: {
        publishAsync: async (contextGraphId: string, content: unknown, opts: unknown) => {
          published.push({ contextGraphId, content, opts });
          return { captureID: 'capture-route-2' };
        },
      } as unknown as RequestContext['agent'],
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(202);
    expect(published).toEqual([
      {
        contextGraphId: 'per-request-cg',
        content: { private: VALID_OBJECT_EVENT_DOC },
        opts: { subGraphName: 'research' },
      },
    ]);
  });

  it('falls back to legacy epcis.paranetId when neither body nor epcis.contextGraphId is set', async () => {
    const published: Array<{ contextGraphId: string }> = [];
    const ctx = createContext({
      req: createRequest({ epcisDocument: VALID_OBJECT_EVENT_DOC }),
      config: {
        epcis: { paranetId: 'legacy-paranet' },
        publisher: { enabled: true },
      } as RequestContext['config'],
      agent: {
        publishAsync: async (contextGraphId: string) => {
          published.push({ contextGraphId });
          return { captureID: 'capture-route-3' };
        },
      } as unknown as RequestContext['agent'],
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(202);
    expect(published).toEqual([{ contextGraphId: 'legacy-paranet' }]);
  });

  it('returns 400 InvalidContent when neither body nor config supplies a contextGraphId', async () => {
    const ctx = createContext({
      req: createRequest({ epcisDocument: VALID_OBJECT_EVENT_DOC }),
      config: {
        epcis: {},
        publisher: { enabled: true },
      } as RequestContext['config'],
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    const body = responseBody(ctx);
    expect(body.error).toBe('InvalidContent');
    expect(body.message).toMatch(/contextGraphId/);
    expect(body.message).toMatch(/epcis\.contextGraphId/);
  });

  it('returns 400 InvalidContent for an invalid per-request contextGraphId', async () => {
    const ctx = createContext({
      req: createRequest({
        contextGraphId: 'bad cg with spaces',
        epcisDocument: VALID_OBJECT_EVENT_DOC,
      }),
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    const body = responseBody(ctx);
    expect(body.error).toBe('InvalidContent');
    expect(body.message).toMatch(/contextGraphId/);
  });

  it('returns 400 InvalidContent for an invalid subGraphName', async () => {
    const ctx = createContext({
      req: createRequest({
        subGraphName: '_reserved',
        epcisDocument: VALID_OBJECT_EVENT_DOC,
      }),
      publisherRuntime: {
        walletIds: ['0xpublisher'],
        runner: {},
        publisher: {},
        stop: async () => {},
      } as unknown as RequestContext['publisherRuntime'],
    });

    await handleEpcisRoutes(ctx);

    expect(ctx.res.statusCode).toBe(400);
    const body = responseBody(ctx);
    expect(body.error).toBe('InvalidContent');
    expect(body.message).toMatch(/subGraphName/);
    expect(body.message).toMatch(/reserved/);
  });
});
