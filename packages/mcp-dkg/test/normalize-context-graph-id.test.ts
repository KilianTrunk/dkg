/**
 * `normalizeContextGraphId` must be IDEMPOTENT so a consumer that re-normalizes
 * (the wire scope AND a downstream provenance anchor in dkg_get_entity_sources)
 * converges on the same id even for malformed input. The trailing-slash trim is
 * a linear index walk, not `/\/+$/` — that regex is a polynomial-ReDoS on a
 * string of many '/' (CodeQL js/polynomial-redos), and the id is caller input.
 */
import { describe, it, expect } from 'vitest';
import { normalizeContextGraphId } from '../src/client.js';

describe('normalizeContextGraphId', () => {
  it.each([
    ['test-cg', 'test-cg'],
    ['did:dkg:context-graph:test-cg', 'test-cg'],
    ['  did:dkg:context-graph:test-cg  ', 'test-cg'],
    ['test-cg/', 'test-cg'],
    ['test-cg///', 'test-cg'],
    ['did:dkg:context-graph:test-cg/', 'test-cg'],
    // double-prefixed (the round-2 regression class) collapses fully
    ['did:dkg:context-graph:did:dkg:context-graph:foo', 'foo'],
    // sub-graph-bearing ids keep their internal slashes, lose only trailing
    ['0xowner/proj', '0xowner/proj'],
    ['0xowner/proj/', '0xowner/proj'],
  ])('normalizes %j -> %j', (input, expected) => {
    expect(normalizeContextGraphId(input)).toBe(expected);
    // Idempotent: normalizing the result again is a no-op.
    expect(normalizeContextGraphId(normalizeContextGraphId(input))).toBe(expected);
  });

  it('is linear on a long run of trailing slashes (no ReDoS blowup)', () => {
    const input = 'cg' + '/'.repeat(100_000) + '';
    const t0 = Date.now();
    expect(normalizeContextGraphId(input)).toBe('cg');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
