import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
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

function runCtx(method: string, rawPath: string, agent: any, body?: unknown) {
  const res = fakeRes();
  // Mirror handle-request.ts: route on url.pathname, query lives on url.
  const url = new URL(`http://127.0.0.1${rawPath}`);
  const ctx = {
    req: fakeReq(method, rawPath, body),
    res,
    agent,
    path: url.pathname,
    url,
  } as unknown as RequestContext;
  return { res, done: handlePcaRoutes(ctx) };
}

describe('daemon /api/pca V10 caller contract', () => {
  it('POST /api/pca accepts a V10 body with only tokens (no lockEpochs) → 200', async () => {
    const agent = {
      createPublishingConvictionAccount: async () => ({
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
      registerPublishingConvictionAgent: async (id: bigint, a: string) => {
        registered = { id, agent: a };
        return { hash: '0xreg', blockNumber: 9, success: true };
      },
      isPublishingConvictionAgent: async () => true,
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
      deregisterPublishingConvictionAgent: async (id: bigint, a: string) => {
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
      deregisterPublishingConvictionAgent: async () => {
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
      registerPublishingConvictionAgent: async () => {
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
      settlePublishingConvictionAccount: async (id: bigint) => {
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
      settlePublishingConvictionAccount: async () => {
        throw new Error('No blockchain configured. To use on-chain operations, provide chainConfig');
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/2/settle', agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('maps an owner-gated NotAccountOwner revert on funds top-up to HTTP 403', async () => {
    const agent = {
      topUpPublishingConvictionAccount: async () => {
        throw new Error('Mock: NotAccountOwner(1, 0xdeadbeef)');
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/1/funds', agent, { tokens: '50' });
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('round-trips register/funds → GET reflects agentCount and topUpBuffer', async () => {
    const state = { agents: new Set<string>(), topUp: 0n };
    const agent = {
      registerPublishingConvictionAgent: async (_id: bigint, a: string) => {
        state.agents.add(a.toLowerCase());
        return { hash: '0xr', blockNumber: 1, success: true };
      },
      deregisterPublishingConvictionAgent: async (_id: bigint, a: string) => {
        state.agents.delete(a.toLowerCase());
        return { hash: '0xd', blockNumber: 2, success: true };
      },
      isPublishingConvictionAgent: async (_id: bigint, a: string) => state.agents.has(a.toLowerCase()),
      topUpPublishingConvictionAccount: async (_id: bigint, amount: bigint) => {
        state.topUp += amount;
        return { hash: '0xt', blockNumber: 3, success: true };
      },
      getPublishingConvictionAccountInfo: async () => ({
        owner: '0x' + '9'.repeat(40),
        committedTRAC: 100n,
        baseEpochAllowance: 1n,
        createdAtEpoch: 1,
        expiresAtEpoch: 9,
        createdAtTimestamp: 0,
        expiresAtTimestamp: 0,
        discountBps: 500,
        topUpBuffer: state.topUp,
        agentCount: state.agents.size,
        lastSettledWindow: 0,
        fullySwept: false,
      }),
    };
    const addr = '0x' + '3'.repeat(40);

    const reg = runCtx('POST', '/api/pca/1/agent', agent, { agent: addr });
    await reg.done;
    const fund = runCtx('POST', '/api/pca/1/funds', agent, { tokens: '5' });
    await fund.done;

    const get = runCtx('GET', '/api/pca/1', agent);
    await get.done;
    expect(get.res.statusCode).toBe(200);
    const body = JSON.parse(get.res.body);
    expect(body.agentCount).toBe(1);
    expect(body.topUpBuffer).toBe(ethers.parseEther('5').toString());
  });

  it('maps a NoChainAdapter noChain() throw to HTTP 503, not 500', async () => {
    const noChainErr = () => {
      throw new Error(
        'No blockchain configured. To use on-chain operations, provide chainConfig ' +
        '(rpcUrl, hubAddress, privateKey) when creating the agent, or set DKG_PRIVATE_KEY.',
      );
    };
    const create = runCtx('POST', '/api/pca', { createPublishingConvictionAccount: noChainErr }, { tokens: '1' });
    await create.done;
    expect(create.res.statusCode).toBe(503);

    const info = runCtx('GET', '/api/pca/1', { getPublishingConvictionAccountInfo: noChainErr });
    await info.done;
    expect(info.res.statusCode).toBe(503);
  });

  it('maps a "NFT not deployed on this Hub" throw to HTTP 503 on write and GET, not 500/404', async () => {
    const undeployed = () => { throw new Error('DKGPublishingConvictionNFT not deployed on this Hub.'); };
    const create = runCtx('POST', '/api/pca', { createPublishingConvictionAccount: undeployed }, { tokens: '1' });
    await create.done;
    expect(create.res.statusCode).toBe(503);

    const get = runCtx('GET', '/api/pca/1', { getPublishingConvictionAccountInfo: undeployed });
    await get.done;
    expect(get.res.statusCode).toBe(503);
  });

  it('maps a typed PcaUnavailableError (code PCA_UNAVAILABLE) to HTTP 503 on settle', async () => {
    const agent = {
      settlePublishingConvictionAccount: async () => {
        const e: any = new Error('boom'); e.code = 'PCA_UNAVAILABLE'; throw e;
      },
    };
    const { res, done } = runCtx('POST', '/api/pca/2/settle', agent);
    await done;
    expect(res.statusCode).toBe(503);
  });

  it('genuine account-missing (getInfo returns null on a deployed adapter) stays 404', async () => {
    const agent = {
      chain: { getPublishingConvictionAccountInfo: () => null },
      getPublishingConvictionAccountInfo: async () => null,
    };
    const { res, done } = runCtx('GET', '/api/pca/9', agent);
    await done;
    expect(res.statusCode).toBe(404);
  });

  it('maps known PCA contract reverts to 4xx (InvalidAmount 400, Already/NotRegistered 409, AccountExpired 409)', async () => {
    const addr = '0x' + '4'.repeat(40);
    const inv = runCtx('POST', '/api/pca', {
      createPublishingConvictionAccount: async () => { throw new Error('execution reverted: InvalidAmount()'); },
    }, { tokens: '1' });
    await inv.done;
    expect(inv.res.statusCode).toBe(400);
    expect(JSON.parse(inv.res.body).error).toBe('InvalidAmount');

    const dup = runCtx('POST', '/api/pca/1/agent', {
      registerPublishingConvictionAgent: async () => { throw new Error('reverted: AgentAlreadyRegistered(1)'); },
    }, { agent: addr });
    await dup.done;
    expect(dup.res.statusCode).toBe(409);

    const missing = runCtx('DELETE', `/api/pca/1/agent/${addr}`, {
      deregisterPublishingConvictionAgent: async () => { throw new Error('reverted: AgentNotRegistered(1)'); },
    });
    await missing.done;
    expect(missing.res.statusCode).toBe(409);

    const expired = runCtx('POST', '/api/pca/1/funds', {
      topUpPublishingConvictionAccount: async () => { throw new Error('reverted: AccountExpired(1)'); },
    }, { tokens: '5' });
    await expired.done;
    expect(expired.res.statusCode).toBe(409);
  });

  it('owner revert still wins over generic revert classification (403, not 409)', async () => {
    const addr = '0x' + '5'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/1/agent', {
      registerPublishingConvictionAgent: async () => { throw new Error('Mock: NotAccountOwner(1, 0xdead)'); },
    }, { agent: addr });
    await done;
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/pca/:id/agent with the zero address → 400, facade not called', async () => {
    let called = false;
    const agent = {
      registerPublishingConvictionAgent: async () => { called = true; return { hash: '0x', blockNumber: 1, success: true }; },
    };
    const { res, done } = runCtx('POST', '/api/pca/1/agent', agent, { agent: ethers.ZeroAddress });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('agent must not be the zero address');
    expect(called).toBe(false);
  });

  it('DELETE /api/pca/:id/agent/:address with the zero address → 400, facade not called', async () => {
    let called = false;
    const agent = {
      deregisterPublishingConvictionAgent: async () => { called = true; return { hash: '0x', blockNumber: 1, success: true }; },
    };
    const { res, done } = runCtx('DELETE', `/api/pca/1/agent/${ethers.ZeroAddress}`, agent);
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('agent must not be the zero address');
    expect(called).toBe(false);
  });

  it('maps a ZeroAgentAddress revert (defense-in-depth, guard bypassed) → 400', async () => {
    const addr = '0x' + '7'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/1/agent', {
      registerPublishingConvictionAgent: async () => { throw new Error('execution reverted: ZeroAgentAddress()'); },
    }, { agent: addr });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('ZeroAgentAddress');
  });

  it('maps an AgentCapReached revert on agent register → 409', async () => {
    const addr = '0x' + '8'.repeat(40);
    const { res, done } = runCtx('POST', '/api/pca/1/agent', {
      registerPublishingConvictionAgent: async () => { throw new Error('execution reverted: AgentCapReached(1, 100)'); },
    }, { agent: addr });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('AgentCapReached');
  });

  it('maps a TokenTransferFailed revert on POST /api/pca → 400', async () => {
    const { res, done } = runCtx('POST', '/api/pca', {
      createPublishingConvictionAccount: async () => { throw new Error('execution reverted: TokenTransferFailed()'); },
    }, { tokens: '100' });
    await done;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('TokenTransferFailed');
  });

  it('maps an AccountAlreadyFullySettled revert on POST /api/pca/:id/settle → 409', async () => {
    const { res, done } = runCtx('POST', '/api/pca/2/settle', {
      settlePublishingConvictionAccount: async () => { throw new Error('execution reverted: AccountAlreadyFullySettled(2)'); },
    });
    await done;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('AccountAlreadyFullySettled');
  });

  it('GET ?key= probe exposes `registered` (not `authorized`)', async () => {
    const addr = '0x' + '6'.repeat(40);
    const agent = {
      getPublishingConvictionAccountInfo: async () => ({
        owner: '0x' + '9'.repeat(40),
        committedTRAC: 1n, baseEpochAllowance: 1n, createdAtEpoch: 1, expiresAtEpoch: 9,
        createdAtTimestamp: 0, expiresAtTimestamp: 0, discountBps: 0, topUpBuffer: 0n,
        agentCount: 1, lastSettledWindow: 0, fullySwept: false,
      }),
      isPublishingConvictionAgent: async () => true,
    };
    const { res, done } = runCtx('GET', `/api/pca/1?key=${addr}`, agent);
    await done;
    expect(res.statusCode).toBe(200);
    const probe = JSON.parse(res.body).probedKey;
    expect(probe.registered).toBe(true);
    expect(probe).not.toHaveProperty('authorized');
  });
});
