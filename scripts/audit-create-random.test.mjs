/**
 * Unit tests for the lexer + hit-finder powering
 * `scripts/audit-create-random.mjs`.
 *
 * Run with:  node --test scripts/audit-create-random.test.mjs
 *
 * The most important case here is the regression test for the
 * string-literal bypass that codex flagged on PR #371: the previous
 * comment-only stripper treated `//` and `/​*` inside string / template
 * literals as real comments, which silently blanked any real
 * `Wallet.createRandom()` call that happened to live on the same line as
 * a string containing those tokens. A security audit that misses real
 * call sites is worse than useless — it provides false assurance.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripCommentsPreservingPositions, findHits } from './audit-create-random.mjs';

describe('stripCommentsPreservingPositions', () => {
  it('blanks // line comments', () => {
    const input = 'let x = 1; // hello\nlet y = 2;';
    const out = stripCommentsPreservingPositions(input);
    assert.equal(out, 'let x = 1;         \nlet y = 2;');
    assert.equal(out.length, input.length);
  });

  it('blanks /* … */ block comments and preserves embedded newlines', () => {
    const input = 'a /* one\ntwo */ b';
    const out = stripCommentsPreservingPositions(input);
    assert.equal(out, 'a       \n       b');
    assert.equal(out.length, input.length);
  });

  it('does NOT enter line-comment mode when // appears inside a "…" string (the PR #371 bypass)', () => {
    const text = 'const url = "http://"; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    // The string contents (incl. the `//`) should be blanked but the
    // `Wallet.createRandom();` after the string MUST remain visible.
    assert.match(out, /Wallet\.createRandom\(\);/);
    assert.equal(out.length, text.length);
  });

  it('does NOT enter line-comment mode when // appears inside a \'…\' string', () => {
    const text = "const url = 'http://'; Wallet.createRandom();";
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
  });

  it('does NOT enter block-comment mode when /* appears inside a string', () => {
    const text = 'const s = "/* not a comment"; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
  });

  it('blanks Wallet.createRandom( inside a string literal (no false positive)', () => {
    const text = 'const s = "Wallet.createRandom(arg)"; const z = 1;';
    const out = stripCommentsPreservingPositions(text);
    assert.doesNotMatch(out, /Wallet\.createRandom\(/);
  });

  it('handles escape sequences inside strings (\\" does not close the string early)', () => {
    const text = 'const s = "she said \\"// hi\\""; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
  });

  it('does NOT enter line-comment mode when // appears inside a `…` template literal', () => {
    const text = 'const t = `http://`; Wallet.createRandom();';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\);/);
  });

  it('scans Wallet.createRandom() inside a ${…} template substitution as code', () => {
    const text = 'const t = `value: ${Wallet.createRandom()}`;';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\)/);
  });

  it('handles brace nesting inside template substitutions', () => {
    const text = 'const t = `${({ a: 1 })} ${Wallet.createRandom()}`;';
    const out = stripCommentsPreservingPositions(text);
    assert.match(out, /Wallet\.createRandom\(\)/);
  });
});

describe('findHits', () => {
  it('finds a basic Wallet.createRandom() call', () => {
    const hits = findHits('const w = Wallet.createRandom();');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 1);
    assert.match(hits[0].snippet, /Wallet\.createRandom\(\)/);
  });

  it('finds split-line invocations like Wallet\\n.createRandom()', () => {
    const hits = findHits('const w = Wallet\n  .createRandom();');
    assert.equal(hits.length, 1);
  });

  it('finds invocations with block comments between tokens', () => {
    const hits = findHits('Wallet/* nope */.createRandom()');
    assert.equal(hits.length, 1);
  });

  it('does NOT report calls inside string literals', () => {
    const hits = findHits('const s = "Wallet.createRandom()";');
    assert.equal(hits.length, 0);
  });

  it('does NOT report calls in line comments', () => {
    const hits = findHits('// Wallet.createRandom()');
    assert.equal(hits.length, 0);
  });

  it('REGRESSION (PR #371): finds calls after a string containing //', () => {
    const text = [
      "const url = 'http://example.com';",
      'const w = Wallet.createRandom();',
    ].join('\n');
    const hits = findHits(text);
    assert.equal(hits.length, 1, `expected 1 hit, got ${hits.length}; out: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].line, 2);
  });

  it('REGRESSION (PR #371): finds calls on the SAME line as a string with // inside it', () => {
    const text = 'const url = "http://"; Wallet.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1, `expected 1 hit, got ${hits.length}; out: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].line, 1);
  });

  it('REGRESSION (PR #371): finds calls after a string containing /*', () => {
    const text = 'const note = "TODO /*";\nWallet.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
  });

  it('returns the original-source line snippet (not the blanked version)', () => {
    const text = 'const url = "http://"; Wallet.createRandom();';
    const hits = findHits(text);
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /const url = "http:\/\/"; Wallet\.createRandom\(\);/);
  });
});
