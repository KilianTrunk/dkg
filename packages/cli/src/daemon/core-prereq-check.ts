/**
 * Core relay capability — boot-time sanity check.
 *
 * # Why this exists
 *
 * `nodeRole: 'core'` is purely self-declared today. A node can advertise itself
 * as a Core relay and immediately fail at the job because none of its bound
 * interfaces are reachable from the public internet. **beacon-01** in the
 * v10.0.0-rc.10 incident was the canonical case: it bound only to its Tailscale
 * CGNAT address (`100.99.142.87`) and could not have functioned as a relay
 * regardless of slot state. With this check in place, that misconfiguration
 * surfaces at boot in the operator's logs as `[CORE-PREREQ] looks degraded`
 * instead of being a network-wide silent failure.
 *
 * # Design
 *
 * Pure functions, no I/O, no libp2p dependency at this layer. Callers provide
 * the inputs (`listenAddresses`, `os.networkInterfaces()` snapshot, etc.) and
 * decide what to do with the result (`looksDegraded` + structured `reasons`).
 * The classifier is the testable kernel; the lifecycle wiring is one layer up.
 *
 * # Two-pass usage
 *
 * - **Pre-start pass**: classify the host's interfaces + the configured
 *   listenAddresses *before* `libp2p.start()` resolves wildcards. Catches
 *   "no public interface on the host" early — operator sees the warning
 *   before paying the boot cost.
 * - **Post-start pass**: re-run with `resolvedListenAddresses` from
 *   `agent.node.libp2p.getMultiaddrs()` — those are the actually-bound
 *   addresses after libp2p's address-resolver has done its thing (NAT64,
 *   `/ip4/0.0.0.0` → per-interface expansion, etc.). This is the
 *   authoritative pass; the pre-start pass is just a heads-up.
 *
 * # Order of classifier rules (matters)
 *
 * Wildcard rule first — `/ip4/0.0.0.0` and `/ip6/::` bind to every interface,
 * so the address's class is the *best* class across the host's interfaces (if
 * any interface is public, the binding is effectively public). Without the
 * host-interface lookup, the wildcard alone is unclassifiable. Then the
 * specific ranges in narrowing order — loopback → CGNAT → RFC1918 →
 * link-local → ULAv6 — so a more-specific class wins over a less-specific
 * one. DNS multiaddrs deliberately classify as `dns` rather than resolving at
 * boot (DNS resolution is async + flaky + the answer can change). DNS listen
 * addresses are not themselves proof of public reachability, but externally
 * routable DNS announce addresses can rescue an otherwise private/wildcard
 * binding because the operator is explicitly advertising a stable name.
 */

import { isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';

export type AddrClassification =
  | 'public'
  | 'rfc1918'
  | 'cgnat'
  | 'loopback'
  | 'linkLocal'
  | 'ulaIpv6'
  | 'dns'
  | 'multicast'
  | 'wildcardNoPublicInterface'
  | 'unknown';

export interface CorePrereqResult {
  /** Multiaddrs that classify as `public` (or wildcard-with-a-public-interface). */
  publicListenAddresses: string[];
  /** Everything else, with each entry's resolved class. */
  nonRoutableAddresses: Array<{ addr: string; class: AddrClassification }>;
  /**
   * True iff `publicListenAddresses` is empty AND no `announceAddresses` entry
   * can rescue the result. Operators with public DNS announce addresses (the
   * VPS-with-static-IP case) are not degraded when they still have at least
   * one bound listen address, even if that listen address is a wildcard /
   * non-routable address. A node with zero bound listen addresses is always
   * degraded: an announce address cannot make an unbound transport serve
   * relay traffic.
   */
  looksDegraded: boolean;
  /**
   * Human-readable reasons (one per failure mode hit). Empty when
   * `looksDegraded === false`. Logged verbatim by the lifecycle wiring.
   */
  reasons: string[];
}

export interface CheckCoreRelayPrereqsOpts {
  /**
   * Multiaddrs the daemon configured itself to listen on. Pre-start pass:
   * the values from the config (may include `/ip4/0.0.0.0/...` wildcards).
   * Post-start pass: pass `resolvedListenAddresses` here instead — those are
   * the post-wildcard-expansion addresses libp2p actually bound.
   */
  listenAddresses: string[];
  /**
   * `os.networkInterfaces()` snapshot. Injected (not read here) so tests
   * can run deterministically without touching the real host. The wildcard
   * classifier walks this list to figure out whether any interface gives
   * the wildcard binding a public reach. Empty / undefined means "no
   * interface info available" — wildcards then classify as
   * `wildcardNoPublicInterface` since we have no positive evidence of a
   * public interface.
   */
  hostInterfaces?: ReadonlyArray<NetworkInterfaceInfo>;
  /**
   * Optional multiaddrs the daemon advertises to the network (the VPS /
   * cloud case where the public IP isn't bound to a local interface).
   * A public announce address rescues an otherwise-degraded result only when
   * the node also has at least one bound listen address.
   */
  announceAddresses?: string[];
  /**
   * Only `'core'` nodes get a degraded verdict — `'edge'` nodes are clients
   * and don't need to serve traffic, so the check is informational at most.
   * Pass through for callers that want the classification regardless.
   */
  nodeRole: 'core' | 'edge';
}

const RFC1918_REGEXES: ReadonlyArray<RegExp> = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
];

