import { describe, it, expect } from 'vitest';
import { createLogRedactor, redactLogEntry, REDACTED } from '../src/log-redaction.js';
import type { LogRecord } from '../src/logger.js';

function rec(message: string): LogRecord {
  return { level: 'info', operationName: 'publish', operationId: 'op-1', module: 'test', message };
}

describe('log redaction — secrets are scrubbed before logs leave the node', () => {
  const redact = createLogRedactor();

  it('redacts a wallet private key given by key name (any value shape)', () => {
    const out = redact(rec('loaded operationalWalletPrivateKey=0xabc123def4567890abc123def4567890abc123def4567890abc123def4567890'));
    expect(out.message).toContain('operationalWalletPrivateKey=');
    expect(out.message).toContain(REDACTED);
    expect(out.message).not.toMatch(/0xabc123def4567890/);
  });

  it('redacts privateKey in JSON-ish "key": "value" form', () => {
    const out = redact(rec('signing with {"privateKey":"0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}'));
    expect(out.message).toContain('"privateKey":');
    expect(out.message).toContain(REDACTED);
    expect(out.message).not.toContain('deadbeef');
  });

  it('redacts a quoted mnemonic INCLUDING its spaces', () => {
    const out = redact(rec('restored mnemonic="legal winner thank year wave sausage worth useful legal winner thank yellow"'));
    expect(out.message).toContain('mnemonic=');
    expect(out.message).toContain(REDACTED);
    expect(out.message).not.toMatch(/legal winner|sausage|yellow/);
  });

  it('redacts bearer tokens and api keys', () => {
    const out = redact(rec('headers authorization=Bearer-abc.def token: sk_live_9f8e7d6c apiKey=AKIAEXAMPLE123'));
    expect(out.message).not.toContain('sk_live_9f8e7d6c');
    expect(out.message).not.toContain('AKIAEXAMPLE123');
    expect((out.message.match(/\[REDACTED\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('redacts a JWT by shape even with no key name', () => {
    const jwt = 'eyJhbGciOiJIUzI1Ni1.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4';
    const out = redact(rec(`auth header ${jwt} received`));
    expect(out.message).toContain(REDACTED);
    expect(out.message).not.toContain('eyJhbGci');
  });

  it('does NOT redact public 0x hashes / Merkle roots (no false positives)', () => {
    const root = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const input = rec(`published KC root ${root} tx ${root} merkleRoot ${root}`);
    const out = redact(input);
    expect(out).toBe(input); // unchanged → same object, no redaction
    expect(out.message).toContain(root);
  });

  it('leaves ordinary messages untouched (returns same object)', () => {
    const original = rec('peer connected: 12D3KooWabc, 3 direct / 6 relayed');
    const out = redact(original);
    expect(out).toBe(original); // no allocation when nothing matched
  });

  it('honors operator-configured extra sensitive keys', () => {
    const withExtra = createLogRedactor(['walletPassword', 'customSecretField']);
    const out = withExtra(rec('config customSecretField=hunter2 walletPassword="p@ss w0rd"'));
    expect(out.message).not.toContain('hunter2');
    expect(out.message).not.toContain('p@ss w0rd');
  });

  it('redactLogEntry one-shot matches the compiled redactor', () => {
    const msg = 'token=secret-value-123';
    expect(redactLogEntry(rec(msg)).message).toBe(redact(rec(msg)).message);
  });

  it('never touches non-message fields', () => {
    const out = redact(rec('privateKey=0xabc'));
    expect(out.level).toBe('info');
    expect(out.operationId).toBe('op-1');
    expect(out.operationName).toBe('publish');
    expect(out.module).toBe('test');
  });
});
