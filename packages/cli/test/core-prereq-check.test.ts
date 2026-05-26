import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  checkCoreRelayPrereqs,
  classifyMultiaddr,
  type AddrClassification,
} from '../src/daemon/core-prereq-check.js';

/**
 * Test fixtures — synthetic `os.networkInterfaces()` snapshots. The classifier
 * never reads real interfaces (the `hostInterfaces` arg is injected) so these
 * tests are deterministic regardless of where they run.
 */
const PUBLIC_IPV4_IFACE: NetworkInterfaceInfo = {
  address: '8.8.8.8',
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '8.8.8.8/24',
};

const PUBLIC_IPV6_IFACE: NetworkInterfaceInfo = {
  address: '2606:4700:4700::1111',
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '2606:4700:4700::1111/64',
};

const RFC1918_IFACE: NetworkInterfaceInfo = {
  address: '192.168.1.42',
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '192.168.1.42/24',
};

const LOOPBACK_IFACE: NetworkInterfaceInfo = {
  address: '127.0.0.1',
  netmask: '255.0.0.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: true,
  cidr: '127.0.0.1/8',
};

const TAILSCALE_IFACE: NetworkInterfaceInfo = {
  address: '100.99.142.87',
  netmask: '255.255.255.255',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '100.99.142.87/32',
};

describe('classifyMultiaddr — per-class smoke tests', () => {
  type Case = [string, AddrClassification];
  const cases: Case[] = [
    // The 8 base classes plus wildcards.
    ['/ip4/8.8.8.8/tcp/4001',         'public'],
    ['/ip4/203.0.113.5/tcp/4001',     'unknown'],
    ['/ip4/999.999.999.999/tcp/4001', 'unknown'],
    ['/ip4/10.0.0.1/tcp/4001',        'rfc1918'],
    ['/ip4/172.20.0.1/tcp/4001',      'rfc1918'],
    ['/ip4/192.168.1.1/tcp/4001',     'rfc1918'],
    ['/ip4/100.99.142.87/tcp/4001',   'cgnat'],   // beacon-01 Tailscale case
    ['/ip4/100.63.0.1/tcp/4001',      'public'],  // 100.63.x.x is OUTSIDE CGNAT range
    ['/ip4/100.128.0.1/tcp/4001',     'public'],  // 100.128.x.x is also OUTSIDE CGNAT range
    ['/ip4/127.0.0.1/tcp/4001',       'loopback'],
    ['/ip4/169.254.1.1/tcp/4001',     'linkLocal'],
    ['/ip4/224.0.0.1/tcp/4001',       'multicast'],
    ['/ip6/::1/tcp/4001',             'loopback'],
    ['/ip6/fe80::1/tcp/4001',         'linkLocal'],
    ['/ip6/fd00::1/tcp/4001',         'ulaIpv6'],  // RFC 4193 fc00::/7
    ['/ip6/fdab:cdef::1/tcp/4001',    'ulaIpv6'],  // Tailscale ULA range
    ['/ip6/ff02::1/tcp/4001',         'multicast'],
    ['/ip6/2606:4700:4700::1111/tcp/4001', 'public'],
    ['/ip6/2001:db8::1/tcp/4001',     'unknown'],  // RFC 3849 documentation range
    ['/dns4/example.com/tcp/4001',    'dns'],
    ['/dns6/example.com/tcp/4001',    'dns'],
    ['/dns/example.com/tcp/4001',     'dns'],
    ['/dnsaddr/example.com',          'dns'],
    ['/ip4/8.8.8.8/tcp/4001/p2p/12D3KooRelay/p2p-circuit/p2p/12D3KooSelf', 'relayed'],
    ['/unix/var/run/foo.sock',        'unknown'],
  ];

  it.each(cases)('classifies %s as %s', (addr, expected) => {
    expect(classifyMultiaddr(addr, [])).toBe(expected);
  });
});