function isValidIPv4(ip: string): boolean {
  return isIP(ip) === 4;
}

function isDocumentationIPv4(ip: string): boolean {
  return /^192\.0\.2\./.test(ip)
    || /^198\.51\.100\./.test(ip)
    || /^203\.0\.113\./.test(ip);
}

/**
 * Tailscale CGNAT: 100.64.0.0/10 (== first octet 100, second octet 64..127).
 * RFC6598 carrier-grade NAT range; routable on the Tailscale overlay only,
 * never reachable from the wider internet without explicit funnel setup.
 */
function isCgnatIPv4(ip: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

function isLoopbackIPv4(ip: string): boolean {
  return /^127\./.test(ip);
}

function isLinkLocalIPv4(ip: string): boolean {
  return /^169\.254\./.test(ip);
}

function isMulticastIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const first = Number(m[1]);
  return first >= 224 && first <= 239;
}

function isRfc1918IPv4(ip: string): boolean {
  return RFC1918_REGEXES.some((r) => r.test(ip));
}

function classifyIPv4(ip: string): AddrClassification {
  if (!isValidIPv4(ip)) return 'unknown';
  if (isLoopbackIPv4(ip)) return 'loopback';
  if (isLinkLocalIPv4(ip)) return 'linkLocal';
  if (isCgnatIPv4(ip)) return 'cgnat';
  if (isRfc1918IPv4(ip)) return 'rfc1918';
  if (isMulticastIPv4(ip)) return 'multicast';
  if (isDocumentationIPv4(ip)) return 'unknown';
  return 'public';
}

/**
 * Lowercase the IPv6 string and check its leading hextet. We compare against
 * the textual prefix instead of doing a numeric range check because the
 * input is already a string and these prefixes are short.
 *
 *   - `::1`                       → loopback
 *   - `fe80::/10`                 → linkLocal  (first hextet starts with fe8/fe9/fea/feb)
 *   - `fc00::/7`                  → ulaIpv6    (first hextet starts with fc or fd)
 *   - `ff00::/8`                  → multicast  (first hextet starts with ff)
 *   - everything else             → public
 */
function classifyIPv6(ipRaw: string): AddrClassification {
  if (isIP(ipRaw) !== 6) return 'unknown';
  const ip = ipRaw.toLowerCase();
  if (ip === '::1') return 'loopback';
  if (ip.startsWith('2001:db8:') || ip === '2001:db8::') return 'unknown';
  if (/^fe[89ab][0-9a-f]?:/.test(ip)) return 'linkLocal';
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return 'ulaIpv6';
  if (/^ff[0-9a-f]{2}:/.test(ip)) return 'multicast';
  return 'public';
}

function dnsHostFromMultiaddr(addr: string): string | undefined {
  const parts = addr.split('/').filter(Boolean);
  const proto = parts[0];
  if (proto !== 'dns' && proto !== 'dns4' && proto !== 'dns6' && proto !== 'dnsaddr') {
    return undefined;
  }
  return parts[1];
}

function isPublicDnsHostname(hostRaw: string | undefined): boolean {
  if (!hostRaw) return false;
  const host = hostRaw.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost') return false;
  const ipFamily = isIP(host);
  if (ipFamily === 4) return classifyIPv4(host) === 'public';
  if (ipFamily === 6) return classifyIPv6(host) === 'public';
  if (!host.includes('.')) return false;
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return false;
  return !(
    host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.test')
    || host.endsWith('.example')
    || host.endsWith('.invalid')
    || host.endsWith('.localhost')
    || host.endsWith('.home.arpa')
    || host.endsWith('.lan')
    || host.endsWith('.cluster.local')
  );
}

function isPublicAnnounceAddress(
  addr: string,
  hostInterfaces: ReadonlyArray<NetworkInterfaceInfo>,
): boolean {
  const klass = classifyMultiaddr(addr, hostInterfaces);
  if (klass === 'public') return true;
  if (klass !== 'dns') return false;
  return isPublicDnsHostname(dnsHostFromMultiaddr(addr));
}

