// daemon/routes/pca.ts
//
// Route handlers for Publishing Conviction Account (PCA) operator
// surface. Lives in its own file (instead of folding into `assertion.ts`)
// because PCAs are a distinct economic primitive: they're the off-chain
// expression of the on-chain `PublishingConvictionAccount` contract,
// driven by an operator standing up the runbook fixtures, not by the
// publish/query data path.
//
// The routes delegate to the V10 agent facade methods in
// `packages/agent/src/dkg-agent.ts` (createConvictionAccount,
// registerConvictionAgent, isConvictionAgent, getConvictionAccountInfo,
// topUpConvictionAccount), which in turn delegate to the chain adapter.
// Reads are permissionless on chain; writes are owner-gated by the
// on-chain `_requireOwner` check, so the daemon must be running as the
// PCA owner EOA for the authorize/funds routes to land.
//
// Adapters that don't expose the underlying chain methods (no-chain
// mode, pre-V10.1 adapter copies) return 503 — same convention as the
// existing `/api/kc/:id/author` route.

import { ethers } from 'ethers';
import type { V10ConvictionAccountInfo } from '@origintrail-official/dkg-chain';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const FEATURE_UNAVAILABLE_503 = {
  error:
    'Chain adapter does not expose Publishing Conviction Account methods — ' +
    'V10.1 PCA management is not available on this deployment',
};

function safeParseJson(body: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e: any) {
    return { ok: false, error: `Invalid JSON: ${e?.message ?? String(e)}` };
  }
}

// Owner-gated V10 writes (createAccount aside) revert `NotAccountOwner`
// when the daemon EOA is not the NFT owner. Surface that as 403 so
// callers can distinguish "wrong daemon EOA" from a 500 RPC failure or
// a 503 no-chain adapter. `NotAccountAdmin` is kept for legacy parity.
function isOwnerRevert(msg: string): boolean {
  return /NotAccountOwner|NotAccountAdmin/i.test(msg);
}

// NoChainAdapter implements the V10 PCA methods but throws `noChain()`
// ("No blockchain configured ...") rather than returning null. Treat
// that throw the same as a null facade result: HTTP 503 unavailable,
// not a 500 RPC failure.
function isNoChain(msg: string): boolean {
  return /No blockchain configured/i.test(msg);
}

function parseAccountId(idStr: string): bigint | null {
  if (!/^\d+$/.test(idStr)) return null;
  try {
    const id = BigInt(idStr);
    return id >= 0n ? id : null;
  } catch {
    return null;
  }
}

function parseTokenAmount(raw: unknown, field: string): bigint | { error: string } {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: `${field} must be a decimal string of TRAC tokens` };
  }
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return { error: `${field} must be a positive decimal number of TRAC tokens` };
  }
  try {
    const wei = ethers.parseEther(s);
    if (wei <= 0n) return { error: `${field} must be > 0` };
    return wei;
  } catch (e: any) {
    return { error: `${field} parse error: ${e?.message ?? String(e)}` };
  }
}

function serializeAccountInfo(
  accountId: bigint,
  info: V10ConvictionAccountInfo,
): Record<string, unknown> {
  return {
    accountId: accountId.toString(),
    owner: info.owner,
    committedTRAC: info.committedTRAC.toString(),
    committedTRACTrac: ethers.formatEther(info.committedTRAC),
    baseEpochAllowance: info.baseEpochAllowance.toString(),
    topUpBuffer: info.topUpBuffer.toString(),
    topUpBufferTrac: ethers.formatEther(info.topUpBuffer),
    createdAtEpoch: info.createdAtEpoch,
    expiresAtEpoch: info.expiresAtEpoch,
    createdAtTimestamp: info.createdAtTimestamp,
    expiresAtTimestamp: info.expiresAtTimestamp,
    discountBps: info.discountBps,
    agentCount: info.agentCount,
    lastSettledWindow: info.lastSettledWindow,
    fullySwept: info.fullySwept,
  };
}