describe('classifyMultiaddr — wildcards delegate to host interfaces', () => {
  it("0.0.0.0 with one public IPv4 interface classifies as `public`", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [PUBLIC_IPV4_IFACE])).toBe('public');
  });

  it("0.0.0.0 with one public AND one RFC1918 interface still classifies as `public` (best wins)", () => {
    // Operator value: a dual-homed host (one public, one LAN) is fully relay-capable
    // regardless of which interface libp2p picks for outbound; receivers see the
    // public one. The classifier picks the BEST, not the worst.
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [PUBLIC_IPV4_IFACE, RFC1918_IFACE])).toBe('public');
  });

  it("0.0.0.0 with only RFC1918 interfaces classifies as `rfc1918`", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [RFC1918_IFACE])).toBe('rfc1918');
  });

  it("0.0.0.0 with only loopback (internal) interfaces classifies as wildcardNoPublicInterface (internal: true is skipped)", () => {
    // Loopback interfaces in the real `os.networkInterfaces()` output have
    // `internal: true`. Our classifier skips internal interfaces — they don't
    // count as "an interface the wildcard binding can serve traffic on".
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [LOOPBACK_IFACE])).toBe('wildcardNoPublicInterface');
  });

  it("0.0.0.0 with no interfaces classifies as wildcardNoPublicInterface", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [])).toBe('wildcardNoPublicInterface');
  });

  it("0.0.0.0 with only CGNAT interfaces classifies as `cgnat` (beacon-01 if it had used 0.0.0.0)", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [TAILSCALE_IFACE])).toBe('cgnat');
  });

  it("IPv6 :: wildcard delegates to host interfaces the same way IPv4 0.0.0.0 does", () => {
    expect(classifyMultiaddr('/ip6/::/tcp/4001', [PUBLIC_IPV6_IFACE])).toBe('public');
    expect(classifyMultiaddr('/ip6/::/tcp/4001', [])).toBe('wildcardNoPublicInterface');
  });

  it("IPv4 and IPv6 wildcards only consider interfaces from the matching family", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [PUBLIC_IPV6_IFACE])).toBe('wildcardNoPublicInterface');
    expect(classifyMultiaddr('/ip6/::/tcp/4001', [PUBLIC_IPV4_IFACE])).toBe('wildcardNoPublicInterface');
  });
});

describe('checkCoreRelayPrereqs — 7 canonical cases from the plan', () => {
  it('case 1: Tailscale-only beacon-01 reproduces a degraded result with cgnat reason', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/100.99.142.87/tcp/4001'],
      hostInterfaces: [TAILSCALE_IFACE, LOOPBACK_IFACE],
      announceAddresses: [],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.publicListenAddresses).toEqual([]);
    expect(result.nonRoutableAddresses).toEqual([
      { addr: '/ip4/100.99.142.87/tcp/4001', class: 'cgnat' },
    ]);
    expect(result.reasons[0]).toContain('1 cgnat');
  });

  it('case 2: 0.0.0.0 + one public interface is not degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4001/ws'],
      hostInterfaces: [PUBLIC_IPV4_IFACE, LOOPBACK_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.publicListenAddresses).toHaveLength(2);
    expect(result.reasons).toEqual([]);
  });

  it('case 3: 0.0.0.0 + only RFC1918 interfaces is degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/0.0.0.0/tcp/4001'],
      hostInterfaces: [RFC1918_IFACE, LOOPBACK_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('rfc1918');
  });

  it('case 4: single public IPv4 is not degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      hostInterfaces: [PUBLIC_IPV4_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.publicListenAddresses).toEqual(['/ip4/8.8.8.8/tcp/4001']);
  });

  it('case 5: loopback-only is degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/127.0.0.1/tcp/4001'],
      hostInterfaces: [LOOPBACK_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('loopback');
  });

  it('case 6: IPv6 ULA-only is degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip6/fd00::1/tcp/4001'],
      hostInterfaces: [],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('ulaIpv6');
  });

  it('case 7: DNS-only listen + public announce rescues the result', () => {
    // The VPS-with-static-IP case: listen via `/dns4/relay.origintrail.io/...` because
    // the operator wants to point clients at a stable name, then announce the
    // resolved public IP separately. Either side alone would not classify as
    // public, but the public announceAddresses entry rescues the verdict.
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/dns4/relay.origintrail.io/tcp/4001'],
      hostInterfaces: [RFC1918_IFACE],
      announceAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.nonRoutableAddresses[0].class).toBe('dns');
  });

  it('DNS announce rescues a private bound listener for stable public-DNS deployments', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/4001'],
      hostInterfaces: [RFC1918_IFACE],
      announceAddresses: ['/dnsaddr/relay.origintrail.io'],
      nodeRole: 'core',
    });

    expect(result.looksDegraded).toBe(false);
    expect(result.nonRoutableAddresses[0].class).toBe('rfc1918');
  });
});

