import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHits } from './audit-dial-protocol.mjs';

test('finds bare libp2p.dialProtocol(', () => {
  const hits = findHits('await this.node.libp2p.dialProtocol(pid, "/p/1");');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('ignores dialProtocol inside a // comment', () => {
  const hits = findHits('// libp2p.dialProtocol(pid, "/p/1");');
  assert.equal(hits.length, 0);
});

test('ignores dialProtocol inside a /* block */ comment', () => {
  const hits = findHits('/* await libp2p.dialProtocol(pid, "/p/1"); */');
  assert.equal(hits.length, 0);
});

test('ignores dialProtocol inside a string literal', () => {
  const hits = findHits('const note = "use libp2p.dialProtocol(pid)";');
  assert.equal(hits.length, 0);
});

test('catches split invocation across newlines', () => {
  const text = 'await this.node\n  .libp2p\n  .dialProtocol(pid, "/p/1");';
  const hits = findHits(text);
  assert.equal(hits.length, 1);
  // Reported on the line where the actual `.dialProtocol(` token appears.
  assert.equal(hits[0].line, 3);
});

test('catches multiple distinct call sites', () => {
  const text = `
    await libp2p.dialProtocol(a, "/p/1");
    await libp2p.dialProtocol(b, "/p/2");
  `;
  const hits = findHits(text);
  assert.equal(hits.length, 2);
});

test('does not match unrelated method names', () => {
  const text = `
    await libp2p.dial(pid);
    await libp2p.dialMultiselectProtocol(pid);
  `;
  const hits = findHits(text);
  assert.equal(hits.length, 0);
});

// Codex review feedback on PR #499: catch optional chaining and
// bracket-access bypasses.

test('catches optional chaining: foo?.dialProtocol(', () => {
  const hits = findHits('await libp2p?.dialProtocol(pid, "/p/1");');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('catches bracket access: foo["dialProtocol"](', () => {
  const hits = findHits('await libp2p["dialProtocol"](pid, "/p/1");');
  assert.equal(hits.length, 1);
});

test('catches bracket access: foo[\'dialProtocol\'](', () => {
  const hits = findHits("await libp2p['dialProtocol'](pid, '/p/1');");
  assert.equal(hits.length, 1);
});

test('catches bracket access with backticks: foo[`dialProtocol`](', () => {
  const hits = findHits('await libp2p[`dialProtocol`](pid, "/p/1");');
  assert.equal(hits.length, 1);
});

test('catches optional bracket access: foo?.["dialProtocol"](', () => {
  const hits = findHits('await libp2p?.["dialProtocol"](pid, "/p/1");');
  assert.equal(hits.length, 1);
});

test('ignores ["dialProtocol"] inside a comment', () => {
  const hits = findHits('// libp2p["dialProtocol"](pid, "/p/1");');
  assert.equal(hits.length, 0);
});

test('ignores ["dialProtocol"] inside a string', () => {
  const hits = findHits('const s = `look at libp2p["dialProtocol"](x)`;');
  assert.equal(hits.length, 0);
});

test('ignores [\'foo\'] when value is not dialProtocol', () => {
  const hits = findHits('await libp2p["dialMultiselectProtocol"](pid);');
  assert.equal(hits.length, 0);
});

// Codex review feedback on PR #499 (round 2): bracket access with
// inline comments must still be caught.

test('catches bracket access with comment between [ and string', () => {
  const hits = findHits('await libp2p[/*x*/"dialProtocol"](pid, "/p/1");');
  assert.equal(hits.length, 1);
});

test('catches bracket access with comment between string and ]', () => {
  const hits = findHits('await libp2p["dialProtocol"/*x*/](pid, "/p/1");');
  assert.equal(hits.length, 1);
});

test('catches bracket access with comments on both sides', () => {
  const hits = findHits(
    'await libp2p[ /*x*/ "dialProtocol" /*y*/ ](pid, "/p/1");',
  );
  assert.equal(hits.length, 1);
});

test('catches bracket access with line comment + newline inside', () => {
  const hits = findHits(
    'await libp2p[ // pick the call\n  "dialProtocol"\n](pid, "/p/1");',
  );
  assert.equal(hits.length, 1);
});

test('still ignores bracket form inside a block comment', () => {
  const hits = findHits('/* libp2p[/*x*/"dialProtocol"](pid, "/p/1"); */');
  assert.equal(hits.length, 0);
});

// Codex review feedback on PR #499 (round 2): two distinct dialProtocol(
// calls on the same line must count as two hits — otherwise the
// expectedHits allowlist can be silently doubled.

test('counts two distinct calls on the same line as two hits', () => {
  const hits = findHits('await libp2p.dialProtocol(a); await libp2p.dialProtocol(b);');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].line, 1);
  assert.equal(hits[1].line, 1);
  assert.notEqual(hits[0].index, hits[1].index);
});

test('counts member + bracket on the same line as two hits', () => {
  const hits = findHits('await libp2p.dialProtocol(a); await libp2p["dialProtocol"](b);');
  assert.equal(hits.length, 2);
});

// Codex review feedback on PR #499 (round 3): the audit must also
// catch optional-CALL forms — `foo.dialProtocol?.(...)` and bracket
// equivalents. Both execute the raw dial path while bypassing a
// detector that only looks for `(...)`.

test('catches optional-call: foo.dialProtocol?.(', () => {
  const hits = findHits('await libp2p.dialProtocol?.(pid, "/p/1");');
  assert.equal(hits.length, 1);
});

test('catches optional-call: foo?.dialProtocol?.(', () => {
  const hits = findHits('await libp2p?.dialProtocol?.(pid, "/p/1");');
  assert.equal(hits.length, 1);
});

test('catches optional-call bracket: foo["dialProtocol"]?.(', () => {
  const hits = findHits('await libp2p["dialProtocol"]?.(pid, "/p/1");');
  assert.equal(hits.length, 1);
});

test('catches optional-call bracket with optional chain: foo?.["dialProtocol"]?.(', () => {
  const hits = findHits('await libp2p?.["dialProtocol"]?.(pid, "/p/1");');
  assert.equal(hits.length, 1);
});
