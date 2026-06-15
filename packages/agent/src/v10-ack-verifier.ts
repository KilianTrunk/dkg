import type { VerifyACKIdentityResult } from '@origintrail-official/dkg-chain';

/**
 * Agent-side translation of the chain adapter's ACK identity verifiers
 * into the `ACKCollector` deps shape (PR #711, audit cluster C).
 *
 * Extracted from `DKGAgent.createV10ACKProvider` so the translation
 * contract can be unit-tested directly against real chain shapes — no
 * mock of `ACKCollector` and no constructor-argument capture. The two
 * closures below are byte-for-byte the same logic the agent wires; the
 * agent calls these builders instead of inlining them.
 */

/** The narrow chain surface the ACK identity verifiers consult. */
export interface AckVerifierChain {
  verifyACKIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
  verifyACKIdentityDetailed?: (
    recoveredAddress: string,
    claimedIdentityId: bigint,
  ) => Promise<VerifyACKIdentityResult>;
}

/**
 * Legacy boolean ACK identity verifier closure. Wired only when the
 * chain adapter implements `verifyACKIdentity`; the wrapper swallows a
 * thrown chain-side exception to `false` to preserve the pre-PR-#711
 * contract (where a flaky RPC and a definitive rejection both read as
 * `false`).
 */
export function buildAckVerifyIdentity(
  chain: AckVerifierChain,
): ((recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>) | undefined {
  if (typeof chain.verifyACKIdentity !== 'function') return undefined;
  return async (recoveredAddress: string, claimedIdentityId: bigint) => {
    try {
      return await chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId);
    } catch {
      return false;
    }
  };
}

/**
 * Structured ACK identity verifier closure (PR #711). Wired only when
 * the chain adapter implements `verifyACKIdentityDetailed`; translates a
 * thrown chain-side exception into an explicit
 * `{ valid: false, reason: 'rpc-error' }` verdict so the collector logs
 * infra failures distinctly from definitive key/stake rejections.
 * Definitive verdicts pass through unchanged.
 */
export function buildAckVerifyIdentityDetailed(
  chain: AckVerifierChain,
): ((recoveredAddress: string, claimedIdentityId: bigint) => Promise<VerifyACKIdentityResult>) | undefined {
  if (typeof chain.verifyACKIdentityDetailed !== 'function') return undefined;
  return async (recoveredAddress: string, claimedIdentityId: bigint) => {
    try {
      return await chain.verifyACKIdentityDetailed!(recoveredAddress, claimedIdentityId);
    } catch {
      return { valid: false, reason: 'rpc-error' as const };
    }
  };
}
