import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertDiscountTaken } from './pca-smoke-lib.mjs';

test('assertDiscountTaken: discounted < base and > 0 passes', () => {
  const r = assertDiscountTaken({ baseCost: 1000n, discountedCost: 500n });
  assert.equal(r.ok, true);
});

test('assertDiscountTaken: discounted == base is a silent demotion (fail)', () => {
  const r = assertDiscountTaken({ baseCost: 1000n, discountedCost: 1000n });
  assert.equal(r.ok, false);
  assert.match(r.reason, /demot|no discount/i);
});

test('assertDiscountTaken: zero discounted cost fails', () => {
  const r = assertDiscountTaken({ baseCost: 1000n, discountedCost: 0n });
  assert.equal(r.ok, false);
});
