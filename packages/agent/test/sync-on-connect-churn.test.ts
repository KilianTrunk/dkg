import { describe, expect, it } from 'vitest';
import { PROTOCOL_SYNC } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { CATCHUP_ON_CONNECT_COOLDOWN_MS, SYNC_RECONNECT_FLAP_GRACE_MS } from '../src/dkg-agent-constants.js';
import { runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function createUnstartedAgent(name: string): Promise<DKGAgent> {
  return DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(),
  });
}

const noopLog = (_ctx: OperationContext, _message: string) => {};

describe('sync-on-connect churn gates', () => {
  it('dedupes repeated reconnect scheduling across a short relay flap', async () => {
    const agent = await createUnstartedAgent('SyncReconnectFlapDedup');
    const calls: string[] = [];
    (agent as any).runSyncFromPeerOnConnect = async (peerId: string) => {
      calls.push(peerId);
    };

    const handleSyncError = () => undefined;
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(true);
    const firstQueuedAt = (agent as any).catchupOnConnectAt.get(PEER_A);

    (agent as any).lastSyncDisconnectedAt.set(PEER_A, Date.now() - Math.floor(SYNC_RECONNECT_FLAP_GRACE_MS / 2));
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(false);
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, handleSyncError, 0)).toBe(false);
    expect((agent as any).catchupOnConnectAt.get(PEER_A)).toBe(firstQueuedAt);

    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('allows reconnect catch-up after a meaningful offline gap', async () => {
    const agent = await createUnstartedAgent('SyncReconnectOfflineGap');
    const calls: string[] = [];
    (agent as any).runSyncFromPeerOnConnect = async (peerId: string) => {
      calls.push(peerId);
    };

    const lastDisconnected = Date.now() - SYNC_RECONNECT_FLAP_GRACE_MS - 100;
    const beforeDisconnect = lastDisconnected - 1;
    (agent as any).lastSuccessfulSyncAt.set(PEER_A, beforeDisconnect);
    (agent as any).catchupOnConnectAt.set(PEER_A, beforeDisconnect);
    (agent as any).lastSyncDisconnectedAt.set(PEER_A, lastDisconnected);

    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(true);
    expect((agent as any).catchupOnConnectAt.get(PEER_A)).toBeGreaterThan(lastDisconnected);

    await flushTimers();
    expect(calls).toEqual([PEER_A]);
  });

  it('reconciler still retries stale connected peers', async () => {
    const agent = await createUnstartedAgent('SyncReconcilerStillRetries');
    (agent as any).started = true;
    (agent.node as any).node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    const trySyncFromPeer = recorder(async () => undefined);
    (agent as any).trySyncFromPeer = trySyncFromPeer;

    await (agent as any).reconcileSyncFromConnectedPeers();
    await flushTimers();

    expect(trySyncFromPeer.calls).toEqual([[PEER_A, expect.any(Function)]]);
  });

  it('records backoff after a failed sync round and blocks connection-open rescheduling', async () => {
    const agent = await createUnstartedAgent('SyncReconnectBackoff');
    (agent as any).started = true;
    (agent.node as any).node = {
      getPeers: () => [{ toString: () => PEER_A }],
      getConnections: () => [],
    };
    (agent as any).getPeerProtocols = async () => [PROTOCOL_SYNC];
    (agent as any).trySyncFromPeer = async () => 'synced';

    await (agent as any).runSyncFromPeerOnConnect(PEER_A, () => undefined);

    const backoff = (agent as any).syncReconcilerBackoff.get(PEER_A);
    expect(backoff?.failures).toBe(1);
    expect(backoff?.nextRetryAt).toBeGreaterThan(Date.now());

    const staleQueuedAt = Date.now() - CATCHUP_ON_CONNECT_COOLDOWN_MS - 1;
    (agent as any).catchupOnConnectAt.set(PEER_A, staleQueuedAt);
    expect((agent as any).queueSyncFromPeerOnConnect(PEER_A, () => undefined, 0)).toBe(false);
    expect((agent as any).catchupOnConnectAt.get(PEER_A)).toBe(staleQueuedAt);
  });

  it('skips SWM sync-on-connect fanout when no CG is locally eligible', async () => {
    const syncSharedMemoryFromPeer = recorder(async () => 0);

    const outcome = await runSyncOnConnect({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['unauthorized-cg'],
      getSharedMemorySyncContextGraphs: () => [],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(syncSharedMemoryFromPeer.calls).toEqual([]);
  });

  it('preserves successful SWM sync-on-connect for eligible CGs', async () => {
    const syncSharedMemoryFromPeer = recorder(async () => 0);

    const outcome = await runSyncOnConnect({
      remotePeer: PEER_A,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      getSyncContextGraphs: () => ['eligible-cg'],
      getSharedMemorySyncContextGraphs: () => ['eligible-cg'],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer,
      logInfo: noopLog,
    });

    expect(outcome).toBe('synced');
    expect(syncSharedMemoryFromPeer.calls).toEqual([[PEER_A, ['eligible-cg']]]);
  });
});
