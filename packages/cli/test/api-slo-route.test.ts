// /api/slo route-level wire-format regression test.
//
// rc.9 PR-A added two new top-level sections (`gossip`, `swm`) to
// the `/api/slo` response. Codex review on PR #570 R10 caught that
// the PR only exercised the internal getters/handlers; the public
// HTTP wire shape was untested, making it easy to silently break
// later — especially the cold-start case where `sharedMemoryHandler`
// is still undefined and the receiver-side stats getter must return
// the pristine snapshot.
//
// We pin the wire shape by exercising the production `buildSloPayload`
// helper (which the live route also calls) through a real HTTP
// roundtrip via `jsonResponse`. If the route's bundling shape, the
// helper's field names, or any of the three getters' return shape
// changes, this test fails — protecting soak tooling + operators
// from a silent breaking change.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { jsonResponse } from '../src/daemon/http-utils.js';
import { buildSloPayload } from '../src/daemon/routes/agent-chat.js';

type FakeAgent = Parameters<typeof buildSloPayload>[0];

async function startSloServer(agent: FakeAgent): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/slo') {
      return jsonResponse(res, 200, buildSloPayload(agent));
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('server addr unavailable');
  return { server, port: addr.port };
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

describe('/api/slo wire format (rc.9 PR-A / Codex PR #570 R10)', () => {
  let server: Server | null = null;
  let port = 0;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = null;
    }
  });

  it('pristine cold-start payload — all three sections present, all empty/zero', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({}),
      getSwmGossipStats: () => ({
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    expect(body).toEqual({
      protocols: {},
      gossip: {
        publishFailures: {},
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      },
      swm: {
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      },
    });
  });

  it('populated payload — every field flows through end-to-end', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({
        '/dkg/10.0.1/message': {
          samples: 847,
          p50Ms: 42,
          p95Ms: 380,
          p99Ms: 1240,
          delivered: 1602,
          queued: 14,
        },
      }),
      getSwmGossipStats: () => ({
        publishFailures: { 'did:dkg:context-graph:lex/playground': 3 },
        publishFailuresOverflow: 7,
        publishFailuresTruncated: true,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: { 'did:dkg:context-graph:lex/playground': 5 },
        redundantAppliesLowerBound: true,
        redundantAppliesOverflow: 11,
        redundantAppliesTruncated: true,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    expect(body).toEqual({
      protocols: {
        '/dkg/10.0.1/message': {
          samples: 847,
          p50Ms: 42,
          p95Ms: 380,
          p99Ms: 1240,
          delivered: 1602,
          queued: 14,
        },
      },
      gossip: {
        publishFailures: { 'did:dkg:context-graph:lex/playground': 3 },
        publishFailuresOverflow: 7,
        publishFailuresTruncated: true,
      },
      swm: {
        redundantApplies: { 'did:dkg:context-graph:lex/playground': 5 },
        redundantAppliesLowerBound: true,
        redundantAppliesOverflow: 11,
        redundantAppliesTruncated: true,
      },
    });
  });

  it('partial / mid-life payload — gossip populated, swm pristine', async () => {
    const agent: FakeAgent = {
      getMessengerSloStats: () => ({}),
      getSwmGossipStats: () => ({
        publishFailures: { 'cg-with-failures': 1 },
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      }),
      getSwmHandlerStats: () => ({
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      }),
    };
    ({ server, port } = await startSloServer(agent));

    const { status, body } = await get(port, '/api/slo');
    expect(status).toBe(200);
    expect(body).toEqual({
      protocols: {},
      gossip: {
        publishFailures: { 'cg-with-failures': 1 },
        publishFailuresOverflow: 0,
        publishFailuresTruncated: false,
      },
      swm: {
        redundantApplies: {},
        redundantAppliesLowerBound: false,
        redundantAppliesOverflow: 0,
        redundantAppliesTruncated: false,
      },
    });
  });
});
