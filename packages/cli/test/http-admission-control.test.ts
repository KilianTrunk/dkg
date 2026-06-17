import { describe, expect, it } from 'vitest';
import { InFlightLimiter } from '../src/daemon/http-utils.js';

describe('InFlightLimiter — concurrency admission control', () => {
  it('admits up to the cap then sheds, and recovers on release', () => {
    const limiter = new InFlightLimiter(2);
    expect(limiter.max).toBe(2);

    expect(limiter.tryAcquire()).toBe(true); // 1
    expect(limiter.tryAcquire()).toBe(true); // 2
    expect(limiter.inFlight).toBe(2);

    expect(limiter.tryAcquire()).toBe(false); // at capacity -> shed
    expect(limiter.inFlight).toBe(2);

    limiter.release();
    expect(limiter.inFlight).toBe(1);
    expect(limiter.tryAcquire()).toBe(true); // slot freed
    expect(limiter.inFlight).toBe(2);
  });

  it('release() never underflows below zero', () => {
    const limiter = new InFlightLimiter(4);
    limiter.release();
    limiter.release();
    expect(limiter.inFlight).toBe(0);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.inFlight).toBe(1);
  });

  it('treats a non-positive or non-finite cap as disabled (always admits)', () => {
    for (const max of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const limiter = new InFlightLimiter(max);
      expect(limiter.max).toBe(0);
      for (let i = 0; i < 1000; i++) expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.inFlight).toBe(1000);
    }
  });

  it('floors fractional caps', () => {
    const limiter = new InFlightLimiter(2.9);
    expect(limiter.max).toBe(2);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });
});
