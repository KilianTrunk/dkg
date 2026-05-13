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
