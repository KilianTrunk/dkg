import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';
import { NS, Class, Prop, Status } from '../src/ontology.js';
import type { DkgClientLike, DkgConfigLike } from '../src/types.js';

// ---------------------------------------------------------------------------
// Tracking function helper
// ---------------------------------------------------------------------------

interface TrackingFn<T> {
  (...args: unknown[]): Promise<T>;
  calls: unknown[][];
  resetCalls(): void;
}

function trackingAsyncFn<T>(impl: (...args: unknown[]) => T | Promise<T>): TrackingFn<T> {
  const calls: unknown[][] = [];
  const fn = (async (...args: unknown[]) => {
    calls.push(args);
    return impl(...args);
  }) as TrackingFn<T>;
  fn.calls = calls;
  fn.resetCalls = () => { calls.length = 0; };
  return fn;
}

// ---------------------------------------------------------------------------
// In-process DkgClient stand-in
// ---------------------------------------------------------------------------
//
// Post dkg-v10 consolidation (parity-matrix v0.5 §4.21), the adapter's
// surface contracts split into two halves:
//
//   1. SPARQL reads — flow through the supplied `DkgClientLike` (mcp-dkg's
//      `DkgClient.query({sparql, contextGraphId})`). Mocked with a
//      tracking fn that records the object-arg shape.
//
//   2. Daemon writes — flow through a private `fetch`-based shim talking
//      to `/api/context-graph/create`, `/api/subscribe`,
//      `/api/shared-memory/{write,publish}`. Mocked with a `globalThis.fetch`
//      stub that records URL + body per call.
//
// Tests therefore assert against EITHER `mock.query.calls` (SPARQL path)
// OR the fetch stub's recorded HTTP calls (write path). This is the same
// boundary the production code crosses — verifying both halves keeps the
// adapter's MCP-↔-daemon translation honest.

function createTestDkgClient(overrides: Partial<DkgClientLike> = {}): DkgClientLike {
  return {
    query: trackingAsyncFn(async () => ({ bindings: [] })),
    ...overrides,
  };
}

const TEST_CONFIG: DkgConfigLike = {
  api: 'http://test-daemon:9200',
  token: 'test-token',
};

// ── Daemon HTTP fetch stub ─────────────────────────────────────────
//
// Captures every daemon-route call the adapter's private fetch shim
// makes. Records URL, method, and parsed body so tests can assert
// against the wire shape. Per-route response bodies are configured via
// `setRoute(...)`; an unset route returns the empty default per
// production daemon shape (used by tests that don't care about the
// response, only the call).

interface DaemonFetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface DaemonFetchStub {
  calls: DaemonFetchCall[];
  setRoute(path: string, response: unknown): void;
  setRouteError(path: string, status: number, errorMessage: string): void;
  reset(): void;
  install(): void;
  uninstall(): void;
}

function createDaemonFetchStub(): DaemonFetchStub {
  const calls: DaemonFetchCall[] = [];
  const responses = new Map<string, { status: number; body: unknown }>();

  const fetcher = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    const path = u.replace('http://test-daemon:9200', '');
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = init.body; }
    }
    calls.push({ url: u, method, body });
    const configured = responses.get(path);
    const responseBody = configured?.body ?? defaultResponseFor(path);
    const status = configured?.status ?? 200;
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  let originalFetch: typeof globalThis.fetch | undefined;

  return {
    calls,
    setRoute(path, response) { responses.set(path, { status: 200, body: response }); },
    setRouteError(path, status, errorMessage) {
      responses.set(path, { status, body: { error: errorMessage } });
    },
    reset() { calls.length = 0; responses.clear(); },
    install() {
      originalFetch = globalThis.fetch;
      globalThis.fetch = fetcher as typeof globalThis.fetch;
    },
    uninstall() {
      if (originalFetch) globalThis.fetch = originalFetch;
    },
  };
}

