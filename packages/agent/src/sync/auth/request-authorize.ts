import { ethers } from 'ethers';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { SyncRequestEnvelope } from './request-build.js';

interface AuthorizeSyncRequestParams {
  ctx: OperationContext;
  request: SyncRequestEnvelope;
  remotePeerId: string;
  localPeerId: string;
  syncAuthMaxAgeMs: number;
  seenRequestIds: Map<string, number>;
  computeSyncDigest: (
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    targetPeerId: string,
    requesterPeerId: string,
    requestId: string,
    issuedAtMs: number,
  ) => Uint8Array;
  verifyIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
  getParticipants: (contextGraphId: string) => Promise<string[] | null>;
  getAllowedPeers: (contextGraphId: string) => Promise<string[] | null>;
  getAgentGateAddresses: (contextGraphId: string) => Promise<string[] | null>;
  /**
   * Libp2p peer-ids that an approved agent has delegated to act on its
   * behalf for sync. Hit on either of these (peer-id transport carrier
   * OR operational signer) is sufficient to authorise — the delegation
   * was already verified at approval time.
   */
  getAllowedDelegateePeers: (contextGraphId: string) => Promise<string[]>;
  getAllowedDelegateeKeys: (contextGraphId: string) => Promise<string[]>;
  refreshMetaFromCurator: (contextGraphId: string) => Promise<boolean>;
  logWarn: (ctx: OperationContext, message: string) => void;
  logInfo: (ctx: OperationContext, message: string) => void;
}

