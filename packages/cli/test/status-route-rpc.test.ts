import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

const rpcState = vi.hoisted(() => ({
  responses: new Map<string, number | Error | Promise<never>>(),
}));

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<any>();
  class MockJsonRpcProvider {
    readonly rpcUrl: string;
    constructor(rpcUrl: string) {
      this.rpcUrl = rpcUrl;
    }
    async getBlockNumber(): Promise<number> {
      const response = rpcState.responses.get(this.rpcUrl);
      if (response instanceof Error) throw response;
      if (response && typeof (response as Promise<never>).then === 'function') {
        return response as Promise<never>;
      }
      return typeof response === 'number' ? response : 123;
    }
  }
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: MockJsonRpcProvider,
    },
  };
});

const { handleStatusRoutes } = await import('../src/daemon/routes/status.js');

function makeCtx(path: string) {
  const url = new URL(path, 'http://127.0.0.1');
  return {
    agent: {
      peerId: '12D3KooStatusRouteTest',
      multiaddrs: [],
      node: {
        libp2p: {
          getConnections: () => [],
        },
      },
      publisher: {
        getIdentityId: () => 0n,
      },
    },
    publisherControl: {},
    publisherRuntime: null,
    config: {
      name: 'status-test',
      nodeRole: 'edge',
      chain: {
        type: 'evm',
        rpcUrl: 'https://primary.example/rpc',
        rpcUrls: ['https://backup.example/rpc'],
        hubAddress: '0x0000000000000000000000000000000000000001',
        chainId: 'base:84532',
      },
    },
    startedAt: Date.now() - 1000,
    dashDb: {},
    opWallets: { wallets: [] },
    network: null,
    tracker: {},
    memoryManager: {},
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'abc123',
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
  };
}

describe('status route multi-RPC shape', () => {
  let server: Server | undefined;
  let baseUrl = '';

  beforeEach(async () => {
    rpcState.responses.clear();
    server = createServer(async (req, res) => {
      const requestPath = req.url ?? '/';
      const ctx = { ...makeCtx(requestPath), req, res };
      try {
        await handleStatusRoutes(ctx as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err?.message ?? String(err) }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
  });

  it('/api/status returns sanitized chain summary without raw RPC endpoints', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.chain).toEqual({
      chainId: 'base:84532',
      configured: true,
      rpcEndpointCount: 2,
      hubConfigured: true,
    });
    expect(body.chain).not.toHaveProperty('rpcUrl');
    expect(body.chain).not.toHaveProperty('rpcUrls');
    expect(body.chain).not.toHaveProperty('hubAddress');
  });

  it('/api/chain/rpc-health probes all endpoints without returning raw RPC URLs', async () => {
    rpcState.responses.set('https://primary.example/rpc', new Error('primary down'));
    rpcState.responses.set('https://backup.example/rpc', 456);

    const res = await fetch(`${baseUrl}/api/chain/rpc-health`);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.configured).toBe(true);
    expect(body.rpcEndpointCount).toBe(2);
    expect(body).not.toHaveProperty('rpcUrl');
    expect(body).not.toHaveProperty('rpcUrls');
    expect(body.blockNumber).toBeNull();
    expect(body.rpcs).toEqual([
      expect.objectContaining({
        index: 0,
        role: 'primary',
        ok: false,
        blockNumber: null,
        error: 'RPC health probe failed',
      }),
      expect.objectContaining({
        index: 1,
        role: 'backup',
        ok: true,
        blockNumber: 456,
      }),
    ]);
    for (const probe of body.rpcs) {
      expect(probe).not.toHaveProperty('rpcUrl');
    }
  });
});
