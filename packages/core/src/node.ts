import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT, type KadDHT } from '@libp2p/kad-dht';
import { gossipsub, type GossipSub } from '@libp2p/gossipsub';
import { mdns } from '@libp2p/mdns';
import { identify } from '@libp2p/identify';
import { ping, type Ping } from '@libp2p/ping';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromString } from '@libp2p/peer-id';
import { ed25519GetPublicKey } from './crypto/ed25519.js';
import type { ConnectionTransport, DKGNodeConfig } from './types.js';
import { DHT_PROTOCOL, DKG_GOSSIP_MAX_RPC_BYTES } from './constants.js';

export interface DKGServices extends Record<string, unknown> {
  dht: KadDHT;
  pubsub: GossipSub;
  identify: unknown;
  ping: Ping;
  dcutr: unknown;
  autoNAT?: unknown;
  relay?: unknown;
}

const RELAY_WATCHDOG_BASE_INTERVAL_MS = 10_000;
const RELAY_WATCHDOG_MAX_INTERVAL_MS = 5 * 60_000;
/** Short delay before redialing a disconnected relay to avoid hammering (ms). */
const RELAY_REDIAL_DELAY_MS = 1_500;
/**
 * How long to allow a fresh reservation negotiation to complete after a relay
 * redial before the watchdog considers the relay unhealthy again. Circuit
 * Relay v2 reservation setup is usually sub-second on a healthy link, but we
 * give it a generous grace window to absorb transient latency.
 */
const RELAY_RESERVATION_GRACE_MS = 15_000;

/**
 * Default relay server capacity — the number of simultaneous circuit-relay v2
 * reservations a Core Node will hold. All other relay-related caps (HOP/STOP
 * stream limits, connectionManager.maxConnections) derive from this at a 1:2
 * ratio so capacity=1024 → 2048 stream caps + 2048 max conns.
 *
 * Bumped from the previous hardcoded 256 (libp2p's stock default for the
 * relay-v2 server is even lower — 15) which capped a single Core Node at
 * ~256 concurrent edge agents. That was below the natural hundreds-to-
 * thousands-of-agents trajectory the network is designed for; PR #510's
 * agent-debug-chat exercised this directly and showed the cap was already
 * a meaningful ceiling at ~5 active edges. See operator docs for the
 * `ulimit -n` requirement.
 */
export const DEFAULT_RELAY_SERVER_CAPACITY = 1024;
/** Multiplier for derived stream + connection caps (capacity × 2). */
export const RELAY_CAPACITY_MULTIPLIER = 2;
/**
 * Per-circuit duration limit. Bumped from libp2p's 5-minute default to 30
 * minutes so chat-style intermittent traffic (5-15 minute silent gaps are
 * normal) doesn't tear circuits down underneath the application — this was
 * the proximate cause of the May 2026 NO_RESERVATION blackout pair (Miles
 * ↔ Lex) that motivated PRs #517, #521, and this one. Reservation TTL
 * itself stays at the libp2p default (2h) but is set explicitly below for
 * operator visibility.
 */
export const RELAY_DEFAULT_DURATION_LIMIT_MS = 30 * 60 * 1000;
export const RELAY_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;
/** maxConnections for nodes that don't run a relay server (edge default). */
export const EDGE_NODE_MAX_CONNECTIONS = 500;

export interface DerivedRelayCaps {
  maxReservations: number;
  maxConnections: number;
  maxInboundHopStreams: number;
  maxOutboundHopStreams: number;
  maxOutboundStopStreams: number;
  maxInboundStopStreams: number;
}

/**
 * Derive the full relay-related cap set from a single capacity value. The
 * 1:2 ratio is intentional: each reservation costs one long-lived control
 * connection, plus circuits going through this relay open additional
 * HOP+STOP streams (multiplexed) and other peers can connect for non-relay
 * reasons (DHT, gossip, direct dials). Doubling the capacity for streams
 * and connections gives realistic headroom without overcommitting.
 */
