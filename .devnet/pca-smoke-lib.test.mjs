import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertDiscountTaken, buildVerifyMarkdown } from './pca-smoke-lib.mjs';

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

test('buildVerifyMarkdown: renders heading, every step, and PASS verdict', () => {
  const md = buildVerifyMarkdown({
    accountId: '7',
    steps: [
      { name: 'POST /api/pca', status: 200, detail: 'accountId=7' },
      { name: 'POST /api/pca/:id/agent', status: 200, detail: 'agent=0xabc' },
      { name: 'publish KC as agent', status: 'ok', detail: 'kcId=42' },
      { name: 'on-chain discount', status: 'ok', detail: '500 < 1000 TRAC' },
      { name: 'GET /api/pca/:id', status: 200, detail: 'agentCount=1' },
    ],
    passed: true,
  });
  assert.match(md, /# Issue #519 — V10 PCA HTTP round-trip/);
  assert.match(md, /accountId.*7/);
  assert.match(md, /POST \/api\/pca\/:id\/agent/);
  assert.match(md, /publish KC as agent/);
  assert.match(md, /on-chain discount/);
  assert.match(md, /GET \/api\/pca\/:id/);
  assert.match(md, /\bPASS\b/);
});

test('buildVerifyMarkdown: a failing step yields a FAIL verdict', () => {
  const md = buildVerifyMarkdown({
    accountId: 'n/a',
    steps: [{ name: 'POST /api/pca', status: 503, detail: 'no-chain' }],
    passed: false,
  });
  assert.match(md, /\bFAIL\b/);
});