function defaultResponseFor(path: string): unknown {
  if (path === '/api/context-graph/create') return { created: 'autoresearch', uri: 'urn:context-graph:autoresearch' };
  if (path === '/api/subscribe') return { subscribed: 'autoresearch' };
  if (path === '/api/shared-memory/write') return { written: 0 };
  if (path === '/api/shared-memory/publish') return { kcId: 'kc-test-001', status: 'confirmed' };
  return {};
}

// ---------------------------------------------------------------------------
// Test harness: McpServer + InMemoryTransport + adapter tools
// ---------------------------------------------------------------------------

type TextContent = Array<{ type: string; text: string }>;

function getText(result: { content: unknown }): string {
  return (result.content as TextContent)[0].text;
}

async function createTestHarness(injectedClient?: DkgClientLike) {
  const client = injectedClient ?? createTestDkgClient();
  const server = new McpServer({ name: 'autoresearch-test', version: '0.0.1' });
  registerTools(server, client, TEST_CONFIG);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
  await mcpClient.connect(clientTransport);

  return { mcpClient, server, dkgClient: client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let fetchStub: DaemonFetchStub;

beforeEach(() => {
  fetchStub = createDaemonFetchStub();
  fetchStub.install();
});

afterEach(() => {
  fetchStub.uninstall();
});

describe('autoresearch adapter — tool registration', () => {
  let mcpClient: Client;

  beforeEach(async () => {
    ({ mcpClient } = await createTestHarness());
  });

  it('registers all 6 tools', async () => {
    const { tools } = await mcpClient.listTools();
    expect(tools).toHaveLength(6);
  });

  it('registers tools with expected names', async () => {
    const { tools } = await mcpClient.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'autoresearch_best_results',
      'autoresearch_experiment_history',
      'autoresearch_insights',
      'autoresearch_publish_experiment',
      'autoresearch_query',
      'autoresearch_setup',
    ]);
  });

  it('all tools have a description', async () => {
    const { tools } = await mcpClient.listTools();
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description!.length).toBeGreaterThan(0);
    }
  });
});

describe('autoresearch_setup', () => {
  it('creates context graph and subscribes', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({ name: 'autoresearch_setup', arguments: {} });
    const text = getText(result);

    expect(text).toContain('autoresearch');
    expect(text).toContain('subscribed');

    const createCall = fetchStub.calls.find(c => c.url.endsWith('/api/context-graph/create'));
    expect(createCall).toBeDefined();
    expect(createCall!.method).toBe('POST');
    expect(createCall!.body).toMatchObject({
      id: 'autoresearch',
      name: 'Autoresearch',
    });

    const subscribeCall = fetchStub.calls.find(c => c.url.endsWith('/api/subscribe'));
    expect(subscribeCall).toBeDefined();
    expect(subscribeCall!.body).toMatchObject({ contextGraphId: 'autoresearch' });
  });

  it('handles context graph already existing gracefully', async () => {
    fetchStub.setRouteError('/api/context-graph/create', 409, 'already exists');
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({ name: 'autoresearch_setup', arguments: {} });
    const text = getText(result);

    expect(text).toContain('ready');
    const subscribeCall = fetchStub.calls.find(c => c.url.endsWith('/api/subscribe'));
    expect(subscribeCall).toBeDefined();
  });

  it('returns error when subscribe fails', async () => {
    fetchStub.setRouteError('/api/subscribe', 503, 'network down');
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({ name: 'autoresearch_setup', arguments: {} });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('network down');
  });
});

