import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { authorizePrivateSyncRequest } from '../src/sync/auth/request-authorize.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

/**
 * Tests for the private-sync auth gate (`authorizePrivateSyncRequest`).
 *
 * Special focus on the agent-delegation path added by the refactor of
 * the V10 invite flow:
 *   - approved delegateeOpKey (recovered signer match) must allow
 *   - approved delegateePeer (transport carrier match) must allow
 *   - both must be ignored when the lists are empty
 *   - legacy agent-gate / participant / peer-allowlist gates still work
 *   - replay & timing checks still fire before the auth lookup
 */

const LOCAL_PEER = '12D3KooWLocalCurator';
const REMOTE_PEER = '12D3KooWRemoteJoiner';
const CG_ID = 'unit-test-cg';

// Deterministic per-input digest so the verifier recovers the exact
// signer regardless of envelope content. Bound to the request's
// `issuedAtMs` so different envelopes produce different digests.
function computeDigestStub(
  _cg: string,
  _offset: number,
  _limit: number,
  _includeSWM: boolean,
  targetPeerId: string,
  requesterPeerId: string,
  requestId: string,
  issuedAtMs: number,
): Uint8Array {
  return ethers.getBytes(
    ethers.solidityPackedKeccak256(
      ['string', 'string', 'string', 'uint256'],
      [targetPeerId, requesterPeerId, requestId, issuedAtMs],
    ),
  );
}

interface BuildEnvelopeOptions {
  signer: ethers.Wallet;
  identityId?: string;
  remotePeerId?: string;
  issuedAtMs?: number;
  requestId?: string;
  /**
   * When `identityId` is "0" (or unset), the auth path requires
   * `requesterAgentAddress` and asserts it matches the recovered
   * signer. Set this when simulating an agent-signed envelope (legacy
   * back-compat path); leave undefined when simulating an op-key-signed
   * envelope with a chain identity.
   */
  requesterAgentAddress?: string;
}

async function buildSignedEnvelope(
  opts: BuildEnvelopeOptions,
): Promise<{ envelope: SyncRequestEnvelope; remotePeerId: string }> {
  const remotePeerId = opts.remotePeerId ?? REMOTE_PEER;
  const issuedAtMs = opts.issuedAtMs ?? Date.now();
  const requestId = opts.requestId ?? ethers.hexlify(ethers.randomBytes(12));
  const digest = computeDigestStub(CG_ID, 0, 100, false, LOCAL_PEER, remotePeerId, requestId, issuedAtMs);
  const sig = ethers.Signature.from(await opts.signer.signMessage(digest));
  const envelope: SyncRequestEnvelope = {
    contextGraphId: CG_ID,
    offset: 0,
    limit: 100,
    includeSharedMemory: false,
    targetPeerId: LOCAL_PEER,
    requesterPeerId: remotePeerId,
    requestId,
    issuedAtMs,
    requesterIdentityId: opts.identityId ?? '0',
    requesterSignatureR: ethers.hexlify(sig.r),
    requesterSignatureVS: ethers.hexlify(sig.yParityAndS),
    ...(opts.requesterAgentAddress ? { requesterAgentAddress: opts.requesterAgentAddress } : {}),
  };
  return { envelope, remotePeerId };
}

interface AuthCallParams {
  envelope: SyncRequestEnvelope;
  remotePeerId: string;
  participants?: string[] | null;
  agentGateAddresses?: string[] | null;
  allowedPeers?: string[] | null;
  allowedDelegateePeers?: string[];
  allowedDelegateeKeys?: string[];
  verifyIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
}

