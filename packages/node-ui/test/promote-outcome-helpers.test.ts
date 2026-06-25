import { describe, expect, it } from 'vitest';
import {
  describePromoteResult,
  describePromoteError,
  describeInsufficientPublisherFunds,
  describeBulkVmPublishResult,
  HttpError,
} from '../src/ui/api.js';

const FUNDS_MSG =
  'No operational wallet has enough funds to publish to Verifiable Memory — each publish needs native gas AND TRAC on the same wallet. ' +
  'Operational wallet balances:\n  0xAAA: 0.0 TRAC, 0.0 gas\n  0xBBB: 0.0 TRAC, 0.0 gas\n' +
  'Fund one of these wallets (run `dkg wallets` to list addresses) and retry the publish.';

/**
 * Codex review on #874 / #898 round 2 — pin the contract that the
 * entity-level WM→SWM CTA in
 * `packages/node-ui/src/ui/views/project/components.tsx`
 * (`VerifyOnDkgButton`) depends on.
 *
 * Pre-fix that CTA called `promoteAssertion()` directly and rendered
 * `promotedCount` verbatim, so `promotedCount === 0` showed as a faux
 * "✓ 0 triples now in Shared Memory" success and the
 * `ASSERTION_NOT_PERSISTED` 409 surfaced as a generic backend error.
 * Both paths now run through these helpers; this test keeps the helper
 * contract stable so a future refactor of either helper doesn't
 * silently re-break that CTA.
 */
// Pins the formatting extracted from the entities/layer-widgets publish-all
// loops into the shared describeBulkVmPublishResult (api.ts) — the dedupe must
// not change the partial-success / funds-tail / nothing-published behavior.
describe('describeBulkVmPublishResult', () => {
  it('returns null when nothing was published (caller throws the funds/last error)', () => {
    expect(describeBulkVmPublishResult({ published: 0, total: 3, lastErr: 'boom', fundsErr: null })).toBeNull();
  });

  it('appends an explicit fund-a-wallet tail on a partial funds failure', () => {
    const line = describeBulkVmPublishResult({ published: 2, total: 3, lastErr: 'x', fundsErr: 'No operational wallet has enough funds' });
    expect(line).toContain('Published 2 knowledge assets to Verifiable Memory');
    expect(line).toContain('no operational wallet has enough funds');
  });

  it('appends a generic partial tail on a non-funds failure', () => {
    const line = describeBulkVmPublishResult({ published: 1, total: 2, lastErr: 'boom', fundsErr: null });
    expect(line).toContain('Published 1 knowledge asset to Verifiable Memory');
    expect(line).toContain('some could not be published');
  });

  it('has no tail on full success', () => {
    expect(describeBulkVmPublishResult({ published: 3, total: 3, lastErr: null, fundsErr: null }))
      .toBe('Published 3 knowledge assets to Verifiable Memory');
  });
});

describe('describePromoteResult', () => {
  it('returns kind="success" with a positive triple count message when promotedCount > 0', () => {
    const out = describePromoteResult('character-sheet', { promotedCount: 7 });
    expect(out.kind).toBe('success');
    if (out.kind !== 'success') return;
    expect(out.promotedCount).toBe(7);
    expect(out.message).toContain('Promoted 7 triples');
    expect(out.message).toContain('character-sheet');
  });

  it('returns kind="noop" with a re-import hint when promotedCount === 0', () => {
    const out = describePromoteResult('character-sheet', { promotedCount: 0 });
    expect(out.kind).toBe('noop');
    if (out.kind !== 'noop') return;
    // The CTA now renders `outcome.message` verbatim instead of the
    // misleading "✓ 0 triples now in Shared Memory" toast.
    expect(out.message).toContain('character-sheet');
    expect(out.message.toLowerCase()).toContain('no triples');
  });

  it('uses singular "triple" when promotedCount === 1', () => {
    const out = describePromoteResult('character-sheet', { promotedCount: 1 });
    expect(out.kind).toBe('success');
    if (out.kind !== 'success') return;
    expect(out.message).toContain('Promoted 1 triple ');
    expect(out.message).not.toContain('1 triples');
  });
});

