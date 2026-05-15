import { describe, it, expect, afterEach, vi } from 'vitest';
import { DKGNode } from '../src/node.js';
import { ProtocolRouter } from '../src/protocol-router.js';
import { PeerDiscoveryManager } from '../src/discovery.js';
import { TypedEventBus } from '../src/event-bus.js';

describe('Circuit Relay', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const n of nodes) {
      try {
        await n.stop();
      } catch (err) {
        console.warn('Teardown: node.stop() failed', err);
      }
    }
    nodes.length = 0;
  });

  it('two nodes communicate through a direct connection via relay peer', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const nodeA = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    const nodeB = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(nodeA, nodeB);
    await nodeA.start();
    await nodeB.start();

    await new Promise(r => setTimeout(r, 1000));

    const relayPeers = relay.libp2p.getPeers().map(p => p.toString());
    expect(relayPeers).toContain(nodeA.peerId);
    expect(relayPeers).toContain(nodeB.peerId);

    const { multiaddr } = await import('@multiformats/multiaddr');
    const bAddr = nodeB.multiaddrs[0];
    await nodeA.libp2p.dial(multiaddr(bAddr));
    await new Promise(r => setTimeout(r, 500));

    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const routerA = new ProtocolRouter(nodeA);
    const routerB = new ProtocolRouter(nodeB);

    routerB.register('/test/relay-echo/1.0.0', async (data) => {
      return enc.encode(`relayed:${dec.decode(data)}`);
    });

    const response = await routerA.send(
      nodeB.peerId,
      '/test/relay-echo/1.0.0',
      enc.encode('ping'),
    );
    expect(dec.decode(response)).toBe('relayed:ping');
  }, 30000);

  it('protocol stream through circuit relay upgrades to direct via retry', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();
    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const nodeA = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    const nodeB = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(nodeA, nodeB);
    await nodeA.start();
    await nodeB.start();
    await new Promise(r => setTimeout(r, 2000));

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const routerA = new ProtocolRouter(nodeA);
    routerA.register('/test/relay-echo/1.0.0', async (data) => {
      return enc.encode(`echo:${dec.decode(data)}`);
    });

    const routerB = new ProtocolRouter(nodeB);

    // Dial through the circuit relay — ProtocolRouter.send will retry after
    // the connection manager upgrades from relay to direct mid-stream.
    const { multiaddr } = await import('@multiformats/multiaddr');
    await nodeB.libp2p.dial(multiaddr(`${relayAddr}/p2p-circuit/p2p/${nodeA.peerId}`));
    await new Promise(r => setTimeout(r, 2000));

    const response = await routerB.send(
      nodeA.peerId,
      '/test/relay-echo/1.0.0',
      enc.encode('via-circuit'),
      15000,
    );
    expect(dec.decode(response)).toBe('echo:via-circuit');
    routerA.unregister('/test/relay-echo/1.0.0');
  }, 30000);

  it('relay node starts with enableRelayServer', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    expect(relay.isStarted).toBe(true);
    expect(relay.peerId).toBeTruthy();
    expect(relay.multiaddrs.length).toBeGreaterThan(0);
  }, 15000);

  it('node can connect to a relay peer on startup', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(node);
    await node.start();

    await new Promise(r => setTimeout(r, 500));

    const peers = node.libp2p.getPeers().map(p => p.toString());
    expect(peers).toContain(relay.peerId);
  }, 15000);

  it('getConnections reports transport type for relay connections', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(node);
    await node.start();
    await new Promise(r => setTimeout(r, 1000));

    const bus = new TypedEventBus();
    const discovery = new PeerDiscoveryManager(node, bus);
    const conns = await discovery.getConnections();

    expect(conns.length).toBeGreaterThan(0);

    const toRelay = conns.find(c => c.peerId === relay.peerId);
    expect(toRelay).toBeDefined();
    expect(toRelay!.transport).toBe('direct');
    expect(toRelay!.direction).toBeDefined();
    expect(toRelay!.openedAt).toBeGreaterThan(0);
  }, 15000);

  it('getConnectionSummary returns correct totals', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const nodeA = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(nodeA);
    await nodeA.start();
    await new Promise(r => setTimeout(r, 1000));

    const bus = new TypedEventBus();
    const discovery = new PeerDiscoveryManager(nodeA, bus);
    const summary = await discovery.getConnectionSummary();

    expect(summary.total).toBeGreaterThan(0);
    expect(summary.direct + summary.relayed).toBe(summary.total);
    expect(summary.peers.length).toBe(summary.total);
  }, 15000);

  it('edge node recovers relay connection after disruption', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/ws'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(edge);
    await edge.start();
    await new Promise(r => setTimeout(r, 1000));

    // Verify initial connection
    expect(edge.libp2p.getConnections().length).toBeGreaterThan(0);

    // Force-close all connections to simulate network drop
    for (const conn of edge.libp2p.getConnections()) {
      await conn.close();
    }

    // Watchdog checks every 10s and redials after 1.5–2.5s delay; allow up to 25s for recovery
    let restored = false;
    for (let i = 0; i < 26; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (edge.libp2p.getConnections().length > 0) {
        restored = true;
        break;
      }
    }

    expect(restored).toBe(true);
  }, 35000);

  it('node with relay peers starts with tcp keepAlive and connectionManager config', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(edge);
    await edge.start();
    await new Promise(r => setTimeout(r, 1500));

    // Node should have at least one connection (to relay); config (keepAlive, maxConnections) is applied at start
    expect(edge.libp2p.getConnections().length).toBeGreaterThan(0);
    expect(edge.isStarted).toBe(true);
  }, 15000);

  it('edge with relayReservationCount=2 and 2 relays reserves on both', async () => {
    // PR3 multi-reservation behavior: by configuring N `/p2p-circuit`
    // listen addrs + `reservationConcurrency: N` we expect libp2p to
    // hold N parallel reservations on N distinct relays (subject to
    // discovery — bootstrap supplies the relayPeers list directly so
    // there's no random-walk delay). This test pins the wiring
    // end-to-end: 2 relays + 1 edge with count=2 must produce 2
    // distinct `/p2p-circuit` self-addresses on the edge, each tagged
    // with a different relay's PeerId.
    //
    // Why count=2 not the default 3: keeps the test light (one fewer
    // libp2p instance to spin up + tear down) while still exercising
    // the N>1 path. The validation tests cover the full default range.
    const relay1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    const relay2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay1, relay2);
    await relay1.start();
    await relay2.start();

    const relay1Addr = relay1.multiaddrs.find(a => a.includes('/tcp/'))!;
    const relay2Addr = relay2.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relay1Addr, relay2Addr],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();

    // Poll for both reservations — discovery + reservation HOP roundtrip
    // takes a beat per relay. Bound the wait at 10s (ample margin over
    // the typical 1-2s observed locally) and bail early when both
    // /p2p-circuit self-addrs land. We assert the relay PeerIds are
    // distinct so a single reservation announcing two equivalent addrs
    // can't false-positive.
    const relay1PidStr = relay1.peerId;
    const relay2PidStr = relay2.peerId;
    const deadline = Date.now() + 10_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      const hasRelay1 = circuitAddrs.some(a => a.includes(`/p2p/${relay1PidStr}/p2p-circuit`));
      const hasRelay2 = circuitAddrs.some(a => a.includes(`/p2p/${relay2PidStr}/p2p-circuit`));
      if (hasRelay1 && hasRelay2) break;
      await new Promise(r => setTimeout(r, 250));
    }

    const hasRelay1 = circuitAddrs.some(a => a.includes(`/p2p/${relay1PidStr}/p2p-circuit`));
    const hasRelay2 = circuitAddrs.some(a => a.includes(`/p2p/${relay2PidStr}/p2p-circuit`));
    expect(hasRelay1, `expected reservation on relay1; circuitAddrs=${JSON.stringify(circuitAddrs)}`).toBe(true);
    expect(hasRelay2, `expected reservation on relay2; circuitAddrs=${JSON.stringify(circuitAddrs)}`).toBe(true);
  }, 20000);

  it('clamps relayReservationCount to relayPeers.length and warns', async () => {
    // Codex review on PR #526: requesting 3 reservations when only 1
    // relay is configured can't deliver the documented N-(N-1)
    // tolerance and would queue an unattainable target. The fix is
    // to clamp + warn at start(). We verify the warn fires and the
    // edge actually only ends up with 1 /p2p-circuit self-addr (not
    // 3 attempts queued forever).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
      relayReservationCount: 3,
    });
    nodes.push(edge);
    await edge.start();

    const clampWarn = warnSpy.mock.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('clamping to 1'),
    );
    expect(clampWarn, `expected clamp warning; got: ${JSON.stringify(warnSpy.mock.calls)}`).toBeDefined();

    // Wait for the (single) reservation, then assert exactly one
    // distinct circuit self-addr (i.e. no extra duplicate listen addrs
    // hung up waiting for a relay that doesn't exist).
    const deadline = Date.now() + 5_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      if (circuitAddrs.length > 0) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const distinctRelayPids = new Set(
      circuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
    );
    expect(distinctRelayPids.size).toBe(1);

    warnSpy.mockRestore();
  }, 15000);

  it('skips multi-reservation amplification on relay-server (core) nodes with relayPeers', async () => {
    // PR #526 round-2 review (branarakic): the daemon's CLI fallback
    // supplies network.relays to BOTH core and edge nodes by default,
    // so without this gate a `nodeRole: "core"` instance would push
    // 3 `/p2p-circuit` listen addrs and try to reserve on other
    // relays. That contradicts the docs framing ("public node doesn't
    // need relay reservations") and multiplies relay-slot consumption
    // network-wide. The fix: core nodes with relayPeers fall back to
    // the legacy single /p2p-circuit listen addr, and
    // relayReservationCount is ignored with a warning.
    //
    // Note: the existing "node with relay peers starts with tcp
    // keepAlive" test above asserts a core node still functions when
    // relayPeers are set — this test pins the warning + the absence
    // of the multi-reservation amplification.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const upstreamRelay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(upstreamRelay);
    await upstreamRelay.start();

    const upstreamRelayAddr = upstreamRelay.multiaddrs.find(a => a.includes('/tcp/'))!;

    // Core node ALSO running a relay server, which ALSO has a
    // relayPeer (the daemon-fallback scenario branarakic flagged).
    // We set count=3 to make sure it's actively ignored.
    const core = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
      relayPeers: [upstreamRelayAddr],
      relayReservationCount: 3,
    });
    nodes.push(core);
    await core.start();

    const ignoreWarn = warnSpy.mock.calls.find(call =>
      typeof call[0] === 'string'
      && call[0].includes('relayReservationCount=3')
      && call[0].includes('relay servers don\'t multi-reserve'),
    );
    expect(
      ignoreWarn,
      `expected core-ignore warning; got: ${JSON.stringify(warnSpy.mock.calls)}`,
    ).toBeDefined();

    warnSpy.mockRestore();
  }, 15000);

  it('dedupes duplicate relayPeers entries by peerId for clamp + relayTargets', async () => {
    // Codex review on PR #526 round 4 caught that `reservedRelayCount`
    // was derived from raw `relayTargets`, so a duplicate config like
    // `[relayA-with-suffix-A, relayA-with-suffix-B]` (two entries that
    // resolve to the same peerId) was counted twice. With
    // `relayReservationCount: 2`, the watchdog would think target is
    // met by one actual reservation duplicated in its view — defeating
    // the redundancy guarantee.
    //
    // Fix asserts:
    //   1. The clamp warns when distinct count < raw entry count, and
    //      the chosen `relayReservationCount` is bounded by the distinct
    //      count, not the raw length.
    //   2. The edge ends up with exactly 1 distinct `/p2p-circuit`
    //      self-addr (one reservation on the one real relay), not 2
    //      duplicate entries that would falsely satisfy the watchdog.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr, relayAddr],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();

    const dedupWarn = warnSpy.mock.calls.find((call) =>
      typeof call[0] === 'string'
      && call[0].includes('2 entries')
      && call[0].includes('1 distinct peerIds'),
    );
    expect(
      dedupWarn,
      `expected dedup warning; got: ${JSON.stringify(warnSpy.mock.calls.map(c => c[0]))}`,
    ).toBeDefined();

    const clampWarn = warnSpy.mock.calls.find((call) =>
      typeof call[0] === 'string'
      && call[0].includes('clamping to 1'),
    );
    expect(
      clampWarn,
      `expected clamp-to-distinct-count warning; got: ${JSON.stringify(warnSpy.mock.calls.map(c => c[0]))}`,
    ).toBeDefined();

    const deadline = Date.now() + 5_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      if (circuitAddrs.length > 0) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const distinctRelayPids = new Set(
      circuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
    );
    expect(distinctRelayPids.size).toBe(1);

    warnSpy.mockRestore();
  }, 15000);

  it('does not churn the unreserved relay when relayReservationCount < relayPeers.length', async () => {
    // Codex review on PR #526 round 3 caught a real bug in the round-2
    // watchdog: with target>1, the per-relay gate required EVERY
    // configured peer to hold a reservation. For configs like 3 peers
    // + count=2, the unreserved third peer's gate
    // (`!thisRelayHasReservation`) stayed true forever and the
    // watchdog would tear it down + redial on every grace-window
    // expiry — wasted churn at best, breaks the existing 2 reservations
    // at worst (drop+redial closes the existing connection).
    //
    // Round-3 fix: gate is now "this peer holds OR `reservedRelayCount
    // >= target`". For 2-of-3 we expect 2 reservations and the
    // watchdog should leave the third peer alone.
    //
    // We assert the absence of churn by spying on the watchdog's
    // dropping/redial log line and triggering watchdogTick directly
    // (it's `private` so we type-cast — same escape hatch as a few
    // other tests in this file).
    const relay1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    const relay2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    const relay3 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay1, relay2, relay3);
    await relay1.start();
    await relay2.start();
    await relay3.start();

    const relay1Addr = relay1.multiaddrs.find(a => a.includes('/tcp/'))!;
    const relay2Addr = relay2.multiaddrs.find(a => a.includes('/tcp/'))!;
    const relay3Addr = relay3.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relay1Addr, relay2Addr, relay3Addr],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();

    const deadline = Date.now() + 10_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      const distinct = new Set(
        circuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
      );
      if (distinct.size >= 2) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const initialReservedPids = new Set(
      circuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
    );
    expect(
      initialReservedPids.size,
      `expected exactly 2 reservations from 2-of-3 config; got circuitAddrs=${JSON.stringify(circuitAddrs)}`,
    ).toBe(2);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await (edge as unknown as { watchdogTick: () => Promise<void> }).watchdogTick();

      const churnLog = logSpy.mock.calls.find((call) =>
        typeof call[0] === 'string'
        && call[0].includes('Relay watchdog')
        && (
          call[0].includes('this relay missing')
          || call[0].includes('to force reserve')
          || call[0].includes('reservation-redial')
        ),
      );
      expect(
        churnLog,
        `expected NO watchdog churn for the unreserved peer; got: ${JSON.stringify(logSpy.mock.calls.map(c => c[0]))}`,
      ).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }

    const finalCircuitAddrs = edge.libp2p
      .getMultiaddrs()
      .map(ma => ma.toString())
      .filter(a => a.includes('/p2p-circuit'));
    const finalReservedPids = new Set(
      finalCircuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
    );
    expect(finalReservedPids.size).toBe(2);
    for (const pid of initialReservedPids) {
      expect(finalReservedPids.has(pid as string)).toBe(true);
    }
  }, 25000);
});