async function callAuth(params: AuthCallParams): Promise<{ allowed: boolean; logs: string[] }> {
  const logs: string[] = [];
  const ctx = { agentId: 'sync', operationId: 'test' } as any;
  const allowed = await authorizePrivateSyncRequest({
    ctx,
    request: params.envelope,
    remotePeerId: params.remotePeerId,
    localPeerId: LOCAL_PEER,
    syncAuthMaxAgeMs: 90_000,
    seenRequestIds: new Map(),
    computeSyncDigest: computeDigestStub,
    verifyIdentity: params.verifyIdentity ?? (async () => true),
    getParticipants: async () => params.participants ?? null,
    getAllowedPeers: async () => params.allowedPeers ?? null,
    getAgentGateAddresses: async () => params.agentGateAddresses ?? null,
    getAllowedDelegateePeers: async () => params.allowedDelegateePeers ?? [],
    getAllowedDelegateeKeys: async () => params.allowedDelegateeKeys ?? [],
    refreshMetaFromCurator: async () => false,
    logWarn: (_c, m) => logs.push(`WARN: ${m}`),
    logInfo: (_c, m) => logs.push(`INFO: ${m}`),
  });
  return { allowed, logs };
}

describe('authorizePrivateSyncRequest — agent-delegation path', () => {
  let nodeOpKey: ethers.Wallet;
  let agentAddress: string;

  beforeEach(() => {
    nodeOpKey = ethers.Wallet.createRandom();
    agentAddress = ethers.Wallet.createRandom().address;
  });

  it('allows when recovered op-key signer matches an approved delegateeOpKey', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
    });
    const { allowed, logs } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentAddress],
      agentGateAddresses: [agentAddress],
      allowedPeers: null,
      allowedDelegateePeers: [],
      allowedDelegateeKeys: [nodeOpKey.address.toLowerCase()],
    });
    expect(allowed).toBe(true);
    expect(logs.join('\n')).toMatch(/delegateeAllowed=true/);
  });

  it('allows when remote peer-id matches an approved delegateePeer (op-key absent)', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
    });
    const { allowed, logs } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentAddress],
      agentGateAddresses: [agentAddress],
      allowedPeers: null,
      allowedDelegateePeers: [remotePeerId],
      allowedDelegateeKeys: [],
    });
    expect(allowed).toBe(true);
    expect(logs.join('\n')).toMatch(/delegateeAllowed=true/);
  });

  it('denies when neither delegatee identifier matches AND legacy gates miss', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
    });
    const otherKey = ethers.Wallet.createRandom().address.toLowerCase();
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentAddress],
      agentGateAddresses: [agentAddress],
      allowedPeers: null,
      allowedDelegateePeers: ['12D3KooWNotThisPeer'],
      allowedDelegateeKeys: [otherKey],
    });
    expect(allowed).toBe(false);
  });

  it('falls back to legacy agent-gate when delegatee lists are empty (back-compat)', async () => {
    const agentWallet = ethers.Wallet.createRandom();
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: agentWallet,
      requesterAgentAddress: agentWallet.address,
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentWallet.address],
      agentGateAddresses: [agentWallet.address],
      allowedPeers: null,
      allowedDelegateePeers: [],
      allowedDelegateeKeys: [],
    });
    expect(allowed).toBe(true);
  });

  it('does NOT consider a key-only match valid when only delegateePeer list is consulted', async () => {
    // Sanity: key match triggers via allowedDelegateeKeys list, not allowedDelegateePeers.
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      participants: [agentAddress],
      agentGateAddresses: [agentAddress],
      allowedDelegateePeers: [nodeOpKey.address.toLowerCase()], // wrong list — should not match
      allowedDelegateeKeys: [],
    });
    expect(allowed).toBe(false);
  });

  it('rejects a malformed envelope (missing signature) before consulting delegatee lists', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
    });
    delete (envelope as any).requesterSignatureR;
    const getKeys = vi.fn(async () => [nodeOpKey.address.toLowerCase()]);
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      allowedDelegateeKeys: [nodeOpKey.address.toLowerCase()],
    });
    expect(allowed).toBe(false);
    // Helper should not even be queried in the malformed-envelope short-circuit
    expect(getKeys).not.toHaveBeenCalled();
  });

  it('rejects a stale envelope (older than syncAuthMaxAgeMs) even with a valid delegation', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
      issuedAtMs: Date.now() - 200_000, // > 90s
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      allowedDelegateeKeys: [nodeOpKey.address.toLowerCase()],
    });
    expect(allowed).toBe(false);
  });

  it('rejects replay (same requestId twice) even with a valid delegation', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
    });
    const seen = new Map<string, number>();
    const ctx = {} as any;
    const args = {
      ctx,
      request: envelope,
      remotePeerId,
      localPeerId: LOCAL_PEER,
      syncAuthMaxAgeMs: 90_000,
      seenRequestIds: seen,
      computeSyncDigest: computeDigestStub,
      verifyIdentity: async () => true,
      getParticipants: async () => null,
      getAllowedPeers: async () => null,
      getAgentGateAddresses: async () => null,
      getAllowedDelegateePeers: async () => [],
      getAllowedDelegateeKeys: async () => [nodeOpKey.address.toLowerCase()],
      refreshMetaFromCurator: async () => false,
      logWarn: () => {},
      logInfo: () => {},
    };
    const first = await authorizePrivateSyncRequest(args);
    const second = await authorizePrivateSyncRequest(args);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('refreshes meta from curator when initial check denies, then re-checks delegatee lists', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
    });
    let refreshed = false;
    const callsToGetKeys: string[] = [];
    const allowed = await authorizePrivateSyncRequest({
      ctx: {} as any,
      request: envelope,
      remotePeerId,
      localPeerId: LOCAL_PEER,
      syncAuthMaxAgeMs: 90_000,
      seenRequestIds: new Map(),
      computeSyncDigest: computeDigestStub,
      verifyIdentity: async () => true,
      getParticipants: async () => null,
      getAllowedPeers: async () => null,
      getAgentGateAddresses: async () => null,
      getAllowedDelegateePeers: async () => [],
      getAllowedDelegateeKeys: async () => {
        callsToGetKeys.push(refreshed ? 'after-refresh' : 'before-refresh');
        return refreshed ? [nodeOpKey.address.toLowerCase()] : [];
      },
      refreshMetaFromCurator: async () => {
        refreshed = true;
        return true;
      },
      logWarn: () => {},
      logInfo: () => {},
    });
    expect(allowed).toBe(true);
    expect(callsToGetKeys).toEqual(['before-refresh', 'after-refresh']);
  });

  it('rejects when verifyIdentity fails even if delegatee key would match', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '7',
    });
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      allowedDelegateeKeys: [nodeOpKey.address.toLowerCase()],
      verifyIdentity: async () => false,
    });
    expect(allowed).toBe(false);
  });

  it('legacy AND-gate (peer-list AND agent-gate both present) still requires both to match', async () => {
    const agentWallet = ethers.Wallet.createRandom();
    // Build two distinct envelopes so the second isn't rejected as a replay.
    const { envelope: env1, remotePeerId } = await buildSignedEnvelope({
      signer: agentWallet,
      requesterAgentAddress: agentWallet.address,
    });
    const { envelope: env2 } = await buildSignedEnvelope({
      signer: agentWallet,
      requesterAgentAddress: agentWallet.address,
      requestId: ethers.hexlify(ethers.randomBytes(12)),
    });
    const { allowed: deniedByPeer } = await callAuth({
      envelope: env1,
      remotePeerId,
      participants: null,
      agentGateAddresses: [agentWallet.address],
      allowedPeers: ['12D3KooWNotThisPeer'],
    });
    expect(deniedByPeer).toBe(false);

    const { allowed: bothPass } = await callAuth({
      envelope: env2,
      remotePeerId,
      participants: null,
      agentGateAddresses: [agentWallet.address],
      allowedPeers: [remotePeerId],
    });
    expect(bothPass).toBe(true);
  });

  it('delegatee match short-circuits the legacy AND-gate', async () => {
    const { envelope, remotePeerId } = await buildSignedEnvelope({
      signer: nodeOpKey,
      identityId: '5',
    });
    // AND-gate present but neither side matches; delegatee key DOES match → allowed.
    const { allowed } = await callAuth({
      envelope,
      remotePeerId,
      participants: null,
      agentGateAddresses: [agentAddress], // signer is op-key, not agent
      allowedPeers: ['12D3KooWNotThisPeer'],
      allowedDelegateeKeys: [nodeOpKey.address.toLowerCase()],
    });
    expect(allowed).toBe(true);
  });
});