describe('autoresearch_publish_experiment', () => {
  const baseArgs = {
    val_bpb: 0.9834,
    peak_vram_mb: 44200,
    status: 'keep' as const,
    description: 'increase depth to 12 layers',
  };

  it('publishes with required fields and returns URI + KC', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: baseArgs,
    });
    const text = getText(result);

    expect(text).toContain('Published experiment');
    expect(text).toContain('kc-test-001');
    expect(text).toContain('0.9834');
    expect(text).toContain('keep');
    expect(text).toContain('increase depth to 12 layers');
  });

  it('sends correct quads to the DKG daemon', async () => {
    const { mcpClient } = await createTestHarness();

    await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: baseArgs,
    });

    // Two-step publish path: write then publish. We assert on the write
    // payload — that's where the quads land. The publish call is a thin
    // anchor that takes only `{contextGraphId, selection, clearAfter}`.
    const writeCall = fetchStub.calls.find(c => c.url.endsWith('/api/shared-memory/write'));
    expect(writeCall).toBeDefined();
    const writeBody = writeCall!.body as { contextGraphId: string; quads: any[] };
    expect(writeBody.contextGraphId).toBe('autoresearch');
    const quads = writeBody.quads;

    const types = quads.filter((q: any) => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    expect(types).toHaveLength(1);
    expect(types[0].object).toBe(Class.Experiment);

    const valBpb = quads.find((q: any) => q.predicate === Prop.valBpb);
    expect(valBpb.object).toContain('0.9834');

    const status = quads.find((q: any) => q.predicate === Prop.status);
    expect(status.object).toBe(Status.Keep);

    const desc = quads.find((q: any) => q.predicate === Prop.description);
    expect(desc.object).toContain('increase depth to 12 layers');

    const ts = quads.find((q: any) => q.predicate === Prop.timestamp);
    expect(ts).toBeDefined();
    expect(ts.object).toMatch(/dateTime/);

    // Anchor step also fires.
    const publishCall = fetchStub.calls.find(c => c.url.endsWith('/api/shared-memory/publish'));
    expect(publishCall).toBeDefined();
    expect(publishCall!.body).toMatchObject({
      contextGraphId: 'autoresearch',
      selection: 'all',
      clearAfter: true,
    });
  });

  it('includes optional fields when provided', async () => {
    const { mcpClient } = await createTestHarness();

    await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: {
        ...baseArgs,
        commit_hash: 'a1b2c3d',
        platform: 'H100',
        run_tag: 'mar8',
        depth: 12,
        num_params_m: 75.2,
        training_seconds: 300.1,
        total_tokens_m: 499.6,
        mfu_percent: 39.8,
        num_steps: 953,
        code_diff: '--- a/train.py\n+++ b/train.py',
        agent_did: 'did:dkg:agent-7',
        parent_experiment: 'urn:autoresearch:exp:prev-123',
      },
    });

    const writeCall = fetchStub.calls.find(c => c.url.endsWith('/api/shared-memory/write'));
    const quads = (writeCall!.body as { quads: any[] }).quads;

    expect(quads.find((q: any) => q.predicate === Prop.commitHash)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.platform)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.runTag)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.depth)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.numParamsM)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.trainingSeconds)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.totalTokensM)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.mfuPercent)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.numSteps)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.codeDiff)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.agentDid)).toBeDefined();
    expect(quads.find((q: any) => q.predicate === Prop.parentExperiment)).toBeDefined();
  });

  it('omits optional fields when not provided', async () => {
    const { mcpClient } = await createTestHarness();

    await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: baseArgs,
    });

    const writeCall = fetchStub.calls.find(c => c.url.endsWith('/api/shared-memory/write'));
    const quads = (writeCall!.body as { quads: any[] }).quads;

    expect(quads.find((q: any) => q.predicate === Prop.commitHash)).toBeUndefined();
    expect(quads.find((q: any) => q.predicate === Prop.platform)).toBeUndefined();
    expect(quads.find((q: any) => q.predicate === Prop.codeDiff)).toBeUndefined();
  });

  it('maps status values to correct ontology URIs', async () => {
    const { mcpClient } = await createTestHarness();

    for (const [statusStr, expectedUri] of [
      ['keep', Status.Keep],
      ['discard', Status.Discard],
      ['crash', Status.Crash],
    ] as const) {
      fetchStub.reset();

      await mcpClient.callTool({
        name: 'autoresearch_publish_experiment',
        arguments: { ...baseArgs, status: statusStr },
      });

      const writeCall = fetchStub.calls.find(c => c.url.endsWith('/api/shared-memory/write'));
      const quads = (writeCall!.body as { quads: any[] }).quads;
      const statusQuad = quads.find((q: any) => q.predicate === Prop.status);
      expect(statusQuad.object).toBe(expectedUri);
    }
  });

  it('returns error when publish fails', async () => {
    fetchStub.setRouteError('/api/shared-memory/publish', 503, 'DKG daemon not running');
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_publish_experiment',
      arguments: baseArgs,
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('DKG daemon not running');
  });
});

