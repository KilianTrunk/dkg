/**
 * Network Relay Registry — daemon-side publish helpers (RFC 04 / Issue #461).
 *
 * Covers the pure-function side of the relay-registry publishing path:
 *  - `filterPublishableMultiaddrs` — what makes it through the
 *    "externally-reachable" filter that gates the chain write.
 *
 * The full `DKGAgent.publishRelayRegistry()` integration (chain
 * round-trip, idempotence skip-when-equal, no-throw on adapter errors)
 * is exercised by the multi-laptop devnet test in Phase 1 acceptance.
 * This file pins the edge cases that would silently leak local
 * addresses to chain — those are the failures most likely to slip
 * through manual review.
 */
import { describe, it, expect } from 'vitest';
import { filterPublishableMultiaddrs } from '../src/dkg-agent.js';

const VALID_PUBLIC =
  '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const VALID_DNS =
  '/dns4/relay.example.com/tcp/443/wss/p2p/12D3KooWAbcDef';
const VALID_CIRCUIT =
  `${VALID_PUBLIC}/p2p-circuit/p2p/12D3KooWEdgeFOO`;

describe('filterPublishableMultiaddrs', () => {
  it('keeps public IPv4 / DNS multiaddrs', () => {
    const out = filterPublishableMultiaddrs([VALID_PUBLIC, VALID_DNS]);
    expect(out).toEqual([VALID_PUBLIC, VALID_DNS]);
  });

  it('keeps /p2p-circuit/ addresses (NAT\'d edges)', () => {
    expect(filterPublishableMultiaddrs([VALID_CIRCUIT])).toEqual([VALID_CIRCUIT]);
  });

  it('drops loopback addresses (127.0.0.1 / ::1)', () => {
    const out = filterPublishableMultiaddrs([
      '/ip4/127.0.0.1/tcp/9090/p2p/12D3Koo',
      '/ip6/::1/tcp/9090/p2p/12D3Koo',
      VALID_PUBLIC,
    ]);
    expect(out).toEqual([VALID_PUBLIC]);
  });

  it('drops RFC1918 / link-local / CGNAT private ranges', () => {
    const out = filterPublishableMultiaddrs([
      '/ip4/10.0.0.5/tcp/9090/p2p/12D3Koo',
      '/ip4/192.168.1.10/tcp/9090/p2p/12D3Koo',
      '/ip4/172.20.5.5/tcp/9090/p2p/12D3Koo',
      '/ip4/169.254.1.5/tcp/9090/p2p/12D3Koo',
      '/ip4/100.64.0.1/tcp/9090/p2p/12D3Koo',
    ]);
    expect(out).toEqual([]);
  });

  it('drops local DNS hostnames (localhost, .local, .test)', () => {
    const out = filterPublishableMultiaddrs([
      '/dns/localhost/tcp/9090/p2p/12D3Koo',
      '/dns4/myhost.local/tcp/9090/p2p/12D3Koo',
      '/dns/example.test/tcp/9090/p2p/12D3Koo',
      VALID_DNS,
    ]);
    expect(out).toEqual([VALID_DNS]);
  });

  it('deduplicates while preserving first-seen order', () => {
    const out = filterPublishableMultiaddrs([
      VALID_PUBLIC,
      VALID_DNS,
      VALID_PUBLIC,
      VALID_DNS,
    ]);
    expect(out).toEqual([VALID_PUBLIC, VALID_DNS]);
  });

  it('handles empty input', () => {
    expect(filterPublishableMultiaddrs([])).toEqual([]);
  });

  it('skips empty / non-string entries defensively', () => {
    const out = filterPublishableMultiaddrs([
      '',
      // @ts-expect-error - defensive against runtime garbage from libp2p
      null,
      // @ts-expect-error - defensive against runtime garbage from libp2p
      undefined,
      VALID_PUBLIC,
    ]);
    expect(out).toEqual([VALID_PUBLIC]);
  });
});
