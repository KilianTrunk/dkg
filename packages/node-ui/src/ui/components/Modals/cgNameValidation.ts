/**
 * Client-side input contract for the Create Context Graph modal name
 * field (BUG-016). The previous implementation accepted *any* string —
 * unbounded length, raw HTML, leading/trailing whitespace — and only
 * the daemon's slugify pass downstream caught the most blatant abuse.
 * That meant pasting a 5,000-character HTML chunk into the field
 * silently sent a 5,000-character payload (with embedded `<script>`
 * tags) over the wire, and the user only learned something was wrong
 * when the request 4xx'd or worse. The redacted display name in
 * dashboards then surfaced the raw HTML without escaping.
 *
 * The module exports three small helpers, all pure (no React, no DOM):
 *
 * - `CG_NAME_MAX_LENGTH`    — single source of truth for the cap. 80
 *                             chars is plenty for a human-readable
 *                             label and keeps the URL-encoded slug
 *                             well under the 60-char slug ceiling
 *                             enforced by the daemon (`slugify`).
 * - `sanitiseCgName(input)` — returns the cleaned version of the raw
 *                             input: HTML/control chars stripped,
 *                             whitespace collapsed, length capped.
 *                             This is what we feed back into the
 *                             controlled `<input>` so the user sees
 *                             exactly what will be submitted.
 * - `validateCgName(input)` — returns a user-facing error string if
 *                             the *raw* input fails a hard rule (empty
 *                             after sanitise, contained an HTML tag),
 *                             or `null` when acceptable.
 */
export const CG_NAME_MAX_LENGTH = 80;

const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
// Strip every ASCII control character EXCEPT the whitespace ones (tab,
// LF, CR) — those are still control codes (0x09/0x0A/0x0D) but the
// next step intentionally collapses them into spaces. Stripping them
// up-front would silently glue surrounding tokens together
// ("\nnewlines\nand\ttabs\n" would render as "newlinesandtabs").
const NON_WHITESPACE_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitiseCgName(input: string): string {
  if (typeof input !== 'string') return '';
  let v = input;
  v = v.replace(HTML_TAG_RE, '');
  v = v.replace(/<|>/g, '');
  v = v.replace(NON_WHITESPACE_CONTROL_CHARS_RE, '');
  v = v.replace(/\s+/g, ' ');
  v = v.trim();
  if (v.length > CG_NAME_MAX_LENGTH) v = v.slice(0, CG_NAME_MAX_LENGTH);
  return v;
}

export function validateCgName(input: string): string | null {
  const cleaned = sanitiseCgName(input);
  if (!cleaned) return 'Enter a name with at least one letter or digit.';
  if (HTML_TAG_RE.test(input)) {
    return 'HTML tags are not allowed in the name — they have been stripped automatically.';
  }
  if (input.length > CG_NAME_MAX_LENGTH) {
    return `Name was trimmed to ${CG_NAME_MAX_LENGTH} characters (was ${input.length}).`;
  }
  return null;
}
