import { describe, it, expect } from 'vitest';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { encodeStorageACK, computePublishACKDigest } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10, computeFlatKCMerkleLeafCountV10 } from '../src/merkle.js';
import { ethers } from 'ethers';

// Test H5 prefix inputs — must match what the collector passes into
// computePublishACKDigest so ecrecover locks onto the same digest bytes.
const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test') {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('ACKCollector', () => {
  const testCGId = 42n;
  const testCGIdStr = 'test-cg';
  const testQuads = [
    makeQuad('urn:a', 'urn:p', 'urn:o1'),
    makeQuad('urn:a', 'urn:p', 'urn:o2'),
  ];
  const merkleRoot = computeFlatKCRootV10(testQuads, []);
  const merkleLeafCount = computeFlatKCMerkleLeafCountV10(testQuads, []);

  async function signACK(
    wallet: ethers.Wallet,
    contextGraphId: bigint,
    root: Uint8Array,
    kaCount: number,
    byteSize: bigint,
    epochs: bigint = 1n,
    tokenAmount: bigint = 0n,
    leafCount: number = merkleLeafCount,
  ) {
    const digest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      contextGraphId,
      root,
      BigInt(kaCount),
      byteSize,
      epochs,
      tokenAmount,
      BigInt(leafCount),
    );
    const sig = ethers.Signature.from(await wallet.signMessage(digest));
    return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
  }

  const coreWallets = [
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
  ];

  it('collects 3 valid ACKs from core peers', async () => {
    const gossipCalls: Uint8Array[] = [];

    const deps: ACKCollectorDeps = {
      gossipPublish: async (_topic, data) => { gossipCalls.push(data); },
      sendP2P: async (peerId, _protocol, _data) => {
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const wallet = coreWallets[idx];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      merkleLeafCount,
    });

    expect(result.acks).toHaveLength(3);
    expect(gossipCalls).toHaveLength(0);
    expect(result.merkleRoot).toBe(merkleRoot);
    expect(result.contextGraphId).toBe(testCGId);

    for (const ack of result.acks) {
      expect(ack.signatureR).toBeInstanceOf(Uint8Array);
      expect(ack.signatureVS).toBeInstanceOf(Uint8Array);
      expect(ack.signatureR.length).toBe(32);
      expect(ack.signatureVS.length).toBe(32);
      expect(ack.nodeIdentityId).toBeGreaterThan(0n);
    }
  });

  it('deduplicates by peerId and nodeIdentityId', async () => {
    const peerIdentityMap: Record<string, number> = {
      'peer-0': 1,
      'peer-1': 2,
      'peer-2': 3,
      'peer-3': 4,
    };
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId) => {
        const walletIdx = Math.min(Object.keys(peerIdentityMap).indexOf(peerId), coreWallets.length - 1);
        const wallet = coreWallets[walletIdx >= 0 ? walletIdx : 0];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: peerIdentityMap[peerId] ?? 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      merkleLeafCount,
    });

    expect(result.acks).toHaveLength(3);
    const peerIds = new Set(result.acks.map(a => a.peerId));
    expect(peerIds.size).toBe(3);
    const identityIds = new Set(result.acks.map(a => a.nodeIdentityId));
    expect(identityIds.size).toBe(3);
  });

  it('fails if no connected peers', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => new Uint8Array(0),
      getConnectedCorePeers: () => [],
    };

    const collector = new ACKCollector(deps);
    await expect(collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      merkleLeafCount,
    })).rejects.toThrow('no connected core peers');
  });

  it('fails if only 2 peers respond', async () => {
    let callCount = 0;
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (_peerId) => {
        callCount++;
        if (callCount > 2) throw new Error('peer offline');
        const wallet = coreWallets[callCount - 1];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: callCount,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
    };

    const collector = new ACKCollector(deps);
    await expect(collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      merkleLeafCount,
    })).rejects.toThrow('storage_ack_insufficient');
  });

  // #887: a freshly-created CG's first SWM gossip push to its assigned
  // cores can land seconds after the publish ACK round starts. Cores
  // decline NO_DATA_IN_SWM (a transient code) until the data arrives.
  // The pre-#887 budget shared a single 3-attempt counter with transport
  // errors (~3s), so a peer that would have ACKed a few seconds later was
  // permanently dropped and the publish failed. These tests pin the
  // dedicated, larger transient-decline retry budget.
  function encodeDecline(code: string, message = 'SWM gossip catching up') {
    return encodeStorageACK({
      merkleRoot: new Uint8Array(),
      coreNodeSignatureR: new Uint8Array(),
      coreNodeSignatureVS: new Uint8Array(),
      contextGraphId: testCGIdStr,
      nodeIdentityId: 0,
      declineCode: code,
      declineMessage: message,
    });
  }

  it('retries transient NO_DATA_IN_SWM declines past the transport budget until SWM gossip lands (#887)', async () => {
    const callsByPeer = new Map<string, number>();
    // 4 declines is more than the old 3-attempt cap — pre-#887 every
    // peer would have been dropped here and quorum would never form.
    const DECLINES_BEFORE_ACK = 4;
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sleep: async () => {}, // collapse backoff so the test is instant
      sendP2P: async (peerId) => {
        const n = (callsByPeer.get(peerId) ?? 0) + 1;
        callsByPeer.set(peerId, n);
        if (n <= DECLINES_BEFORE_ACK) return encodeDecline('NO_DATA_IN_SWM');
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const { r, vs } = await signACK(coreWallets[idx], testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      merkleLeafCount,
    });

    expect(result.acks).toHaveLength(3);
    for (const peerId of ['peer-0', 'peer-1', 'peer-2']) {
      // 4 declines + 1 successful ACK = 5 sends; impossible under the
      // old 3-attempt budget.
      expect(callsByPeer.get(peerId)).toBe(DECLINES_BEFORE_ACK + 1);
    }
  });

  it('gives up on a transient decline that never clears, bounded by the retry budget (#887)', async () => {
    const callsByPeer = new Map<string, number>();
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sleep: async () => {},
      // Never recovers — the SWM data genuinely never shows up.
      sendP2P: async (peerId) => {
        callsByPeer.set(peerId, (callsByPeer.get(peerId) ?? 0) + 1);
        return encodeDecline('NO_DATA_IN_SWM');
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    await expect(collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      merkleLeafCount,
    })).rejects.toThrow('storage_ack_insufficient');

    for (const peerId of ['peer-0', 'peer-1', 'peer-2']) {
      // 1 initial attempt + MAX_TRANSIENT_DECLINE_RETRIES (6) = 7 sends,
      // then the peer is dropped. Proves the budget is bounded (no hang).
      expect(callsByPeer.get(peerId)).toBe(7);
    }
  });

  // PR #896 review (🟡): the widened #887 transient-decline budget (~31s)
  // must NOT keep a losing peer dialing after quorum has already formed
  // elsewhere. A peer still mid-retry when the last needed ACK lands must
  // bail on its next wake instead of burning its full budget — otherwise a
  // successful publish leaves ~30s of avoidable ACK traffic + log noise
  // running in the background after `collect()` returned.
  it('abandons transient-decline retries once quorum is reached elsewhere (#896)', async () => {
    const callsByPeer = new Map<string, number>();
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      // Collapse the collector's own backoff so an unfixed build would
      // race through all 7 transient-decline sends near-instantly.
      sleep: async () => {},
      sendP2P: async (peerId) => {
        callsByPeer.set(peerId, (callsByPeer.get(peerId) ?? 0) + 1);
        if (peerId === 'peer-3') {
          // The slow peer: its SWM is catching up, and each response
          // arrives well after the three fast cores have already formed
          // quorum. The real delay guarantees quorum is settled before
          // peer-3's first decline is processed, so the bail is
          // deterministic rather than scheduler-dependent.
          await new Promise((r) => setTimeout(r, 25));
          return encodeDecline('NO_DATA_IN_SWM');
        }
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const { r, vs } = await signACK(coreWallets[idx], testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      merkleLeafCount,
    });

    expect(result.acks).toHaveLength(3);
    // Let peer-3's in-flight decline resolve and the bail decision land.
    // A budget long enough that an unfixed build (which keeps retrying
    // after quorum) would have issued all 7 sends.
    await new Promise((r) => setTimeout(r, 300));
    // Fixed: peer-3 issued exactly its one in-flight dial, then bailed on
    // wake because quorum was already settled. Unfixed: it would have run
    // the full 1 + MAX_TRANSIENT_DECLINE_RETRIES = 7 sends.
    expect(callsByPeer.get('peer-3')).toBe(1);
  });

  it('rejects ACKs with wrong merkle root', async () => {
    const wrongRoot = new Uint8Array(32).fill(0xff);
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (_peerId, _protocol, _data) => {
        const wallet = coreWallets[0];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot: wrongRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    await expect(collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      merkleLeafCount,
    })).rejects.toThrow('storage_ack_insufficient');
  });
});