/**
 * Pick the best (most-public) class across a host's interface IPs. Wins
 * order: public > dns > ulaIpv6 > rfc1918 > cgnat > linkLocal > loopback >
 * everything else. We treat the wildcard binding as "effectively the best
 * interface" since libp2p will accept inbound on any of them.
 */
function bestClassAmongInterfaces(
  ifs: ReadonlyArray<NetworkInterfaceInfo>,
  family: 'IPv4' | 'IPv6',
): AddrClassification {
  let best: AddrClassification = 'wildcardNoPublicInterface';
  const RANK: Record<AddrClassification, number> = {
    wildcardNoPublicInterface: -1,
    unknown: 0,
    multicast: 1,
    loopback: 2,
    linkLocal: 3,
    cgnat: 4,
    rfc1918: 5,
    ulaIpv6: 6,
    dns: 7,
    public: 8,
  };
  for (const i of ifs) {
    if (i.internal) continue;
    if (i.family !== family) continue;
    const klass = i.family === 'IPv6' ? classifyIPv6(i.address) : classifyIPv4(i.address);
    if (RANK[klass] > RANK[best]) best = klass;
  }
  return best;
}

/**
 * Classify a single multiaddr string.
 *
 * Multiaddr format is `/proto1/value1/proto2/value2/...` — we only need the
 * first two segments (transport address; the rest is port + circuit/relay
 * tail). String split keeps us free of a runtime multiaddr-parser
 * dependency.
 */
export function classifyMultiaddr(
  addr: string,
  hostInterfaces: ReadonlyArray<NetworkInterfaceInfo> = [],
): AddrClassification {
  const parts = addr.split('/').filter(Boolean);
  if (parts.length < 2) return 'unknown';
  const proto = parts[0];
  const value = parts[1];

  if (proto === 'dns' || proto === 'dns4' || proto === 'dns6' || proto === 'dnsaddr') {
    return 'dns';
  }

  if (proto === 'ip4') {
    if (value === '0.0.0.0') return bestClassAmongInterfaces(hostInterfaces, 'IPv4');
    return classifyIPv4(value);
  }

  if (proto === 'ip6') {
    if (value === '::') return bestClassAmongInterfaces(hostInterfaces, 'IPv6');
    return classifyIPv6(value);
  }

  return 'unknown';
}

/**
 * Run the full prereq check. Returns the structured result; never throws.
 *
 * Callers (lifecycle.ts) format the result for operator logs and decide
 * whether to escalate via the `core.allowDegradedRelay` config gate
 * (default `true` — warn-only, no behaviour change for backcompat).
 */
export function checkCoreRelayPrereqs(
  opts: CheckCoreRelayPrereqsOpts,
): CorePrereqResult {
  const { listenAddresses, hostInterfaces = [], announceAddresses = [], nodeRole } = opts;

  const classified = listenAddresses.map((addr) => ({
    addr,
    class: classifyMultiaddr(addr, hostInterfaces),
  }));

  const publicListenAddresses = classified
    .filter((c) => c.class === 'public')
    .map((c) => c.addr);
  const nonRoutableAddresses = classified.filter((c) => c.class !== 'public');

  const announcePublic = announceAddresses.some((a) => isPublicAnnounceAddress(a, hostInterfaces));
  const announceCanServe = classified.some(
    (c) => c.class === 'dns'
      || c.class === 'rfc1918'
      || c.class === 'cgnat'
      || c.class === 'ulaIpv6',
  );
  const announceRescues = announceCanServe && announcePublic;

  const looksDegraded = nodeRole === 'core'
    && publicListenAddresses.length === 0
    && !announceRescues;

  const reasons: string[] = [];
  if (looksDegraded) {
    const total = listenAddresses.length;
    if (total === 0) {
      reasons.push('listenAddresses is empty');
    } else {
      // Group by class so the reason summarises the failure mode rather than
      // listing every address. Operators can grep the structured nonRoutableAddresses
      // for the full set.
      const counts = new Map<AddrClassification, number>();
      for (const { class: c } of nonRoutableAddresses) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      const summary = Array.from(counts.entries())
        .map(([c, n]) => `${n} ${c}`)
        .join(', ');
      reasons.push(
        `all ${total} listenAddress${total === 1 ? '' : 'es'} are non-routable (${summary})`,
      );
    }
    if (announceAddresses.length > 0 && !announcePublic) {
      reasons.push(
        `${announceAddresses.length} announceAddress${announceAddresses.length === 1 ? '' : 'es'} present but none classify as public or public DNS`,
      );
    }
    if (announceAddresses.length === 0) {
      reasons.push('no announceAddresses configured (would have rescued an otherwise-degraded result)');
    }
  }

  return {
    publicListenAddresses,
    nonRoutableAddresses,
    looksDegraded,
    reasons,
  };
}
