/**
 * Focused coverage for the shared bulk-publish loop `publishAssertionsToVm`
 * (src/ui/api.ts). The formatter + funds classifier are tested elsewhere; this
 * pins the LOOP behavior the reviewer flagged: a regression that stops after the
 * first failure, drops `subGraphName`, never calls `onProgress`, or fails to
 * record `fundsErr` on a NO_FUNDED_PUBLISHER_WALLET failure must fail here.
 *
 * Drives the REAL `post`/`HttpError` path by mocking `globalThis.fetch` (the
 * established node-ui pattern — see chat-memory.test.ts), so the NO_FUNDED
 * `body.code` branch in `describeInsufficientPublisherFunds` is genuinely
 * exercised rather than stubbed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { publishAssertionsToVm } from '../src/ui/api.js';

describe('publishAssertionsToVm', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('continues after a failure, records partial success + the first funds error, forwards subGraphName, calls onProgress per assertion', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: any, init: any) => {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      // assertion "b" fails with NO_FUNDED_PUBLISHER_WALLET; "a" and "c" succeed.
      if (url.includes('/knowledge-assets/b/')) {
        return new Response(
          JSON.stringify({ code: 'NO_FUNDED_PUBLISHER_WALLET', error: 'No operational wallet has enough funds to publish.' }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    const progress: string[] = [];
    const outcome = await publishAssertionsToVm(
      'cg-1',
      [{ name: 'a', subGraph: 'sgA' }, { name: 'b' }, { name: 'c', subGraph: 'sgC' }],
      (name) => progress.push(name),
    );

    // Partial success: a + c published, b failed → the loop did NOT stop on b.
    expect(outcome.published).toBe(2);
    expect(outcome.total).toBe(3);
    // First funds error captured (from the real HttpError.body.code path).
    expect(outcome.fundsErr).toContain('No operational wallet has enough funds');
    expect(outcome.lastErr).toBeTruthy();
    // onProgress fired once per assertion, in order, before each publish.
    expect(progress).toEqual(['a', 'b', 'c']);
    // subGraphName forwarded into the request body when present, omitted when absent.
    const bodyFor = (n: string) => calls.find((c) => c.url.includes(`/knowledge-assets/${n}/`))!.body;
    expect(bodyFor('a').subGraphName).toBe('sgA');
    expect('subGraphName' in bodyFor('b')).toBe(false);
    expect(bodyFor('c').subGraphName).toBe('sgC');
    // All three were attempted (continue-after-failure).
    expect(calls.length).toBe(3);
  });

  it('records a non-funds failure in lastErr but leaves fundsErr null', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 })) as any;

    const outcome = await publishAssertionsToVm('cg-1', [{ name: 'x' }], () => {});

    expect(outcome.published).toBe(0);
    expect(outcome.total).toBe(1);
    expect(outcome.lastErr).toBe('boom');
    expect(outcome.fundsErr).toBeNull();
  });
});
