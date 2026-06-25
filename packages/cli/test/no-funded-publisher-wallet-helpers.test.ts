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
  respondWithDaemonError,
} from '../src/daemon/routes/shared-assertion-helpers.js';

const FUNDS_MESSAGE =
  'No operational wallet has enough funds to publish to Verifiable Memory — fund a wallet and retry.';

/** Minimal ServerResponse stand-in capturing what jsonResponse writes
 *  (writeHead(status, headers) + end(body)). */
function mockRes(): any {
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {} as Record<string, string>,
    body: undefined as string | undefined,
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
      this.headersSent = true;
      return this;
    },
    setHeader(k: string, v: string) { this.headers[k] = v; },
    end(s?: string) { this.body = s; this.writableEnded = true; },
  };
}

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

// This is the lifecycle/top-level handler contract that rethrowing routes such
// as /api/shared-memory/publish depend on — exercised here directly so a
// regression that drops the funds branch or changes the status/code fails.
describe('respondWithDaemonError', () => {
  it('maps NO_FUNDED_PUBLISHER_WALLET (code) to HTTP 400 { code, error }', () => {
    const res = mockRes();
    respondWithDaemonError(res, Object.assign(new Error(FUNDS_MESSAGE), { code: 'NO_FUNDED_PUBLISHER_WALLET' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ code: 'NO_FUNDED_PUBLISHER_WALLET', error: FUNDS_MESSAGE });
  });

  it('maps the funds error by message marker (code dropped by a re-wrap) to 400 { code }', () => {
    const res = mockRes();
    respondWithDaemonError(res, new Error(FUNDS_MESSAGE));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('NO_FUNDED_PUBLISHER_WALLET');
  });

  it('maps an unrelated error to 500 (not masked as a funds error)', () => {
    const res = mockRes();
    respondWithDaemonError(res, new Error('database connection lost'));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).code).toBeUndefined();
  });

  it('is a no-op once the response has already been sent', () => {
    const res = mockRes();
    res.writableEnded = true;
    respondWithDaemonError(res, new Error(FUNDS_MESSAGE));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });
});
