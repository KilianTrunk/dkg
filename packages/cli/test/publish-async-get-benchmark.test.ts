import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBenchmarkClient,
  isLoopbackApiUrl,
  parseBenchmarkArgs,
  resolveTokenForApiUrl,
  runPublishAsyncGetBenchmark,
  summarizeOperations,
  type BenchmarkClient,
  type BenchmarkConfig,
} from '../src/benchmark/publish-get/index.js';

const originalFetch = globalThis.fetch;
const originalDkgHome = process.env.DKG_HOME;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDkgHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = originalDkgHome;
});

describe('publish async get benchmark', () => {
  it('parses benchmark arguments with defaults and overrides', () => {
    const config = parseBenchmarkArgs([
      '--context-graph-id',
      'bench-cg',
      '--repeat=7',
      '--warmups',
      '2',
      '--timeout-ms',
      '5000',
      '--payload-size',
      '256',
      '--fixture',
      'minimal',
      '--output-format',
      'ndjson',
      '--api-url',
      'http://127.0.0.1:9200',
      '--auth-token',
      'token-a',
    ], {});

    expect(config).toMatchObject({
      contextGraphId: 'bench-cg',
      repeat: 7,
      warmups: 2,
      timeoutMs: 5000,
      payloadSizeBytes: 256,
      fixture: 'minimal',
      outputFormat: 'ndjson',
      apiUrl: 'http://127.0.0.1:9200',
      authToken: 'token-a',
    });
  });

  it('aggregates measured timings while excluding warmups', () => {
    const summaries = summarizeOperations([
      timing('syncPublish', 1, true, true, 100),
      timing('syncPublish', 1, false, true, 10),
      timing('syncPublish', 2, false, true, 20),
      timing('syncPublish', 3, false, false, 30, 'boom'),
      timing('get', 1, false, true, 5),
    ]);

    expect(summaries.syncPublish).toMatchObject({
      count: 3,
      successCount: 2,
      failureCount: 1,
      minMs: 10,
      maxMs: 20,
      meanMs: 15,
      medianMs: 10,
      p50Ms: 10,
      p95Ms: 20,
    });
    expect(summaries.get).toMatchObject({ count: 1, successCount: 1, failureCount: 0 });
  });

  it('uses unique roots for warmup and measured payloads and does not clear shared memory on sync publish', async () => {
    const client = new MockBenchmarkClient();
    const result = await runPublishAsyncGetBenchmark({ ...baseConfig(), repeat: 1, warmups: 1 }, client, monotonicClock());

    expect(result.summaries.syncPublish.count).toBe(1);
    expect(result.operations.filter((op) => op.warmup)).toHaveLength(4);
    expect(client.publishCalls).toHaveLength(2);
    expect(client.publishCalls.every((call) => call.clearAfter === false)).toBe(true);

    const roots = [
      ...client.publishCalls.flatMap((call) => call.roots),
      ...client.enqueueCalls.flatMap((call) => call.roots),
    ];
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots.some((root) => root.includes(':warmup-1:'))).toBe(true);
    expect(roots.some((root) => root.includes(':measured-1:'))).toBe(true);
  });

  it('reports measured failures with operation, iteration, error, and reproduction context', async () => {
    const client = new MockBenchmarkClient({ jobStatus: 'failed', jobError: 'chain rejected' });
    const result = await runPublishAsyncGetBenchmark({ ...baseConfig(), repeat: 1, warmups: 0 }, client, monotonicClock());

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      operation: 'asyncCompletion',
      iteration: 1,
      error: expect.stringContaining('chain rejected'),
    });
    expect(result.failures[0].context).toMatchObject({
      contextGraphId: 'bench-cg',
      flow: 'async',
      jobId: 'job-1',
    });
  });

  it('auto-loads local tokens for DKG_API_PORT targets', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'dkg-bench-auth-'));
    process.env.DKG_HOME = tempDir;
    await writeFile(join(tempDir, 'auth.token'), 'local-token\n', 'utf8');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = trackingFetch(calls, { name: 'dkg', peerId: 'p', uptimeMs: 1, connectedPeers: 0, relayConnected: false, multiaddrs: [] });

    try {
      const client = await createBenchmarkClient({ ...baseConfig(), apiPort: 9300, authToken: undefined });
      await client.status();
      expect(calls[0].url).toBe('http://127.0.0.1:9300/api/status');
      expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer local-token');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not auto-load local auth tokens for non-loopback API URLs', async () => {
    await expect(resolveTokenForApiUrl('https://node.example.test:9200')).rejects.toThrow(/non-loopback API URL/);
    await expect(resolveTokenForApiUrl('https://node.example.test:9200', 'explicit-token')).resolves.toBe('explicit-token');
    expect(isLoopbackApiUrl('http://localhost:9200')).toBe(true);
    expect(isLoopbackApiUrl('http://127.12.0.1:9200')).toBe(true);
    expect(isLoopbackApiUrl('http://192.168.1.50:9200')).toBe(false);
  });
});