describe('describePromoteError', () => {
  it('returns kind="not-persisted" with a re-import hint when the daemon throws ASSERTION_NOT_PERSISTED (409)', () => {
    const err = new HttpError(409, 'Conflict', {
      code: 'ASSERTION_NOT_PERSISTED',
      expectedTripleCount: 12,
    });
    const out = describePromoteError('character-sheet', err);
    expect(out).not.toBeNull();
    if (!out || out.kind !== 'not-persisted') throw new Error('expected not-persisted outcome');
    expect(out.expectedTripleCount).toBe(12);
    expect(out.message).toContain('character-sheet');
    expect(out.message).toContain('12 extracted triples');
    expect(out.message.toLowerCase()).toContain('re-import');
  });

  it('returns kind="not-persisted" without an expectedTripleCount when the daemon body lacks it', () => {
    const err = new HttpError(409, 'Conflict', { code: 'ASSERTION_NOT_PERSISTED' });
    const out = describePromoteError('character-sheet', err);
    expect(out).not.toBeNull();
    if (!out || out.kind !== 'not-persisted') throw new Error('expected not-persisted outcome');
    expect(out.expectedTripleCount).toBeUndefined();
    expect(out.message).toContain('character-sheet');
    expect(out.message).toContain('extraction metadata');
  });

  it('returns null for non-409 HttpErrors so the CTA falls back to err.message', () => {
    expect(describePromoteError('x', new HttpError(500, 'Internal'))).toBeNull();
    expect(describePromoteError('x', new HttpError(404, 'Not Found'))).toBeNull();
  });

  it('returns null for 409 HttpErrors that are NOT ASSERTION_NOT_PERSISTED', () => {
    const err = new HttpError(409, 'Conflict', { code: 'ASSERTION_PROMOTE_RACE' });
    expect(describePromoteError('x', err)).toBeNull();
  });

  it('returns kind="payload-too-large" with a split hint for oversized SWM gossip payloads', () => {
    const err = new HttpError(413, 'Payload too large', {
      code: 'SWM_GOSSIP_PAYLOAD_TOO_LARGE',
      actualBytes: 12 * 1024 * 1024,
      limitBytes: 10 * 1024 * 1024,
      hint: 'Promote fewer entities per call.',
    });
    const out = describePromoteError('skills-catalog-0001', err);
    expect(out).not.toBeNull();
    if (!out || out.kind !== 'payload-too-large') throw new Error('expected payload-too-large outcome');
    expect(out.actualBytes).toBe(12 * 1024 * 1024);
    expect(out.limitBytes).toBe(10 * 1024 * 1024);
    expect(out.message).toContain('skills-catalog-0001');
    expect(out.message.toLowerCase()).toContain('too large');
    expect(out.message.toLowerCase()).toContain('fewer entities');
  });

  it('returns null for non-HttpError throwables (network errors, generic Error)', () => {
    expect(describePromoteError('x', new Error('network'))).toBeNull();
    expect(describePromoteError('x', 'string error' as unknown)).toBeNull();
  });

  it('stays promote-focused: returns null for publish NO_FUNDED_PUBLISHER_WALLET errors (handled by describeInsufficientPublisherFunds)', () => {
    expect(describePromoteError('skills-catalog', new HttpError(400, FUNDS_MSG, { code: 'NO_FUNDED_PUBLISHER_WALLET', error: FUNDS_MSG }))).toBeNull();
    expect(describePromoteError('skills-catalog', new Error(FUNDS_MSG))).toBeNull();
  });
});

describe('describeInsufficientPublisherFunds', () => {
  it('extracts the message from a 400 with the structured funds code', () => {
    const err = new HttpError(400, FUNDS_MSG, { code: 'NO_FUNDED_PUBLISHER_WALLET', error: FUNDS_MSG });
    expect(describeInsufficientPublisherFunds(err)).toContain('No operational wallet has enough funds');
  });

  it('matches the message marker when the code is absent', () => {
    const err = new HttpError(500, FUNDS_MSG, { error: FUNDS_MSG });
    expect(describeInsufficientPublisherFunds(err)).toBe(FUNDS_MSG);
  });

  it('matches a plain Error / string carrying the marker', () => {
    expect(describeInsufficientPublisherFunds(new Error(FUNDS_MSG))).toBe(FUNDS_MSG);
    expect(describeInsufficientPublisherFunds(FUNDS_MSG)).toBe(FUNDS_MSG);
  });

  it('returns null for unrelated errors', () => {
    expect(describeInsufficientPublisherFunds(new Error('insufficient funds for gas'))).toBeNull();
    expect(describeInsufficientPublisherFunds(new HttpError(500, 'Internal'))).toBeNull();
    expect(describeInsufficientPublisherFunds(undefined)).toBeNull();
  });
});