describe('autoresearch_best_results', () => {
  it('returns "no experiments" when context graph is empty', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_best_results',
      arguments: {},
    });

    expect(getText(result)).toContain('No experiments found');
  });

  it('formats results when experiments exist', async () => {
    const mock = createTestDkgClient({
      query: trackingAsyncFn(async () => ({
        bindings: [
          {
            exp: 'urn:autoresearch:exp:1',
            valBpb: '"0.9712"^^<http://www.w3.org/2001/XMLSchema#double>',
            peakVram: '"44000"^^<http://www.w3.org/2001/XMLSchema#double>',
            status: `${NS}keep`,
            desc: '"SwiGLU + depth 16"',
            ts: '"2026-03-08T12:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
            platform: '"H100"',
          },
        ],
      })),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_best_results',
      arguments: { limit: 10 },
    });
    const text = getText(result);

    expect(text).toContain('Top 1 experiments');
    expect(text).toContain('0.9712');
    expect(text).toContain('SwiGLU + depth 16');
    expect(text).toContain('H100');
  });

  it('passes SPARQL query to client with correct context graph', async () => {
    const mock = createTestDkgClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_best_results',
      arguments: { limit: 5 },
    });

    const queryCalls = (mock.query as TrackingFn<unknown>).calls;
    expect(queryCalls).toHaveLength(1);
    // Object-arg shape per mcp-dkg's `DkgClient.query`. Replaces the
    // legacy positional `(sparql, contextGraphId)` form.
    const [args] = queryCalls[0] as [{ sparql: string; contextGraphId?: string }];
    expect(args.contextGraphId).toBe('autoresearch');
    expect(args.sparql).toContain(Class.Experiment);
    expect(args.sparql).toContain('ORDER BY ASC(?valBpb)');
    expect(args.sparql).toContain('LIMIT 5');
  });
});

describe('autoresearch_experiment_history', () => {
  it('returns "no experiments" when filter matches nothing', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_experiment_history',
      arguments: { run_tag: 'nonexistent' },
    });

    expect(getText(result)).toContain('No experiments found');
  });

  it('includes run_tag filter in SPARQL when provided', async () => {
    const mock = createTestDkgClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_experiment_history',
      arguments: { run_tag: 'mar8' },
    });

    const [args] = (mock.query as TrackingFn<unknown>).calls[0] as [{ sparql: string }];
    expect(args.sparql).toContain(Prop.runTag);
    expect(args.sparql).toContain('mar8');
  });

  it('includes agent_did filter in SPARQL when provided', async () => {
    const mock = createTestDkgClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_experiment_history',
      arguments: { agent_did: 'did:dkg:agent-7' },
    });

    const [args] = (mock.query as TrackingFn<unknown>).calls[0] as [{ sparql: string }];
    expect(args.sparql).toContain(Prop.agentDid);
    expect(args.sparql).toContain('did:dkg:agent-7');
  });

  it('returns table-formatted results', async () => {
    const mock = createTestDkgClient({
      query: trackingAsyncFn(async () => ({
        bindings: [
          {
            exp: 'urn:autoresearch:exp:1',
            valBpb: '"0.9979"',
            peakVram: '"45060"',
            status: `${NS}keep`,
            desc: '"baseline"',
            ts: '"2026-03-08T08:00:00Z"',
            commitHash: '"a1b2c3d"',
          },
          {
            exp: 'urn:autoresearch:exp:2',
            valBpb: '"0.9834"',
            peakVram: '"44200"',
            status: `${NS}keep`,
            desc: '"increase depth"',
            ts: '"2026-03-08T08:06:00Z"',
            commitHash: '"b2c3d4e"',
          },
        ],
      })),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_experiment_history',
      arguments: {},
    });
    const text = getText(result);

    expect(text).toContain('2 results');
    expect(text).toContain('baseline');
    expect(text).toContain('increase depth');
    expect(text).toContain('a1b2c3d');
  });
});