export function deriveRelayCaps(capacity: number): DerivedRelayCaps {
  const streamCap = capacity * RELAY_CAPACITY_MULTIPLIER;
  return {
    maxReservations: capacity,
    maxConnections: streamCap,
    maxInboundHopStreams: streamCap,
    maxOutboundHopStreams: streamCap,
    maxOutboundStopStreams: streamCap,
    maxInboundStopStreams: streamCap,
  };
}

/**
 * Emit an informational/warning log at relay startup about the host's
 * `ulimit -n` (RLIMIT_NOFILE) versus what the configured maxConnections
 * actually needs. We can read this losslessly from
 * `process.report.getReport().userLimits.open_files` on POSIX (libp2p
 * Core Nodes are POSIX-only in practice).
 *
 * Why this matters: libp2p's maxConnections is an upper bound libp2p
 * tracks internally; if the kernel rejects the underlying socket() with
 * EMFILE before libp2p hits its own cap, the only signal is opaque
 * "peer rejected" errors in logs. Surfacing the discrepancy at startup
 * gives operators a loud, actionable signal.
 */
export function checkFdLimit(maxConnections: number, log: (msg: string) => void): void {
  const recommended = Math.max(4096, maxConnections * RELAY_CAPACITY_MULTIPLIER);
  try {
    const report = (process as any).report?.getReport?.();
    const openFiles = report?.userLimits?.open_files;
    const soft = openFiles?.soft;
    if (typeof soft === 'number') {
      if (soft < recommended) {
        log(
          `WARN: relay server enabled with maxConnections=${maxConnections}, ` +
            `but host ulimit -n soft=${soft} is below the recommended ${recommended} ` +
            `(= max(4096, maxConnections × 2)). The kernel will reject new ` +
            `socket() calls with EMFILE once the daemon hits the limit, ` +
            `manifesting as silent peer rejections. Bump with ` +
            `'ulimit -n ${recommended}' (shell), 'LimitNOFILE=${recommended}' (systemd unit), ` +
            `or '--ulimit nofile=${recommended}:${recommended}' (Docker).`,
        );
      } else {
        log(
          `relay server: ulimit -n soft=${soft} >= recommended ${recommended}, ok`,
        );
      }
    } else {
      log(
        `relay server: could not read host ulimit -n via process.report.userLimits; ` +
          `ensure ulimit -n >= ${recommended} on this host`,
      );
    }
  } catch (err: any) {
    log(
      `relay server: error reading ulimit -n (${err?.message ?? String(err)}); ` +
        `ensure ulimit -n >= ${recommended} on this host`,
    );
  }
}

interface RelayTarget {
  peerId: ReturnType<typeof peerIdFromString>;
  addr: any;
}

/**
 * Conservative classifier matching `isMultiaddrRemotelyDialable` in
 * `packages/node-ui/src/ui/components/Modals/ShareProjectModal.tsx`.
 * Returns true for addresses a remote peer could plausibly dial without
 * traversing a circuit relay (i.e. global IPv4 / IPv6 / DNS-based).
 * Circuit-relay addresses are checked separately by callers because the
 * "peer record is dialable" signal merges both classes.
 */
export function isLocalOrInternalHostname(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0) return true;
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h.endsWith('.test') || h.endsWith('.example')) return true;
  if (h.endsWith('.invalid') || h.endsWith('.localdomain')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^\[?[0-9a-f:]+\]?$/.test(h) && h.includes(':')) return true;
  if (!h.includes('.')) return true;
  return false;
}

