/**
 * Wire-contract coverage for the shared NO_FUNDED_PUBLISHER_WALLET classifier +
 * response body. Both publish error surfaces consume these helpers — the
 * `/vm/publish` route catch (knowledge-assets.ts) and the top-level daemon
 * handler (lifecycle.ts), which is the path `/api/shared-memory/publish` and any
 * other rethrowing route hit. Centralizing + pinning this here means a
 * regression that drops a branch, changes the status code, or omits the
 * structured `code` for either route shows up as a failing unit test rather
 * than only on a live publish.
 */

import { describe, expect, it } from 'vitest';
import {
  isNoFundedPublisherWalletLike,
  noFundedPublisherWalletBody,
} from '../src/daemon/routes/shared-assertion-helpers.js';

const FUNDS_MESSAGE =
  'No operational wallet has enough funds to publish to Verifiable Memory — fund a wallet and retry.';

describe('isNoFundedPublisherWalletLike', () => {
  it('matches the structured code (code-first)', () => {
    expect(isNoFundedPublisherWalletLike(Object.assign(new Error('whatever'), { code: 'NO_FUNDED_PUBLISHER_WALLET' }))).toBe(true);
  });

  it('matches the message marker when .code is dropped by a re-wrap', () => {
    expect(isNoFundedPublisherWalletLike(new Error(FUNDS_MESSAGE))).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isNoFundedPublisherWalletLike(new Error('insufficient funds for gas'))).toBe(false);
    expect(isNoFundedPublisherWalletLike(Object.assign(new Error('x'), { code: 'CALL_EXCEPTION' }))).toBe(false);
    expect(isNoFundedPublisherWalletLike(undefined)).toBe(false);
    expect(isNoFundedPublisherWalletLike(null)).toBe(false);
  });
});

describe('noFundedPublisherWalletBody', () => {
  it('returns the structured { code, error } the UI keys on', () => {
    expect(noFundedPublisherWalletBody(FUNDS_MESSAGE)).toEqual({
      code: 'NO_FUNDED_PUBLISHER_WALLET',
      error: FUNDS_MESSAGE,
    });
  });
});