describe('autoresearch_insights', () => {
  it('returns "no experiments" when keyword matches nothing', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_insights',
      arguments: { keyword: 'quantum' },
    });

    expect(getText(result)).toContain('No experiments found matching "quantum"');
  });

  it('includes keyword FILTER in SPARQL', async () => {
    const mock = createTestDkgClient();
    const { mcpClient } = await createTestHarness(mock);

    await mcpClient.callTool({
      name: 'autoresearch_insights',
      arguments: { keyword: 'learning rate' },
    });

    const [args] = (mock.query as TrackingFn<unknown>).calls[0] as [{ sparql: string }];
    expect(args.sparql).toContain('FILTER(CONTAINS(LCASE(?desc)');
    expect(args.sparql).toContain('learning rate');
  });

  it('shows summary with keep/discard/crash counts', async () => {
    const mock = createTestDkgClient({
      query: trackingAsyncFn(async () => ({
        bindings: [
          { exp: 'urn:1', valBpb: '"0.98"', status: `${NS}keep`, desc: '"LR 0.06"' },
          { exp: 'urn:2', valBpb: '"1.01"', status: `${NS}discard`, desc: '"LR 0.2"' },
          { exp: 'urn:3', valBpb: '"0.00"', status: `${NS}crash`, desc: '"LR 1.0 OOM"' },
        ],
      })),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_insights',
      arguments: { keyword: 'LR' },
    });
    const text = getText(result);

    expect(text).toContain('3 experiments');
    expect(text).toContain('1 kept');
    expect(text).toContain('1 discarded');
    expect(text).toContain('1 crashed');
  });
});

describe('autoresearch_query', () => {
  it('passes raw SPARQL to client', async () => {
    const mock = createTestDkgClient({
      query: trackingAsyncFn(async () => ({
        bindings: [{ avg: '"0.9856"' }],
      })),
    });
    const { mcpClient } = await createTestHarness(mock);

    const sparql = `SELECT (AVG(?v) AS ?avg) WHERE { ?e a <${Class.Experiment}> ; <${Prop.valBpb}> ?v }`;
    const result = await mcpClient.callTool({
      name: 'autoresearch_query',
      arguments: { sparql },
    });

    const queryCalls = (mock.query as TrackingFn<unknown>).calls;
    expect(queryCalls).toHaveLength(1);
    const [args] = queryCalls[0] as [{ sparql: string; contextGraphId?: string }];
    expect(args.sparql).toBe(sparql);
    expect(args.contextGraphId).toBe('autoresearch');
    expect(getText(result)).toContain('0.9856');
  });

  it('returns "(no results)" for empty bindings', async () => {
    const { mcpClient } = await createTestHarness();

    const result = await mcpClient.callTool({
      name: 'autoresearch_query',
      arguments: { sparql: 'SELECT ?x WHERE { ?x a <Nothing> }' },
    });

    expect(getText(result)).toBe('(no results)');
  });

  it('returns error on query failure', async () => {
    const mock = createTestDkgClient({
      query: trackingAsyncFn(async () => { throw new Error('SPARQL syntax error'); }),
    });
    const { mcpClient } = await createTestHarness(mock);

    const result = await mcpClient.callTool({
      name: 'autoresearch_query',
      arguments: { sparql: 'BAD QUERY' },
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain('SPARQL syntax error');
  });
});

// Note: the legacy "custom context graph" test (which exercised passing a
// 3rd `contextGraphId` argument to `registerTools`) is removed in this
// PR — the parity-matrix v0.5 §4.21 shim signature drops that public
// parameter. Each adapter now targets its own canonical CG; per-call
// override semantics will return as an opts-bag if a real consumer needs
// it. No tests are added in its place because there is no longer a
// public surface to verify.