export function isPublicLikeAddress(addr: string): boolean {
  const dnsMatch = addr.match(/^\/(?:dns|dns4|dns6|dnsaddr)\/([^/]+)\//);
  if (dnsMatch) return !isLocalOrInternalHostname(dnsMatch[1]);
  const ipv4 = addr.match(/^\/ip4\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\//);
  if (ipv4) {
    const o = ipv4[1].split('.').map(Number);
    if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    if (o[0] === 0 || o[0] === 127) return false;
    if (o[0] === 10) return false;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
    if (o[0] === 192 && o[1] === 168) return false;
    if (o[0] === 169 && o[1] === 254) return false;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;
    if (o[0] >= 224) return false;
    return true;
  }
  const ipv6 = addr.match(/^\/ip6\/([^/]+)\//);
  if (ipv6) {
    const ip = ipv6[1].toLowerCase();
    if (ip === '::' || ip === '::1') return false;
    if (ip.startsWith('fe80')) return false;
    if (/^f[cd]/.test(ip)) return false;
    if (ip.startsWith('ff')) return false;
    return true;
  }
  return false;
}

export class DKGNode {
  private node: Libp2p<DKGServices> | null = null;
  private readonly config: DKGNodeConfig;
  /** Peers currently connected only via relay (candidates for DCUtR upgrade). */
  private readonly relayedPeers = new Set<string>();
  private relayWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private relayTargets: RelayTarget[] = [];
  private relayWatchdogConsecutiveFailures = 0;
  /**
   * Per-relay timestamp of the last redial we issued specifically because the
   * circuit reservation had lapsed. Used to suppress spurious "reservation
   * missing" findings while a freshly re-dialed relay is still negotiating
   * the new reservation on the wire.
   */
  private relayReservationRedialAt: Map<string, number> = new Map();

  constructor(config: DKGNodeConfig = {}) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.node) return;

    let privateKey;
    if (this.config.privateKey) {
      // privateKeyFromRaw needs 64 bytes for Ed25519: seed(32) + publicKey(32)
      const seed = this.config.privateKey;
      const pub = await ed25519GetPublicKey(seed);
      const raw64 = new Uint8Array(64);
      raw64.set(seed, 0);
      raw64.set(pub, 32);
      privateKey = privateKeyFromRaw(raw64);
    } else {
      privateKey = await generateKeyPair('Ed25519');
    }

    const peerDiscovery = [];
    if (this.config.bootstrapPeers && this.config.bootstrapPeers.length > 0) {
      peerDiscovery.push(bootstrap({ list: this.config.bootstrapPeers }));
    }
    if (this.config.enableMdns !== false) {
      peerDiscovery.push(mdns());
    }

    const isCore = this.config.nodeRole === 'core';
    const enableRelay = this.config.enableRelayServer ?? isCore;

    // Relay-server capacity tuning. When relay is enabled, derive HOP/STOP
    // stream caps and the connectionManager.maxConnections ceiling from
    // the operator-configured (or default) capacity. Edge nodes that
    // don't run a relay server keep the legacy 500-connection ceiling and
    // the upstream libp2p stream defaults — the bumped caps carry no
    // benefit there and we don't want to inflate the blast radius of
    // this change beyond Core Nodes.
    if (this.config.relayServerCapacity != null && !enableRelay) {
      console.warn(
        `[dkg-core] relayServerCapacity=${this.config.relayServerCapacity} ` +
          `set but relay server is not enabled (nodeRole=${this.config.nodeRole ?? 'edge'}, ` +
          `enableRelayServer=${this.config.enableRelayServer}); value ignored`,
      );
    }
    const relayCapacity = enableRelay
      ? (this.config.relayServerCapacity ?? DEFAULT_RELAY_SERVER_CAPACITY)
      : null;
    const relayCaps = relayCapacity != null ? deriveRelayCaps(relayCapacity) : null;

    // TCP keepAlive helps prevent idle relay connections from being dropped by
    // middleboxes or remote timeouts (common cause of ECONNRESET).
    const transports: any[] = [
      tcp({ dialOpts: { keepAlive: true } }),
      webSockets(),
      // STOP stream caps default to 300 in libp2p; on a Core Node holding
      // 1024+ reservations that's a lower ceiling than maxReservations
      // implies. Bump the transport-side caps to match the server-side
      // capacity. Edge nodes keep the upstream defaults (passing
      // undefined here is the same as omitting the field).
      circuitRelayTransport(
        relayCaps
          ? {
              maxInboundStopStreams: relayCaps.maxInboundStopStreams,
              maxOutboundStopStreams: relayCaps.maxOutboundStopStreams,
            }
          : undefined,
      ),
    ];

    // Nodes that already know their NAT status skip autoNAT probing:
    // - relayPeers set → agent behind NAT (knows it needs relay)
    // - enableRelayServer/core → public node acting as relay
    const useAutoNAT = this.config.enableAutoNAT ??
      !(this.config.relayPeers?.length || enableRelay);

    const services: Record<string, any> = {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({ protocol: DHT_PROTOCOL }),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        floodPublish: true,
        maxInboundDataLength: DKG_GOSSIP_MAX_RPC_BYTES,
        maxOutboundBufferSize: DKG_GOSSIP_MAX_RPC_BYTES,
        D: 4,
        Dlo: 2,
        Dhi: 8,
        // NOTE — RFC 07 §5.4 ships the constant `dkgGossipMsgId` for
        // cross-backend dedup, but it is intentionally NOT wired in
        // here yet. Codex review feedback on PR #501 (round 2) flagged
        // a real rolling-upgrade hazard: gossipsub puts msgIds into
        // its IHAVE/IWANT control protocol, so during a rolling
        // network upgrade old (default upstream `msgIdFnStrictSign`)
        // and new (`dkgGossipMsgId`) nodes compute different IDs for
        // the same payload and stop correlating cache entries. Push
        // delivery still works (the message itself is the same wire
        // bytes); only the dedup cache fragments, producing extra
        // IWANT/SERVE round-trips per message until the upgrade
        // completes. For an isolated devnet that's fine; for a live
        // mainnet mesh it's wasteful and observable.
        //
        // Plan: keep using upstream's default `msgIdFnStrictSign` here
        // (signed = sha256(from || seqno), unsigned = sha256(data)),
        // ship `dkgGossipMsgId` and its tests so the constant is
        // pinned and reviewable, and flip the wiring as part of a
        // coordinated mesh-wide upgrade — most likely combined with a
        // gossipsub protocol-version bump so old/new nodes segregate
        // into separate meshes during the cutover instead of degrading
        // a shared one.
        //
        // Cross-references:
        //   - The function lives at
        //     `packages/core/src/network/gossip-msg-id.ts` with the
        //     full encoding test suite at
        //     `packages/core/test/gossip-msg-id.test.ts`.
        //   - The architectural rationale + cutover plan is documented
        //     in the RFC 07 spec doc `07_IN_PROCESS_PEER_RESOLVER.md`
        //     §5.4 + Phase 5, which lives in the sibling `dkgv10-spec`
        //     repository (not in this repo). Re-stated in summary form
        //     above so the wiring decision is reviewable in-place.
      }),
      dcutr: dcutr(),
    };

    if (useAutoNAT) {
      services.autoNAT = autoNAT();
    }

    if (enableRelay && relayCaps) {
      services.relay = circuitRelayServer({
        // Bumped from the libp2p default (no cap → unlimited but
        // bottlenecked by maxOutboundStopStreams=300) to the derived
        // capacity-scaled value so a Core Node can actually serve N
        // simultaneous active circuits when N reservations are held.
        maxInboundHopStreams: relayCaps.maxInboundHopStreams,
        maxOutboundHopStreams: relayCaps.maxOutboundHopStreams,
        maxOutboundStopStreams: relayCaps.maxOutboundStopStreams,
        reservations: {
          maxReservations: relayCaps.maxReservations,
          // Per-circuit duration; bumped 5min → 30min so chat-style
          // intermittent traffic doesn't tear circuits down underneath
          // the application during quiet windows.
          defaultDurationLimit: RELAY_DEFAULT_DURATION_LIMIT_MS,
          // Reservation TTL set explicitly (matches libp2p default of
          // 2h) so operators tuning relay behaviour see the value
          // here instead of having to grep upstream.
          reservationTtl: RELAY_RESERVATION_TTL_MS,
          defaultDataLimit: BigInt(1 << 24),
        },
      });
      checkFdLimit(relayCaps.maxConnections, (msg) => console.warn(`[dkg-core] ${msg}`));
    }

    const listenAddrs = [
      ...(this.config.listenAddresses ?? [
        '/ip4/0.0.0.0/tcp/0',
        '/ip4/0.0.0.0/tcp/0/ws',
      ]),
    ];

    // When relay peers are configured, listen on circuit addresses to ensure
    // the node requests a reservation and becomes reachable through relays.
    if (this.config.relayPeers?.length) {
      listenAddrs.push('/p2p-circuit');
    }

    this.node = await createLibp2p<DKGServices>({
      privateKey,
      addresses: {
        listen: listenAddrs,
        ...(this.config.announceAddresses?.length
          ? { announce: this.config.announceAddresses }
          : {}),
      },
      transports: transports as any,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery,
      services,
      connectionManager: {
        minConnections: 0,
        // Core Nodes scale this with relayServerCapacity (default
        // capacity=1024 → maxConnections=2048). Edge nodes keep the
        // legacy 500-connection ceiling — they have no relay-server
        // pressure and wider headroom adds nothing.
        maxConnections: relayCaps?.maxConnections ?? EDGE_NODE_MAX_CONNECTIONS,
      },
    } as any);

    this.setupConnectionObservability();

    // Connect to relay peers and tag them as keep-alive so libp2p's
    // connection manager maintains the connection and auto-redials.
    if (this.config.relayPeers?.length) {
      const { multiaddr } = await import('@multiformats/multiaddr');

      for (const addr of this.config.relayPeers) {
        const ma = multiaddr(addr);
        const p2pComponent = ma.getComponents().find(c => c.name === 'p2p');
        if (!p2pComponent?.value) continue;

        const peerId = peerIdFromString(p2pComponent.value);
        if (peerId.equals(this.node.peerId)) continue;

        this.relayTargets.push({ peerId, addr: ma });

        await this.node.peerStore.merge(peerId, {
          multiaddrs: [ma],
          tags: {
            'keep-alive-dkg-relay': { value: 100 },
          },
        });

        try {
          await this.node.dial(ma);
        } catch {
          // watchdog will retry
        }
      }

      this.startRelayWatchdog();
    }
  }

  /**
   * Periodically check that relay connections are alive. After a network
   * outage (e.g. laptop sleep/wake) TCP sockets die silently and libp2p
   * won't automatically redial. Uses exponential backoff when the relay is
   * unreachable and resets to the base interval on successful reconnect.
   */
  private startRelayWatchdog(): void {
    if (this.relayWatchdogTimer) return;
    if (this.relayTargets.length === 0) return;

    this.scheduleWatchdogTick();
  }

  private scheduleWatchdogTick(): void {
    const delay = Math.min(
      RELAY_WATCHDOG_BASE_INTERVAL_MS * Math.pow(2, this.relayWatchdogConsecutiveFailures),
      RELAY_WATCHDOG_MAX_INTERVAL_MS,
    );

    this.relayWatchdogTimer = setTimeout(async () => {
      await this.watchdogTick();
      if (this.node) this.scheduleWatchdogTick();
    }, delay);

    if (this.relayWatchdogTimer.unref) {
      this.relayWatchdogTimer.unref();
    }
  }

  private async watchdogTick(): Promise<void> {
    const node = this.node;
    if (!node) return;

    const ts = () => new Date().toISOString();
    const short = (id: string) => id.slice(-8);
    let allHealthy = true;
    // `onlyWaitingOnGraceWindow` stays true as long as every reason we
    // marked a relay unhealthy this tick was "we just redialed and are
    // still inside the reservation grace window". That's a benign
    // waiting state — we don't want to count it against the watchdog's
    // exponential backoff, because doubling the next delay to 20s/40s/…
    // for a ≤15s grace means a genuinely missing reservation can go
    // unchecked for multiple minutes after a single forced redial.
    // Codex tier-4g finding on the `allHealthy = false; continue` line
    // a few blocks below.
    let onlyWaitingOnGraceWindow = true;

    // Snapshot advertised self-multiaddrs once per tick. The presence of
    // *any* /p2p-circuit self-address is the authoritative signal that
    // libp2p has at least one live circuit reservation somewhere. Recent
    // js-libp2p circuit-relay-v2 defaults to holding a single reservation
    // at a time, so we treat the reservation set as a pool, not per-relay.
    // `haveAnyReservation` is evaluated per-iteration from a mutable
    // snapshot (`refreshReservationSnapshot`), not once before the loop.
    // A successful redial can restore a reservation mid-tick and every
    // remaining relay must see that fresh state — otherwise a healthy
    // idle relay gets torn down by the `transportUp && !haveAnyReservation`
    // branch just because it was scanned after the recovery. Codex
    // tier-4l finding at packages/core/src/node.ts:351. We keep the
    // first snapshot so the "this relay currently holds the reservation"
    // hint stays accurate within a single iteration.
    let circuitSelfAddrs = node.getMultiaddrs().map(ma => ma.toString()).filter(a => a.includes('/p2p-circuit'));
    let haveAnyReservation = circuitSelfAddrs.length > 0;
    const refreshReservationSnapshot = () => {
      circuitSelfAddrs = node.getMultiaddrs().map(ma => ma.toString()).filter(a => a.includes('/p2p-circuit'));
      haveAnyReservation = circuitSelfAddrs.length > 0;
    };
    const now = Date.now();

    for (const { peerId, addr } of this.relayTargets) {
      if (peerId.equals(node.peerId)) continue;

      const relayPidStr = peerId.toString();
      const conns = node.getConnections(peerId);
      const transportUp = conns.length > 0;

      const thisRelayHasReservation = circuitSelfAddrs.some(a =>
        a.includes(`/p2p/${relayPidStr}/p2p-circuit`),
      );

      // Happy path: transport is up AND either this relay is the one
      // holding our reservation, OR we already have a reservation on some
      // other relay (libp2p only requests one at a time by default, so
      // "other relays are connected but idle" is the normal steady state).
      if (transportUp && (thisRelayHasReservation || haveAnyReservation)) {
        this.relayReservationRedialAt.delete(relayPidStr);
        continue;
      }

      // Transport is up but we have ZERO reservations across all relays.
      // Something has gone wrong in libp2p's reservation-pool management;
      // force a re-listen on this relay by dropping + redialing.
      if (transportUp && !haveAnyReservation) {
        const lastForcedRedial = this.relayReservationRedialAt.get(relayPidStr) ?? 0;
        if (now - lastForcedRedial < RELAY_RESERVATION_GRACE_MS) {
          // We just redialed; give libp2p time to finish negotiating a new
          // reservation before declaring failure. This is a benign wait,
          // so do NOT clear `onlyWaitingOnGraceWindow` — keeping it true
          // means the tail doesn't apply the exponential backoff, which
          // would otherwise starve the next check well past the grace
          // window itself.
          allHealthy = false;
          continue;
        }

        allHealthy = false;
        // Actual corrective action below (drop + redial); this is a
        // real failure the watchdog must back off on.
        onlyWaitingOnGraceWindow = false;
        console.log(
          `[${ts()}] Relay watchdog: no circuit reservation anywhere (0 /p2p-circuit self-addrs); ` +
          `dropping + redialing ${short(relayPidStr)} to force reserve`,
        );
        this.relayReservationRedialAt.set(relayPidStr, now);

        for (const c of conns) {
          try {
            await c.close();
          } catch {
            // Best-effort: if the close call itself fails we still try to
            // redial below; libp2p will reuse an existing connection if one
            // somehow survived.
          }
        }
        // Brief delay so the remote side has time to release the prior hop
        // reservation slot before we ask for a new one.
        const delayMs = RELAY_REDIAL_DELAY_MS + Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, delayMs));
        let redialed = false;
        try {
          await node.dial(addr);
          redialed = true;
          console.log(`[${ts()}] Relay watchdog: redialed ${short(relayPidStr)} for fresh reservation`);
        } catch (err: any) {
          console.log(`[${ts()}] Relay watchdog: reservation-redial failed for ${short(relayPidStr)}: ${err.message}`);
        }
        // Stop after one reservation-recovery attempt per tick. libp2p's
        // circuit-relay-v2 only holds one reservation at a time by default,
        // so if this redial restored a reservation, every remaining relay
        // in `this.relayTargets` would otherwise still see the stale
        // `!haveAnyReservation` snapshot from line ~251 and tear-down +
        // redial itself in the same tick, briefly dropping all relay paths
        // at once. One recovery per tick is enough; the next tick re-reads
        // multiaddrs and will handle any remaining unhealthy relays.
        if (redialed) break;
        continue;
      }

      // Transport is down — classic disconnect path. Count against
      // backoff (this is a real failure, not a grace-window wait).
      allHealthy = false;
      onlyWaitingOnGraceWindow = false;
      console.log(`[${ts()}] Relay watchdog: ${short(relayPidStr)} disconnected, redialing…`);
      const delayMs = RELAY_REDIAL_DELAY_MS + Math.floor(Math.random() * 1000);
      await new Promise(r => setTimeout(r, delayMs));
      try {
        await node.dial(addr);
        console.log(`[${ts()}] Relay watchdog: reconnected to ${short(relayPidStr)}`);
        // Reservation may have been restored by this dial; refresh the
        // snapshot so the next iteration doesn't tear down another
        // healthy relay on stale state.
        refreshReservationSnapshot();
      } catch (err: any) {
        console.log(`[${ts()}] Relay watchdog: redial failed for ${short(relayPidStr)}: ${err.message}`);
      }
    }

    if (allHealthy) {
      this.relayWatchdogConsecutiveFailures = 0;
    } else if (onlyWaitingOnGraceWindow) {
      // Every unhealthy relay this tick was just the reservation
      // grace window after a forced redial. Don't inflate the backoff
      // — the next scheduled tick needs to actually arrive while the
      // grace window is still the active state, otherwise a missing
      // reservation can sit uncorrected for minutes.
      const nextDelay = Math.min(
        RELAY_WATCHDOG_BASE_INTERVAL_MS * Math.pow(2, this.relayWatchdogConsecutiveFailures),
        RELAY_WATCHDOG_MAX_INTERVAL_MS,
      );
      console.log(`[${ts()}] Relay watchdog: reservation grace window pending; next check in ${Math.round(nextDelay / 1000)}s`);
    } else {
      this.relayWatchdogConsecutiveFailures++;
      const nextDelay = Math.min(
        RELAY_WATCHDOG_BASE_INTERVAL_MS * Math.pow(2, this.relayWatchdogConsecutiveFailures),
        RELAY_WATCHDOG_MAX_INTERVAL_MS,
      );
      console.log(`[${ts()}] Relay watchdog: next check in ${Math.round(nextDelay / 1000)}s (attempt ${this.relayWatchdogConsecutiveFailures})`);
    }
  }

  /**
   * Wire up connection:open / connection:close listeners that track transport
   * type (direct vs relayed) and detect DCUtR upgrades from relay to direct.
   */
  private setupConnectionObservability(): void {
    const node = this.requireNode();
    const ts = () => new Date().toISOString();
    const short = (id: string) => id.slice(-8);

    node.addEventListener('connection:open', (evt) => {
      const conn = evt.detail;
      const pid = conn.remotePeer.toString();
      const addr = conn.remoteAddr?.toString() ?? 'unknown';
      const transport: ConnectionTransport = addr.includes('/p2p-circuit') ? 'relayed' : 'direct';
      const dir = conn.direction;

      if (transport === 'relayed') {
        this.relayedPeers.add(pid);
        console.log(
          `[${ts()}] Connection opened: ${short(pid)} transport=relayed ` +
          `dir=${dir} addr=${addr}`,
        );
      } else {
        const upgraded = this.relayedPeers.has(pid);
        if (upgraded) {
          this.relayedPeers.delete(pid);
          console.log(
            `[${ts()}] DCUtR upgrade: ${short(pid)} relayed -> direct ` +
            `dir=${dir} addr=${addr}`,
          );
        } else {
          console.log(
            `[${ts()}] Connection opened: ${short(pid)} transport=direct ` +
            `dir=${dir} addr=${addr}`,
          );
        }
      }
    });

    node.addEventListener('connection:close', (evt) => {
      const conn = evt.detail;
      const pid = conn.remotePeer.toString();
      const addr = conn.remoteAddr?.toString() ?? 'unknown';
      const transport: ConnectionTransport = addr.includes('/p2p-circuit') ? 'relayed' : 'direct';
      const durationMs = conn.timeline.close
        ? conn.timeline.close - conn.timeline.open
        : '?';

      // If this was the last connection to the peer, clean up tracking state.
      const remaining = node.getConnections(conn.remotePeer);
      if (remaining.length === 0) {
        this.relayedPeers.delete(pid);
      }

      console.log(
        `[${ts()}] Connection closed: ${short(pid)} transport=${transport} ` +
        `duration=${durationMs}ms addr=${addr}`,
      );
    });

    node.addEventListener('peer:disconnect', (evt) => {
      const pid = evt.detail.toString();
      this.relayedPeers.delete(pid);
      console.log(`[${ts()}] Peer disconnected: ${short(pid)}`);
    });

    // Log once when this node first becomes remotely-dialable. Closes a
    // cold-start observability gap that the V10 DHT-resolved invite flow
    // exposed: a curator who shares an invite seconds after `dkg start`
    // may have a peer record in the DHT containing only LAN/loopback
    // addresses, so joiners get PEER_NOT_FOUND-ish silent failures. This
    // log line lets operators see the moment the peer record becomes
    // useful (a circuit-relay reservation landed or a public address
    // appeared). Once-per-process; fires from `self:peer:update` which
    // libp2p emits whenever the local peer's announced address set changes.
    let dialableLogged = false;
    const checkDialable = () => {
      if (dialableLogged) return;
      const addrs = node.getMultiaddrs().map((ma) => ma.toString());
      const dialable = addrs.find((a) => a.includes('/p2p-circuit/') || isPublicLikeAddress(a));
      if (!dialable) return;
      dialableLogged = true;
      const kind = dialable.includes('/p2p-circuit/') ? 'circuit-relay' : 'public';
      console.log(
        `[${ts()}] Node is remotely-dialable (${kind}); peer-id invites should now resolve via DHT. ` +
        `addr=${dialable}`,
      );
    };
    node.addEventListener('self:peer:update', checkDialable);
    // libp2p may have already populated multiaddrs by the time we attach
    // the listener (especially for `core` / public nodes whose addresses
    // are known the moment listening succeeds). Cover that race with a
    // single immediate check.
    checkDialable();
  }

  async stop(): Promise<void> {
    if (!this.node) return;
    if (this.relayWatchdogTimer) {
      clearTimeout(this.relayWatchdogTimer);
      this.relayWatchdogTimer = null;
    }
    this.relayTargets = [];
    this.relayWatchdogConsecutiveFailures = 0;
    this.relayReservationRedialAt.clear();
    this.relayedPeers.clear();
    await this.node.stop();
    this.node = null;
  }

  get peerId(): string {
    return this.requireNode().peerId.toString();
  }

  get peerIdBytes(): Uint8Array {
    return this.requireNode().peerId.toMultihash().bytes;
  }

  get multiaddrs(): string[] {
    return this.requireNode()
      .getMultiaddrs()
      .map((ma) => ma.toString());
  }

  get libp2p(): Libp2p<DKGServices> {
    return this.requireNode();
  }

  get isStarted(): boolean {
    return this.node !== null;
  }

  private requireNode(): Libp2p<DKGServices> {
    if (!this.node) throw new Error('DKGNode not started');
    return this.node;
  }
}
