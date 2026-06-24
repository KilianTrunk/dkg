/**
 * KA-number-floor reconcile resilience (follow-up to the "KA create 500-on-429"
 * fix) — the HTTP mapping half. `respondIfReconcileUnavailable` is the shared
 * helper every reconcile-triggering route uses (named create, one-shot publish,
 * shared-memory publish, and the WM-verb routes via respondAssertionError) so a
 * transient KA-number-floor reconcile failure surfaces as a retryable 503 rather
 * than a blanket 500. The retry half is pinned in packages/agent allocator.test;
 * this pins the status-code mapping. Verified end-to-end on a real Gnosis
 * mainnet node behind a 429-injecting RPC proxy (POST /api/knowledge-assets ->
 * 503, code KA_FLOOR_RECONCILE_UNAVAILABLE, retryable:true).
 */
import { describe, it, expect } from 'vitest';
import { respondIfReconcileUnavailable } from '../src/daemon/http-utils.js';

function fakeRes() {
  const rec: { status: number; body: string; ended: boolean } = { status: 0, body: '', ended: false };
  const res = {
    writeHead(status: number) {
      rec.status = status;
      return res;
    },
    end(body?: string) {
      if (typeof body === 'string') rec.body = body;
      rec.ended = true;
    },
  } as any;
  return { rec, res };
}

describe('respondIfReconcileUnavailable — reconcile failure -> retryable 503', () => {
  it('maps a typed KaFloorReconcileError (by code) to a retryable 503', () => {
    const { rec, res } = fakeRes();
    const handled = respondIfReconcileUnavailable(res, {
      code: 'KA_FLOOR_RECONCILE_UNAVAILABLE',
      message: 'OT-RFC-43 A2: failed to reconcile KA-number floor for author 0xabc: 429',
      retryable: true,
    });
    expect(handled).toBe(true);
    expect(rec.status).toBe(503);
    const body = JSON.parse(rec.body);
    expect(body.code).toBe('KA_FLOOR_RECONCILE_UNAVAILABLE');
    expect(body.retryable).toBe(true);
  });

  it('maps the legacy message (no code, e.g. the "…at finalize" direct-call wrap) to 503', () => {
    const { rec, res } = fakeRes();
    const handled = respondIfReconcileUnavailable(
      res,
      new Error('OT-RFC-43 A2: failed to reconcile KA-number floor for author 0xabc at finalize: server response 429'),
    );
    expect(handled).toBe(true);
    expect(rec.status).toBe(503);
    expect(JSON.parse(rec.body).code).toBe('KA_FLOOR_RECONCILE_UNAVAILABLE');
  });

  it('defaults retryable to true when the flag is absent', () => {
    const { rec, res } = fakeRes();
    respondIfReconcileUnavailable(res, new Error('failed to reconcile KA-number floor for author 0xabc: 503'));
    expect(JSON.parse(rec.body).retryable).toBe(true);
  });

  it('does NOT respond (returns false) for unrelated errors — caller keeps its own mapping', () => {
    const { rec, res } = fakeRes();
    const handled = respondIfReconcileUnavailable(res, new Error('execution reverted: TooLowBalance'));
    expect(handled).toBe(false);
    expect(rec.ended).toBe(false);
    expect(rec.status).toBe(0);
  });
});
