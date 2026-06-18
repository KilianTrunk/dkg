import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string>, writableEnded: false };
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
  };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.end = (body: string) => {
    res.body = body;
    res.writableEnded = true;
  };
  return res;
}

function fakeReq(body: unknown) {
  return {
    method: 'POST',
    headers: {},
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  } as any;
}

function buildCatchupCtx(body: unknown, agent: Record<string, any>) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/shared-memory/catchup');
  const ctx = {
    req: fakeReq(body),
    res,
    agent,
    path: url.pathname,
    url,
  } as unknown as RequestContext;
  return { ctx, res };
}

describe('POST /api/shared-memory/catchup durable leg', () => {
  it('still runs includeDurable when SWM is not currently usable for the CG', async () => {
    const syncSharedMemoryFromPeerDetailed = vi.fn();
    const syncSharedMemoryFromPeer = vi.fn();
    const syncFromPeer = vi.fn(async () => 7);
    const agent = {
      peerId: 'self-peer',
      canUseSharedMemoryForContextGraph: vi.fn(async () => false),
      getPeerProtocols: vi.fn(async () => [PROTOCOL_SYNC]),
      isPrivateContextGraph: vi.fn(async () => false),
      syncSharedMemoryFromPeerDetailed,
      syncSharedMemoryFromPeer,
      syncFromPeer,
    };
    const { ctx, res } = buildCatchupCtx(
      {
        contextGraphId: 'review-cg',
        peerId: 'peer-a',
        includeDurable: true,
        hostCatchupFallback: false,
      },
      agent,
    );

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(syncSharedMemoryFromPeerDetailed).not.toHaveBeenCalled();
    expect(syncSharedMemoryFromPeer).not.toHaveBeenCalled();
    expect(syncFromPeer).toHaveBeenCalledTimes(1);
    expect(syncFromPeer).toHaveBeenCalledWith('peer-a', ['review-cg']);

    const body = JSON.parse(res.body);
    expect(body.totalInsertedTriples).toBe(0);
    expect(body.totalDurableInsertedTriples).toBe(7);
    expect(body.peersAttempted).toBe(1);
    expect(body.perContextGraph).toEqual([
      {
        contextGraphId: 'review-cg',
        insertedTriples: 0,
        durableInsertedTriples: 7,
        perPeer: [
          {
            peerId: 'peer-a',
            insertedTriples: 0,
            durableInsertedTriples: 7,
          },
        ],
      },
    ]);
  });
});