function baseConfig(): BenchmarkConfig {
  return {
    contextGraphId: 'bench-cg',
    repeat: 1,
    warmups: 0,
    timeoutMs: 1000,
    payloadSizeBytes: 128,
    fixture: 'minimal',
    outputFormat: 'json',
    namespace: 'benchmark',
    scope: 'publish-async-get',
    authorityProofRef: 'proof:benchmark-local',
    pollIntervalMs: 1,
    asyncSuccessStatuses: ['finalized'],
    getView: 'verified-memory',
  };
}

function timing(
  operation: 'syncPublish' | 'asyncEnqueue' | 'asyncCompletion' | 'get',
  iteration: number,
  warmup: boolean,
  success: boolean,
  durationMs: number,
  error?: string,
) {
  return { operation, iteration, warmup, success, durationMs, error, context: {} };
}

function monotonicClock(): () => number {
  let value = 0;
  return () => {
    value += 10;
    return value;
  };
}

function trackingFetch(calls: Array<{ url: string; init?: RequestInit }>, body: unknown): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
}

class MockBenchmarkClient implements BenchmarkClient {
  readonly publishCalls: Array<{ roots: string[]; clearAfter?: boolean }> = [];
  readonly enqueueCalls: Array<{ roots: string[] }> = [];
  private readonly markersByRoot = new Map<string, string>();

  constructor(private readonly opts: { jobStatus?: string; jobError?: string } = {}) {}

  async status(): Promise<unknown> {
    return { ok: true };
  }

  async sharedMemoryWrite(_contextGraphId: string, quads: Array<{ subject: string; predicate: string; object: string }>) {
    const markerQuad = quads.find((quad) => quad.predicate === 'http://schema.org/identifier');
    if (markerQuad) this.markersByRoot.set(markerQuad.subject, markerQuad.object);
    return { workspaceOperationId: `share-${this.markersByRoot.size}` };
  }

  async publishFromSharedMemory(
    _contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    clearAfter?: boolean,
  ) {
    const roots = selection === 'all' ? ['all'] : selection.rootEntities;
    this.publishCalls.push({ roots, clearAfter });
    return { kcId: `kc-${this.publishCalls.length}`, kas: roots.map((rootEntity) => ({ tokenId: '1', rootEntity })) };
  }

  async publisherEnqueue(request: { roots: string[] }) {
    this.enqueueCalls.push({ roots: request.roots });
    return { jobId: `job-${this.enqueueCalls.length}` };
  }

  async publisherJob(_jobId: string) {
    return { job: { status: this.opts.jobStatus ?? 'finalized', error: this.opts.jobError } };
  }

  async query(sparql: string) {
    const root = sparql.match(/<([^>]+)>/)?.[1] ?? '';
    const value = this.markersByRoot.get(root) ?? '"missing"';
    return { result: { type: 'bindings' as const, bindings: [{ value }] } };
  }
}
