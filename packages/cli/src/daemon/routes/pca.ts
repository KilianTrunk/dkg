// V10 Publishing Conviction NFT operator routes (see ARCHITECTURE.md
// § #519). Owner-gated writes: owner revert → 403, no-chain → 503.

import { ethers } from 'ethers';
import type { V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const FEATURE_UNAVAILABLE_503 = {
  error:
    'Chain adapter does not expose V10 Publishing Conviction NFT methods — ' +
    'PCA management is not available on this deployment',
};

function safeParseJson(body: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e: any) {
    return { ok: false, error: `Invalid JSON: ${e?.message ?? String(e)}` };
  }
}

// Owner-gated write by a non-owner daemon EOA → 403 (distinct from 500
// RPC / 503 no-chain). `NotAccountAdmin` kept for legacy parity.
function isOwnerRevert(msg: string): boolean {
  return /NotAccountOwner|NotAccountAdmin/i.test(msg);
}

// NoChainAdapter throws `noChain()` instead of returning null → 503.
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
  info: V10PublishingConvictionAccountInfo,
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

  // POST /api/pca — mint a conviction NFT to the daemon EOA (the owner).
  // No `lockEpochs` (global protocol param). Body: { tokens: "100000" }
  if (req.method === 'POST' && path === '/api/pca') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { tokens } = parsed.value ?? {};
    const amount = parseTokenAmount(tokens, 'tokens');
    if (typeof amount !== 'bigint') return jsonResponse(res, 400, amount);
    try {
      const result = await agent.createPublishingConvictionAccount(amount);
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
        error: `createPublishingConvictionAccount failed: ${msg}`,
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
      const result = await agent.registerPublishingConvictionAgent(accountId, agentAddr);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      const verified = (await agent.isPublishingConvictionAgent(accountId, agentAddr)) ?? null;
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
      return jsonResponse(res, 500, { error: `registerPublishingConvictionAgent failed: ${msg}` });
    }
  }

  // DELETE /api/pca/:id/agent/:address — deregister a publishing agent.
  // Owner-gated; the daemon's EOA must be the PCA NFT owner.
  if (req.method === 'DELETE' && /^\/api\/pca\/[^/]+\/agent\/[^/]+$/.test(path)) {
    const parts = path.split('/');
    const idStr = decodeURIComponent(parts[3] ?? '');
    const agentAddr = decodeURIComponent(parts[5] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    if (!ethers.isAddress(agentAddr)) {
      return jsonResponse(res, 400, { error: 'agent must be a valid 0x-prefixed EVM address' });
    }
    try {
      const result = await agent.deregisterPublishingConvictionAgent(accountId, agentAddr);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: idStr,
        agent: agentAddr,
        deregistered: true,
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
      return jsonResponse(res, 500, { error: `deregisterPublishingConvictionAgent failed: ${msg}` });
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
      const result = await agent.topUpPublishingConvictionAccount(accountId, amount);
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
      return jsonResponse(res, 500, { error: `topUpPublishingConvictionAccount failed: ${msg}` });
    }
  }

  // POST /api/pca/:id/settle — run the lazy-settlement sweep. The
  // contract method is permissionless, so no owner gating here.
  if (req.method === 'POST' && /^\/api\/pca\/[^/]+\/settle$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    try {
      const result = await agent.settlePublishingConvictionAccount(accountId);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: idStr,
        settled: true,
        txHash: result.hash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 500, { error: `settlePublishingConvictionAccount failed: ${msg}` });
    }
  }

  // GET /api/pca/:id — V10 conviction NFT snapshot. Optional ?key=0x...
  // probes whether that address is a registered agent.
  if (req.method === 'GET' && /^\/api\/pca\/[^/]+$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    try {
      const info = await agent.getPublishingConvictionAccountInfo(accountId);
      if (info === null) {
        // null = view absent OR account missing; disambiguate by probe.
        if (typeof (agent as any).chain?.getPublishingConvictionAccountInfo !== 'function') {
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
          const isAuth = await agent.isPublishingConvictionAgent(accountId, probedKey);
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
        error: `getPublishingConvictionAccountInfo failed: ${msg}`,
      });
    }
  }
}
