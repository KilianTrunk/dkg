import { describe, expect, it } from 'vitest';
import { RelayFlapGuard, parseCircuitRelayPeerIds } from '../src/relay-flap-guard.js';

const RELAY_A = '12D3KooWRelayA';
const RELAY_B = '12D3KooWRelayB';
const REMOTE_A = '12D3KooWRemoteA';
const REMOTE_B = '12D3KooWRemoteB';

function guard(): RelayFlapGuard {
  return new RelayFlapGuard({
    shortCloseMs: 100,
    windowMs: 1_000,
    threshold: 3,
    baseQuarantineMs: 200,
    maxQuarantineMs: 800,
    stableCloseMs: 1_000,
    denyLogIntervalMs: 50,
  });
}

function recordShortBurst(g: RelayFlapGuard, relayPeerId = RELAY_A, remotePeerId = REMOTE_A): void {
  expect(g.recordRelayedClose({ relayPeerId, remotePeerId, durationMs: 50, now: 0 }).enteredQuarantine).toBe(false);
  expect(g.recordRelayedClose({ relayPeerId, remotePeerId, durationMs: 50, now: 10 }).enteredQuarantine).toBe(false);
  expect(g.recordRelayedClose({ relayPeerId, remotePeerId, durationMs: 50, now: 20 }).enteredQuarantine).toBe(true);
}

describe('parseCircuitRelayPeerIds', () => {
  it('extracts relay and remote peer ids from a circuit address', () => {
    expect(
      parseCircuitRelayPeerIds(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_A}/p2p-circuit/p2p/${REMOTE_A}`),
    ).toEqual({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A });
  });

  it('extracts only the relay peer id from reservation-style circuit addresses', () => {
    expect(
      parseCircuitRelayPeerIds(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_A}/p2p-circuit`),
    ).toEqual({ relayPeerId: RELAY_A, remotePeerId: undefined });
  });

  it('does not classify direct addresses as relayed paths', () => {
    expect(parseCircuitRelayPeerIds(`/ip4/1.2.3.4/tcp/9090/p2p/${REMOTE_A}`)).toBeNull();
  });
});

describe('RelayFlapGuard', () => {
  it('quarantines the exact relay/remote pair after repeated short relayed closes', () => {
    const g = guard();
    recordShortBurst(g);

    const denied = g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 25 });
    expect(denied.deny).toBe(true);
    expect(denied.shouldLog).toBe(true);
    expect(denied.quarantineMsRemaining).toBe(195);

    const repeatedDenied = g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 30 });
    expect(repeatedDenied.deny).toBe(true);
    expect(repeatedDenied.shouldLog).toBe(false);
  });

  it('does not quarantine below the short-close threshold', () => {
    const g = guard();
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 0 });
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 10 });

    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 20 }).deny).toBe(false);
    expect(g.getPairState(RELAY_A, REMOTE_A, 20)?.shortCloseCount).toBe(2);
  });

  it('does not quarantine long-lived relayed closes and clears prior penalty', () => {
    const g = guard();
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 0 });
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 10 });

    const result = g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 1_000, now: 20 });
    expect(result.cleared).toBe(true);
    expect(g.getPairState(RELAY_A, REMOTE_A, 20)).toBeUndefined();
  });

  it('isolates quarantine by both relay peer and remote peer', () => {
    const g = guard();
    recordShortBurst(g, RELAY_A, REMOTE_A);

    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 30 }).deny).toBe(true);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_B, now: 30 }).deny).toBe(false);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_B, remotePeerId: REMOTE_A, now: 30 }).deny).toBe(false);
  });

  it('expires quarantine and allows later relayed attempts', () => {
    const g = guard();
    recordShortBurst(g);

    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 219 }).deny).toBe(true);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 221 }).deny).toBe(false);
  });

  it('clears penalty after a stable direct close from the same remote peer', () => {
    const g = guard();
    recordShortBurst(g);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 25 }).deny).toBe(true);

    expect(g.recordDirectClose({ remotePeerId: REMOTE_A, durationMs: 1_000 })).toBe(1);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 30 }).deny).toBe(false);
  });

  it('does not clear relay penalty for short direct closes', () => {
    const g = guard();
    recordShortBurst(g);

    expect(g.recordDirectClose({ remotePeerId: REMOTE_A, durationMs: 50 })).toBe(0);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 30 }).deny).toBe(true);
  });
});