describe('checkCoreRelayPrereqs — additional safety cases', () => {
  it('edge node with all-loopback listenAddresses is NOT flagged as degraded (only core nodes get the verdict)', () => {
    // Edge nodes are clients — they don't need to serve inbound traffic. The
    // classifier still labels their addresses (operators sometimes want to
    // see the classification) but `looksDegraded` is reserved for cores.
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/127.0.0.1/tcp/4001'],
      hostInterfaces: [LOOPBACK_IFACE],
      nodeRole: 'edge',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.nonRoutableAddresses[0].class).toBe('loopback');
  });

  it('empty listenAddresses on a core yields a specific reason', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: [],
      hostInterfaces: [PUBLIC_IPV4_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.reasons.some((r) => r === 'listenAddresses is empty')).toBe(true);
  });

  it('empty listenAddresses is still degraded even when announceAddresses contains a public address', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: [],
      hostInterfaces: [PUBLIC_IPV4_IFACE],
      announceAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.reasons).toContain('listenAddresses is empty');
  });

  it('relayed self-addresses do not count as public direct listeners', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: [
        '/ip4/8.8.8.8/tcp/4001/p2p/12D3KooRelay/p2p-circuit/p2p/12D3KooSelf',
      ],
      hostInterfaces: [PUBLIC_IPV4_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.publicListenAddresses).toEqual([]);
    expect(result.nonRoutableAddresses[0].class).toBe('relayed');
  });

  it('loopback listenAddresses stay degraded even when announceAddresses contains a public address', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/127.0.0.1/tcp/4001'],
      hostInterfaces: [LOOPBACK_IFACE],
      announceAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('loopback');
  });

  it('mixed degraded classes summarise in a single reason line (cgnat + rfc1918 + loopback)', () => {
    // Operator value: the reason summary is grep-able. If a node has 5
    // non-routable addresses across 3 classes, we don't want 5 log lines;
    // one summary "N class1, M class2, …" tells the story at a glance.
    const result = checkCoreRelayPrereqs({
      listenAddresses: [
        '/ip4/100.99.142.87/tcp/4001',
        '/ip4/100.64.0.5/tcp/4001',
        '/ip4/192.168.1.1/tcp/4001',
        '/ip4/127.0.0.1/tcp/4001',
      ],
      hostInterfaces: [],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.reasons[0]).toMatch(/all 4 listenAddresses are non-routable/);
    expect(result.reasons[0]).toContain('2 cgnat');
    expect(result.reasons[0]).toContain('1 rfc1918');
    expect(result.reasons[0]).toContain('1 loopback');
  });

  it('announceAddresses with no public entries does not rescue, and a dedicated reason calls that out', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/4001'],
      hostInterfaces: [],
      announceAddresses: ['/ip4/10.0.0.5/tcp/4001'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.reasons.some((r) => r.includes('announceAddress') && r.includes('none classify as public or public DNS'))).toBe(true);
  });

  it('reserved DNS announce names do not rescue private listeners', () => {
    for (const host of ['localhost', 'relay.local', 'svc.cluster.local', 'myhost', 'relay.test', 'relay.example']) {
      const result = checkCoreRelayPrereqs({
        listenAddresses: ['/ip4/192.168.1.1/tcp/4001'],
        hostInterfaces: [],
        announceAddresses: [`/dnsaddr/${host}`],
        nodeRole: 'core',
      });
      expect(result.looksDegraded, host).toBe(true);
    }
  });

  it('no announceAddresses on a degraded result surfaces the missing-rescue hint', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/4001'],
      hostInterfaces: [],
      nodeRole: 'core',
    });
    expect(result.reasons.some((r) => r.includes('no announceAddresses configured'))).toBe(true);
  });
});
