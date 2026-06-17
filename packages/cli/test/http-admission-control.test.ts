import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { InFlightLimiter, admitRequest, resolveIntSetting } from '../src/daemon/http-utils.js';

/** Minimal ServerResponse stand-in capturing writeHead/end for assertions. */
function mockRes() {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers?: Record<string, string>) {
      r.statusCode = code;
      if (headers) Object.assign(r.headers, headers);
      return r;
    },
    end(chunk?: string) {
      if (chunk) r.body += chunk;
      return r;
    },
  };
  return r as unknown as ServerResponse & { statusCode: number; headers: Record<string, string>; body: string };
}

describe('InFlightLimiter — concurrency admission control', () => {
  it('admits up to the cap then sheds, and recovers on release', () => {
    const limiter = new InFlightLimiter(2);
    expect(limiter.max).toBe(2);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.inFlight).toBe(2);
    expect(limiter.tryAcquire()).toBe(false); // at capacity -> shed
    limiter.release();
    expect(limiter.inFlight).toBe(1);
    expect(limiter.tryAcquire()).toBe(true); // slot freed
  });

  it('release() never underflows below zero', () => {
    const limiter = new InFlightLimiter(4);
    limiter.release();
    limiter.release();
    expect(limiter.inFlight).toBe(0);
  });

  it('treats a non-positive or non-finite cap as disabled (always admits)', () => {
    for (const max of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const limiter = new InFlightLimiter(max);
      expect(limiter.max).toBe(0);
      for (let i = 0; i < 1000; i++) expect(limiter.tryAcquire()).toBe(true);
    }
  });
});

describe('resolveIntSetting — env/config/fallback parsing', () => {
  it('prefers a valid env value, then config, then fallback', () => {
    expect(resolveIntSetting('128', 200, 64)).toBe(128);
    expect(resolveIntSetting(undefined, 200, 64)).toBe(200);
    expect(resolveIntSetting(undefined, undefined, 64)).toBe(64);
  });

  it('falls back (not NaN/0) on malformed or empty env — the reported bug', () => {
    expect(resolveIntSetting('abc', undefined, 64)).toBe(64); // typo
    expect(resolveIntSetting('', undefined, 64)).toBe(64); // empty string
    expect(resolveIntSetting('  ', undefined, 64)).toBe(64); // whitespace
    expect(resolveIntSetting('64x', undefined, 64)).toBe(64); // trailing junk
    expect(resolveIntSetting('abc', 200, 64)).toBe(200); // invalid env -> config
  });

  it('honors allowZero only when set, and rejects negatives/fractions', () => {
    expect(resolveIntSetting('0', undefined, 64)).toBe(64); // 0 rejected (min 1)
    expect(resolveIntSetting('0', undefined, 64, { allowZero: true })).toBe(0); // explicit disable
    expect(resolveIntSetting('-5', undefined, 64, { allowZero: true })).toBe(64); // negative -> default
    expect(resolveIntSetting(undefined, 2.5, 64)).toBe(64); // fractional config ignored
  });
});

describe('admitRequest — wiring (503/Retry-After/CORS/exempt/release)', () => {
  it('admits, consumes a slot, and the disposer frees exactly that slot (idempotent)', () => {
    const limiter = new InFlightLimiter(1);
    const g1 = admitRequest(limiter, 'GET', '/api/context-graphs', mockRes(), null);
    expect(g1.admitted).toBe(true);
    expect(limiter.inFlight).toBe(1);
    g1.release();
    expect(limiter.inFlight).toBe(0);
    g1.release(); // idempotent — does not double-free
    expect(limiter.inFlight).toBe(0);
  });

  it('sheds an over-capacity request with 503 + Retry-After and preserves CORS', () => {
    const limiter = new InFlightLimiter(1);
    const g1 = admitRequest(limiter, 'GET', '/api/context-graphs', mockRes(), null);
    expect(g1.admitted).toBe(true);

    const res = mockRes();
    const g2 = admitRequest(limiter, 'GET', '/api/context-graphs', res, 'https://app.example');
    expect(g2.admitted).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(res.body).toContain('busy');

    // A rejected request's disposer must not touch the slot held by g1.
    g2.release();
    expect(limiter.inFlight).toBe(1);

    g1.release();
    const g3 = admitRequest(limiter, 'GET', '/api/context-graphs', mockRes(), null);
    expect(g3.admitted).toBe(true); // recovered
  });

  it('exempts OPTIONS preflight and cheap health paths even at capacity', () => {
    const limiter = new InFlightLimiter(1);
    expect(limiter.tryAcquire()).toBe(true); // saturate

    for (const [method, path] of [
      ['OPTIONS', '/api/context-graphs'],
      ['GET', '/api/status'],
      ['GET', '/api/chain/rpc-health'],
    ] as const) {
      const res = mockRes();
      const gate = admitRequest(limiter, method, path, res, null);
      expect(gate.admitted).toBe(true); // never shed
      expect(res.statusCode).toBe(0); // nothing written
      gate.release(); // no-op for exempt requests
    }
    expect(limiter.inFlight).toBe(1); // untouched by exempt traffic
  });
});
