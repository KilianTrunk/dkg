// KC→KA rename guard — POST /api/update response contract.
//
// `/api/update` (agent-chat.ts) had NO route test at all, yet it is the
// HTTP surface for Knowledge Asset updates and shapes its response as
// `kaId: String(result.kaId)`. After the KC→KA rename re-plumbed
// `agent.update`'s return type, a regression that left `result.kaId`
// undefined/zero would surface to clients as the strings "undefined" /
// "0" with a 200 status — silent data corruption from the caller's POV.
//
// These tests exercise the real route through `handleAgentChatRoutes`
// with a hand-rolled RequestContext (same pattern as
// agent-encryption-key-routes.test.ts) and pin:
//   - a confirmed update surfaces a POSITIVE DECIMAL kaId string,
//   - the parsed kaId is forwarded to agent.update as a bigint,
//   - missing / non-integer kaId is rejected with 400 before any update.

import { describe, it, expect, vi } from 'vitest';
import { handleAgentChatRoutes } from '../src/daemon/routes/agent-chat.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => {
    res.statusCode = status;
  };
  res.end = (body: string) => {
    res.body = body;
  };
  return res;
}

function fakeReq(method: string, path: string, body?: unknown) {
  const req: any = { method, url: path, headers: {} };
  if (body !== undefined) {
    req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  }
  return req;
}

function createTracker() {
  return {
    start: vi.fn(),
    phaseCallback: vi.fn(() => vi.fn()),
    trackPhase: vi.fn((_ctx: unknown, _phase: unknown, fn: () => Promise<unknown>) => fn()),
    complete: vi.fn(),
    fail: vi.fn(),
    setCost: vi.fn(),
    setTxHash: vi.fn(),
  };
}

function runUpdate(body: unknown, agent: Record<string, unknown>) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/update');
  const ctx = {
    req: fakeReq('POST', '/api/update', body),
    res,
    agent: agent as unknown as RequestContext['agent'],
    config: {} as RequestContext['config'],
    network: null as RequestContext['network'],
    tracker: createTracker() as unknown as RequestContext['tracker'],
    dashDb: {
      getOperation: vi.fn(() => ({ phases: [] })),
    } as unknown as RequestContext['dashDb'],
    path: url.pathname,
    url,
    requestToken: undefined,
    requestAgentAddress: '0x0000000000000000000000000000000000000001',
    validTokens: new Set<string>(),
  } as unknown as RequestContext;
  return { res, done: handleAgentChatRoutes(ctx) };
}

const QUADS = [{ subject: 'urn:root', predicate: 'http://schema.org/name', object: '"v2"' }];

describe('POST /api/update — kaId response contract (KC→KA)', () => {
  it('surfaces a confirmed update kaId as a positive decimal string and forwards a bigint kaId', async () => {
    const update = vi.fn(async () => ({
      kaId: 7n,
      status: 'confirmed',
      kaManifest: [{ tokenId: 7n, rootEntity: 'urn:root' }],
      onChainResult: {
        txHash: '0xabc',
        blockNumber: 123n,
        gasUsed: 1n,
        effectiveGasPrice: 1n,
        gasCostWei: 1n,
        tokenAmount: 1n,
      },
    }));

    const { res, done } = runUpdate(
      { kaId: '7', contextGraphId: 'project-a', quads: QUADS },
      { update },
    );
    await done;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // The crux: String(result.kaId) must be a positive integer string, not
    // "undefined" / "0" / "kc-1". A regression in agent.update's return shape
    // after the rename would trip this.
    expect(body.kaId).toBe('7');
    expect(body.kaId).toMatch(/^[1-9]\d*$/);
    expect(body.status).toBe('confirmed');
    expect(body.kas).toEqual([{ tokenId: '7', rootEntity: 'urn:root' }]);
    expect(body.txHash).toBe('0xabc');
    // The route parses the inbound kaId string into a bigint before calling
    // agent.update — pin that conversion so a string id can't leak through.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe(7n);
    expect(update.mock.calls[0][1]).toBe('project-a');
  });

  it('rejects a missing kaId with 400 and never calls agent.update', async () => {
    const update = vi.fn();
    const { res, done } = runUpdate(
      { contextGraphId: 'project-a', quads: QUADS },
      { update },
    );
    await done;
    expect(res.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a non-integer kaId with 400 before calling agent.update', async () => {
    const update = vi.fn();
    const { res, done } = runUpdate(
      { kaId: 'not-a-number', contextGraphId: 'project-a', quads: QUADS },
      { update },
    );
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid "kaId"/);
    expect(update).not.toHaveBeenCalled();
  });
});
