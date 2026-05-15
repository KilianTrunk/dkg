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

  it('POST /api/pca/:id/agent registers an agent → 200 with txHash', async () => {
    let registered: { id: bigint; agent: string } | null = null;
    const addr = '0x' + '1'.repeat(40);
    const agent = {
      registerConvictionAgent: async (id: bigint, a: string) => {
        registered = { id, agent: a };
        return { hash: '0xreg', blockNumber: 9, success: true };
      },
      isConvictionAgent: async () => true,
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.txHash).toBe('0xreg');
    expect(body.registered).toBe(true);
    expect(registered).toEqual({ id: 1n, agent: addr });
  });

  it('DELETE /api/pca/:id/agent/:address deregisters an agent → 200', async () => {
    let deregistered: { id: bigint; agent: string } | null = null;
    const addr = '0x' + '2'.repeat(40);
    const agent = {
      deregisterConvictionAgent: async (id: bigint, a: string) => {
        deregistered = { id, agent: a };
        return { hash: '0xdereg', blockNumber: 11, success: true };
      },
    };
    const { res, done } = runCtx('DELETE', `/api/pca/1/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.txHash).toBe('0xdereg');
    expect(body.deregistered).toBe(true);
    expect(deregistered).toEqual({ id: 1n, agent: addr });
  });

  it('maps an owner-gated NotAccountOwner revert on agent deregister to HTTP 403', async () => {
    const agent = {
      deregisterConvictionAgent: async () => {
        throw new Error('Mock: NotAccountOwner(1, 0xdeadbeef)');
      },
    };
    const addr = '0x' + '2'.repeat(40);
    const { res, done } = runCtx('DELETE', `/api/pca/1/agent/${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('maps an owner-gated NotAccountOwner revert on agent register to HTTP 403', async () => {
    const agent = {
      registerConvictionAgent: async () => {
        throw new Error('Mock: NotAccountOwner(1, 0xdeadbeef)');
      },
    };
    const addr = '0x' + '1'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/pca/:id/settle runs settle() → 200', async () => {
    let settledId: bigint | null = null;
    const agent = {
      settleConvictionAccount: async (id: bigint) => {
        settledId = id;
        return { hash: '0xsettle', blockNumber: 13, success: true };
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/2/settle', agent);
    await done;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.txHash).toBe('0xsettle');
    expect(settledId).toBe(2n);
  });

  it('maps a NoChainAdapter noChain() throw on settle to HTTP 503', async () => {
    const agent = {
      settleConvictionAccount: async () => {
        throw new Error('No blockchain configured. To use on-chain operations, provide chainConfig');
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/2/settle', agent);
    await done;
    expect(res.statusCode).toBe(503);
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

  it('maps a NoChainAdapter noChain() throw to HTTP 503, not 500', async () => {
    const noChainErr = () => {
      throw new Error(
        'No blockchain configured. To use on-chain operations, provide chainConfig ' +
        '(rpcUrl, hubAddress, privateKey) when creating the agent, or set DKG_PRIVATE_KEY.',
      );
    };
    const create = runCtx('POST', '/api/pca', { createConvictionAccount: noChainErr }, { tokens: '1' });
    await create.done;
    expect(create.res.statusCode).toBe(503);

    const info = runCtx('GET', '/api/pca/1', { getConvictionAccountInfo: noChainErr });
    await info.done;
    expect(info.res.statusCode).toBe(503);
  });
});