export async function handlePcaRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path } = ctx;

  if (!path.startsWith('/api/pca')) return;

  // POST /api/pca — mint a new V10 conviction NFT to the daemon's EOA,
  // which becomes the on-chain owner. The lock duration is a global
  // protocol parameter, so the body carries no `lockEpochs`.
  // Body: { tokens: "100000" }
  if (req.method === 'POST' && path === '/api/pca') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { tokens } = parsed.value ?? {};
    const amount = parseTokenAmount(tokens, 'tokens');
    if (typeof amount !== 'bigint') return jsonResponse(res, 400, amount);
    try {
      const result = await agent.createConvictionAccount(amount);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: result.accountId.toString(),
        txHash: result.hash,
        blockNumber: result.blockNumber,
        committedTokens: ethers.formatEther(amount),
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 500, {
        error: `createConvictionAccount failed: ${msg}`,
      });
    }
  }

  // POST /api/pca/:id/agent — register a publishing agent. Owner-gated;
  // the daemon's EOA must be the PCA NFT owner. Body: { agent: "0x..." }
  if (req.method === 'POST' && /^\/api\/pca\/[^/]+\/agent$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { agent: agentAddr } = parsed.value ?? {};
    if (typeof agentAddr !== 'string' || !ethers.isAddress(agentAddr)) {
      return jsonResponse(res, 400, { error: 'agent must be a valid 0x-prefixed EVM address' });
    }
    try {
      const result = await agent.registerConvictionAgent(accountId, agentAddr);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      const verified = (await agent.isConvictionAgent(accountId, agentAddr)) ?? null;
      return jsonResponse(res, 200, {
        accountId: idStr,
        agent: agentAddr,
        registered: verified === true,
        txHash: result.hash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isOwnerRevert(msg)) {
        return jsonResponse(res, 403, {
          error: 'NotAccountOwner — daemon EOA is not the PCA owner',
          accountId: idStr,
        });
      }
      return jsonResponse(res, 500, { error: `registerConvictionAgent failed: ${msg}` });
    }
  }

  // POST /api/pca/:id/funds — top-up a PCA. Owner-gated. Body: { tokens: "50000" }
  if (req.method === 'POST' && /^\/api\/pca\/[^/]+\/funds$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { tokens } = parsed.value ?? {};
    const amount = parseTokenAmount(tokens, 'tokens');
    if (typeof amount !== 'bigint') return jsonResponse(res, 400, amount);
    try {
      const result = await agent.topUpConvictionAccount(accountId, amount);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: idStr,
        addedTokens: ethers.formatEther(amount),
        txHash: result.hash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isOwnerRevert(msg)) {
        return jsonResponse(res, 403, {
          error: 'NotAccountOwner — daemon EOA is not the PCA owner',
          accountId: idStr,
        });
      }
      return jsonResponse(res, 500, { error: `topUpConvictionAccount failed: ${msg}` });
    }
  }

  // GET /api/pca/:id — read-only PCA snapshot (admin, balance, conviction,
  // current discount). Optional ?key=0x... probes whether `key` is
  // currently on the account's `authorizedKeys` set.
  if (req.method === 'GET' && /^\/api\/pca\/[^/]+$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    try {
      const info = await agent.getConvictionAccountInfo(accountId);
      if (info === null) {
        // Either the chain adapter doesn't expose the view, or the
        // account doesn't exist. The adapter contract returns null
        // for both — distinguish by probing the method itself.
        if (typeof (agent as any).chain?.getConvictionAccountInfo !== 'function') {
          return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
        }
        return jsonResponse(res, 404, { error: `Unknown PCA accountId ${idStr}` });
      }
      const probedKey = ctx.url.searchParams.get('key');
      const result: Record<string, unknown> = serializeAccountInfo(accountId, info);
      if (probedKey) {
        if (!ethers.isAddress(probedKey)) {
          result.probedKey = { key: probedKey, error: 'invalid EVM address' };
        } else {
          const isAuth = await agent.isConvictionAgent(accountId, probedKey);
          result.probedKey = {
            key: probedKey,
            authorized: isAuth === true,
            adapterSupported: isAuth !== null,
          };
        }
      }
      return jsonResponse(res, 200, result);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 500, {
        error: `getConvictionAccountInfo failed: ${msg}`,
      });
    }
  }
}
