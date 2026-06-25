/**
 * At-source redaction of secrets from log records before they leave the node.
 *
 * Why this exists: V10 nodes are run by independent operators, and once a
 * secret (a wallet private key, a mnemonic, an API token) is shipped to a
 * remote collector it is irreversibly leaked. Redaction therefore runs on the
 * node, on the copy of every log record that is about to be FORWARDED. The
 * local dashboard DB keeps full-fidelity records for the operator's own
 * debugging — redaction only protects data that crosses the trust boundary.
 *
 * Design choices (deliberately conservative to avoid mangling useful logs):
 *  - Structured "key: value" / key=value / "key":"value" shapes are redacted
 *    by KEY NAME (high precision). This is how DKG actually logs secrets
 *    (e.g. operationalWalletPrivateKey, mnemonic).
 *  - JWTs are redacted by shape (eyJ….….…) — effectively zero false positives.
 *  - We deliberately do NOT blanket-redact 0x-prefixed 64-hex strings: in DKG
 *    those are overwhelmingly Merkle roots, KC roots and tx hashes (public,
 *    non-secret) and nuking them would destroy debuggability. A bare private
 *    key with no key-name context is a residual gap best closed with a
 *    collector-side OTTL/regex backstop (see the PoC stack).
 */

import type { LogRecord } from './logger.js';

/**
 * Default sensitive key names whose values are scrubbed from log messages
 * before forwarding. Matched case-insensitively.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'privateKey',
  'private_key',
  'privKey',
  'operationalWalletPrivateKey',
  'managementWalletPrivateKey',
  'mnemonic',
  'seedPhrase',
  'seed_phrase',
  'seed',
  'secret',
  'secretKey',
  'clientSecret',
  'password',
  'passphrase',
  'passwd',
  'pwd',
  'apiKey',
  'api_key',
  'apiToken',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'token',
  'authorization',
  'bearer',
  'sessionKey',
  'encryptionKey',
];

export const REDACTED = '[REDACTED]';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact the free-form `message` of a log record. The two patterns are:
 *  1. JWT-shaped tokens (header.payload.signature, base64url) — by shape.
 *  2. `<sensitiveKey><sep><value>` — the value is replaced, the key kept.
 *     Quoted values (single/double/backtick) are redacted whole (so a quoted
 *     mnemonic with spaces is fully removed); bare values up to the next
 *     delimiter otherwise.
 */
export function redactMessage(message: string, keyRegex: RegExp, jwtRegex: RegExp): string {
  if (!message) return message;
  // Reset lastIndex defensively (these are global regexes reused across calls).
  jwtRegex.lastIndex = 0;
  keyRegex.lastIndex = 0;
  let out = message.replace(jwtRegex, REDACTED);
  out = out.replace(keyRegex, (_full, keyAndSep: string) => `${keyAndSep}${REDACTED}`);
  return out;
}

function buildKeyRegex(keys: readonly string[]): RegExp {
  const alt = keys.map(escapeRegExp).join('|');
  // group 1 = key (optionally quoted) + separator (kept verbatim)
  // group 2 = value (redacted): a quoted run, or a bare token up to a delimiter
  return new RegExp(
    '(' +
      '["\'`]?\\b(?:' + alt + ')\\b["\'`]?' + // key, optionally quoted
      '\\s*[:=]\\s*' + // : or =
    ')' +
    '(' +
      '"[^"]*"' + '|' +
      "'[^']*'" + '|' +
      '`[^`]*`' + '|' +
      // auth-scheme + credential as ONE value, so `authorization: Bearer <token>`
      // redacts the token too (not just the scheme word).
      '(?:Bearer|Basic|Bot|Token|Digest|ApiKey)\\s+[^\\s,;}\\]\\)]+' + '|' +
      '[^\\s,;}\\]\\)]+' + // bare token
    ')',
    'gi',
  );
}

// JWT: three base64url segments separated by dots, starting with the
// canonical `eyJ` ('{"' base64url-encoded). Conservative min lengths.
const JWT_SOURCE = '\\beyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\b';

/**
 * Compile a redactor once, then reuse it on the hot path (one per shipper).
 * `extraKeys` are operator-configured additional sensitive key names.
 */
export function createLogRedactor(extraKeys: readonly string[] = []): (record: LogRecord) => LogRecord {
  const keys = extraKeys.length ? [...DEFAULT_SENSITIVE_KEYS, ...extraKeys] : DEFAULT_SENSITIVE_KEYS;
  const keyRegex = buildKeyRegex(keys);
  const jwtRegex = new RegExp(JWT_SOURCE, 'g');
  return (record: LogRecord): LogRecord => {
    if (!record || !record.message) return record;
    const redacted = redactMessage(record.message, keyRegex, jwtRegex);
    if (redacted === record.message) return record; // no change → no alloc
    return { ...record, message: redacted };
  };
}

/** One-shot convenience (recompiles each call — do not use on the hot path). */
export function redactLogEntry(record: LogRecord, extraKeys: readonly string[] = []): LogRecord {
  return createLogRedactor(extraKeys)(record);
}