export async function authorizePrivateSyncRequest(params: AuthorizeSyncRequestParams): Promise<boolean> {
  const {
    ctx,
    request,
    remotePeerId,
    localPeerId,
    syncAuthMaxAgeMs,
    seenRequestIds,
    computeSyncDigest,
    verifyIdentity,
    getParticipants,
    getAllowedPeers,
    getAgentGateAddresses,
    getAllowedDelegateePeers,
    getAllowedDelegateeKeys,
    refreshMetaFromCurator,
    logWarn,
    logInfo,
  } = params;

  const now = Date.now();
  for (const [requestId, seenAt] of seenRequestIds) {
    if (now - seenAt > syncAuthMaxAgeMs) {
      seenRequestIds.delete(requestId);
    }
  }

  let requesterIdentityId = 0n;
  try { requesterIdentityId = request.requesterIdentityId ? BigInt(request.requesterIdentityId) : 0n; } catch {}

  if (
    request.targetPeerId !== localPeerId ||
    request.requesterPeerId !== remotePeerId ||
    !request.requestId ||
    request.issuedAtMs == null ||
    now - request.issuedAtMs > syncAuthMaxAgeMs ||
    now < request.issuedAtMs - 5000 ||
    !request.requesterSignatureR ||
    !request.requesterSignatureVS
  ) {
    logWarn(
      ctx,
      `Denied sync request for "${request.contextGraphId}": malformed or mismatched envelope (requesterPeer=${request.requesterPeerId ?? 'n/a'} targetPeer=${request.targetPeerId ?? 'n/a'} remotePeer=${remotePeerId} identityId=${request.requesterIdentityId ?? '0'} agentAddress=${request.requesterAgentAddress ?? 'n/a'})`,
    );
    return false;
  }

  if (seenRequestIds.has(request.requestId)) {
    logWarn(ctx, `Denied sync request for "${request.contextGraphId}": replay detected for request ${request.requestId}`);
    return false;
  }

  const digest = computeSyncDigest(
    request.contextGraphId,
    request.offset,
    request.limit,
    request.includeSharedMemory,
    request.targetPeerId,
    request.requesterPeerId,
    request.requestId,
    request.issuedAtMs,
  );

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.recoverAddress(ethers.hashMessage(digest), {
      r: request.requesterSignatureR,
      yParityAndS: request.requesterSignatureVS,
    });
  } catch {
    logWarn(ctx, `Denied sync request for "${request.contextGraphId}": failed to recover signer (identityId=${request.requesterIdentityId ?? '0'} agentAddress=${request.requesterAgentAddress ?? 'n/a'})`);
    return false;
  }

  if (requesterIdentityId > 0n) {
    if (typeof verifyIdentity !== 'function') {
      logWarn(ctx, `Denied sync request for "${request.contextGraphId}": identity verification unavailable (identityId=${requesterIdentityId.toString()} signer=${recoveredAddress})`);
      return false;
    }
    const validIdentity = await verifyIdentity(recoveredAddress, requesterIdentityId);
    if (!validIdentity) {
      logWarn(ctx, `Denied sync request for "${request.contextGraphId}": signer ${recoveredAddress} does not verify for identityId=${requesterIdentityId.toString()}`);
      return false;
    }
  } else if (!request.requesterAgentAddress || recoveredAddress.toLowerCase() !== request.requesterAgentAddress.toLowerCase()) {
    logWarn(ctx, `Denied sync request for "${request.contextGraphId}": edge signer mismatch (signer=${recoveredAddress} requesterAgentAddress=${request.requesterAgentAddress ?? 'n/a'})`);
    return false;
  }

  let participants = await getParticipants(request.contextGraphId);
  let agentGateAddresses = await getAgentGateAddresses(request.contextGraphId);
  let allowedPeers = await getAllowedPeers(request.contextGraphId);
  let allowedDelegateePeers = await getAllowedDelegateePeers(request.contextGraphId);
  let allowedDelegateeKeys = await getAllowedDelegateeKeys(request.contextGraphId);
  const isParticipantAllowed = () => participants?.some((p) =>
    p.toLowerCase() === recoveredAddress.toLowerCase() ||
    (requesterIdentityId > 0n && p === String(requesterIdentityId)),
  ) ?? false;
  const isAgentGateAllowed = () => agentGateAddresses?.some((agent) =>
    agent.toLowerCase() === recoveredAddress.toLowerCase(),
  ) ?? false;
  const isPeerAllowed = () => allowedPeers?.includes(remotePeerId) ?? false;
  // Agent-signed delegation: the joiner agent authorised this node
  // (peer-id and/or operational key) at approval time. A hit on either
  // side suffices — the agent's signature is the source of truth, the
  // node identifiers are just a convenient way to recognise carrier.
  const isDelegateePeerAllowed = () => allowedDelegateePeers.includes(remotePeerId);
  const isDelegateeKeyAllowed = () => allowedDelegateeKeys.includes(recoveredAddress.toLowerCase());
  const isDelegateeAllowed = () => isDelegateePeerAllowed() || isDelegateeKeyAllowed();
  const resolveAllowed = () => {
    if (isDelegateeAllowed()) return true;
    if (agentGateAddresses !== null && allowedPeers !== null) {
      return isPeerAllowed() && isAgentGateAllowed();
    }
    return isParticipantAllowed() || isPeerAllowed();
  };

  let allowed = resolveAllowed();

  if (!allowed) {
    const refreshed = await refreshMetaFromCurator(request.contextGraphId);
    if (refreshed) {
      participants = await getParticipants(request.contextGraphId);
      agentGateAddresses = await getAgentGateAddresses(request.contextGraphId);
      allowedPeers = await getAllowedPeers(request.contextGraphId);
      allowedDelegateePeers = await getAllowedDelegateePeers(request.contextGraphId);
      allowedDelegateeKeys = await getAllowedDelegateeKeys(request.contextGraphId);
      allowed = resolveAllowed();
    }
  }

  logInfo(
    ctx,
    `Private sync auth for "${request.contextGraphId}": identityId=${requesterIdentityId.toString()} signer=${recoveredAddress} requesterAgentAddress=${request.requesterAgentAddress ?? 'n/a'} participantCount=${participants?.length ?? 0} agentGateCount=${agentGateAddresses?.length ?? 0} delegateePeerCount=${allowedDelegateePeers.length} delegateeKeyCount=${allowedDelegateeKeys.length} peerAllowed=${isPeerAllowed()} delegateeAllowed=${isDelegateeAllowed()} allowed=${allowed}`,
  );

  if (allowed) {
    seenRequestIds.set(request.requestId, now);
  }
  return allowed;
}
