import { describe, it, expect } from 'vitest';
import { handlePcaRoutes } from '../src/daemon/routes/pca.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '' };
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.end = (body: string) => { res.body = body; };
  return res;
}

function fakeReq(method: string, path: string, body?: unknown) {
  const req: any = { method, url: path };
  if (body !== undefined) {
    req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  }
  return req;
}

function runCtx(method: string, path: string, agent: any, body?: unknown) {
  const res = fakeRes();
  const ctx = {
    req: fakeReq(method, path, body),
    res,
    agent,
    path,
    url: new URL(`http://127.0.0.1${path}`),
  } as unknown as RequestContext;
  return { res, done: handlePcaRoutes(ctx) };
}

describe('daemon /api/pca V10 caller contract', () => {
  it('POST /api/pca accepts a V10 body with only tokens (no lockEpochs) → 200', async () => {
    const agent = {
      createConvictionAccount: async () => ({
        accountId: 1n, hash: '0xabc', blockNumber: 7, success: true,
      }),
    };
    const { res, done } = runCtx('POST', '/api/pca', agent, { tokens: '100' });
    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).accountId).toBe('1');
  });

  it('maps an owner-gated NotAccountOwner revert on agent register to HTTP 403', async () => {
    const agent = {
      registerConvictionAgent: async () => {
        throw new Error('Mock: NotAccountOwner(1, 0xdeadbeef)');
      },
    };
    const key = '0x' + '1'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/1/authorize', agent, { key });
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('maps an owner-gated NotAccountOwner revert on funds top-up to HTTP 403', async () => {
    const agent = {
      topUpConvictionAccount: async () => {
        throw new Error('Mock: NotAccountOwner(1, 0xdeadbeef)');
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/1/funds', agent, { tokens: '50' });
    await done;
    expect(res.statusCode).toBe(403);
  });
});
