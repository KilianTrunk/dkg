/**
 * PR #716 audit cluster **C** — agent-side wiring of the structured ACK
 * identity verifier introduced in PR #711.
 *
 * The agent's job is to translate the chain adapter's verifier shape into
 * the `ACKCollector` deps shape (`DKGAgent.createV10ACKProvider`). Two
 * non-trivial pieces:
 *   1. `verifyIdentityDetailed` — wired only when the chain adapter
 *      implements `verifyACKIdentityDetailed`. The closure wraps the
 *      adapter call in a try/catch and translates a thrown error into
 *      `{ valid: false, reason: 'rpc-error' }`. Without this, a flaky /
 *      rate-limited / filter-expired RPC surfaces in the ACK log as a
 *      definitive key-not-registered rejection — the exact diagnostic
 *      dead-end PR #711 was opened to fix.
 *   2. `verifyIdentity` (legacy boolean) — fallback for adapters that
 *      don't (yet) implement the structured method; also try/catches and
 *      swallows to `false` to preserve the pre-PR-#711 contract.
 *
 * NO MOCKS. The two closures were extracted verbatim into the real
 * exported helpers `buildAckVerifyIdentity` / `buildAckVerifyIdentityDetailed`
 * (src/v10-ack-verifier.js), which `createV10ACKProvider` now calls. So this
 * file unit-tests the REAL translation logic directly against real chain
 * shapes — no module-level mock of `ACKCollector`, no constructor-argument
 * capture, no agent boot. (The collector-side consumption is covered by
 * packages/publisher/test/v10-ack-edge-cases.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import type { VerifyACKIdentityResult } from '@origintrail-official/dkg-chain';
import {
  buildAckVerifyIdentity,
  buildAckVerifyIdentityDetailed,
} from '../src/v10-ack-verifier.js';

const ADDR = '0xabCDeF0123456789abcDef0123456789AbCdef01';

describe('V10 ACK identity verifier closures (PR #711 agent-side wiring)', () => {
  it('verifyIdentityDetailed translates a thrown chain error to { valid: false, reason: "rpc-error" }', async () => {
    const fn = buildAckVerifyIdentityDetailed({
      verifyACKIdentityDetailed: async (): Promise<VerifyACKIdentityResult> => {
        throw new Error('synthetic RPC outage — filter expired');
      },
    });
    expect(fn).toBeTypeOf('function');
    expect(await fn!(ADDR, 42n)).toEqual({ valid: false, reason: 'rpc-error' });
  });

  it('verifyIdentityDetailed forwards a definitive { valid: false, reason: "key-not-registered" } verdict UNCHANGED', async () => {
    const fn = buildAckVerifyIdentityDetailed({
      verifyACKIdentityDetailed: async (): Promise<VerifyACKIdentityResult> => ({
        valid: false,
        reason: 'key-not-registered',
      }),
    });
    expect(await fn!(ADDR, 42n)).toEqual({ valid: false, reason: 'key-not-registered' });
  });

  it('verifyIdentityDetailed is undefined when the chain lacks the structured method', () => {
    expect(buildAckVerifyIdentityDetailed({})).toBeUndefined();
  });

  it('verifyIdentity (legacy boolean) swallows a thrown chain error to false', async () => {
    const fn = buildAckVerifyIdentity({
      verifyACKIdentity: async (): Promise<boolean> => {
        throw new Error('synthetic RPC outage on legacy path');
      },
    });
    expect(fn).toBeTypeOf('function');
    expect(await fn!(ADDR, 42n)).toBe(false);
  });

  it('verifyIdentity forwards a definitive boolean verdict UNCHANGED', async () => {
    const yes = buildAckVerifyIdentity({ verifyACKIdentity: async () => true });
    const no = buildAckVerifyIdentity({ verifyACKIdentity: async () => false });
    expect(await yes!(ADDR, 42n)).toBe(true);
    expect(await no!(ADDR, 42n)).toBe(false);
  });

  it('verifyIdentity is undefined when the chain lacks the boolean method', () => {
    expect(buildAckVerifyIdentity({})).toBeUndefined();
  });
});
