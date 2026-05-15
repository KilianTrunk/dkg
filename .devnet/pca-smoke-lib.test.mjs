import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertDiscountTaken,
  assertPublishSignerBound,
  buildVerifyMarkdown,
  classifyAgentRegistration,
} from './pca-smoke-lib.mjs';

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

test('classifyAgentRegistration: unbound agent → register', () => {
  assert.deepEqual(classifyAgentRegistration(0n, 5n), { action: 'register' });
});

test('classifyAgentRegistration: already bound to target → skip (idempotent re-run)', () => {
  // 2nd smoke run hits the same publisher wallet already mapped to our
  // PCA — must skip, not re-POST (which reverts AgentAlreadyRegistered).
  assert.deepEqual(classifyAgentRegistration(5n, 5n), { action: 'skip' });
});

test('classifyAgentRegistration: bound to a different account → conflict', () => {
  const r = classifyAgentRegistration(3n, 5n);
  assert.equal(r.action, 'conflict');
  assert.match(r.reason, /already bound to account 3/);
});

test('classifyAgentRegistration: coerces string/number account ids', () => {
  assert.deepEqual(classifyAgentRegistration('0', '9'), { action: 'register' });
  assert.deepEqual(classifyAgentRegistration('9', 9), { action: 'skip' });
});

test('assertPublishSignerBound: signer is an agent of our account → ok', () => {
  const r = assertPublishSignerBound({
    signer: '0xAbc', signerAccountId: 5n, accountId: 5n,
  });
  assert.equal(r.ok, true);
});

test('assertPublishSignerBound: signer not registered → silent demotion fail', () => {
  // Publisher rotated to a wallet that was never registered as an
  // agent: KnowledgeAssetsV10 silently takes the no-discount branch.
  const r = assertPublishSignerBound({
    signer: '0xAbc', signerAccountId: 0n, accountId: 5n,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a registered agent|demot/i);
});

test('assertPublishSignerBound: signer bound to a different PCA → fail', () => {
  const r = assertPublishSignerBound({
    signer: '0xAbc', signerAccountId: 3n, accountId: 5n,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /3/);
});
