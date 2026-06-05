import { describe, it, expect } from 'vitest';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import {
  encodeUpdateIntent,
  decodeStorageACK,
  computeUpdateACKDigest,
  isStorageACKDecline,
  STORAGE_ACK_DECLINE_CODES,
  PROTOCOL_STORAGE_UPDATE_ACK,
  TypedEventBus,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('V10 UPDATE StorageACK — peer handler + collector quorum', () => {
  const contextGraphId = '42';
  const cgIdBigInt = 42n;
  const kaId = 987654321n;
  const preUpdateMerkleRootCount = 1n;
  const newTokenAmount = 1500n;
  const mintAmount = 0n;
  const burnTokenIds: bigint[] = [];

  const updatedQuads: Quad[] = [
    makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
    makeQuad('urn:entity:1', 'urn:p', 'urn:o2-updated'),
    makeQuad('urn:entity:2', 'urn:p', 'urn:o3'),
  ];
  const newMerkleRoot = computeFlatKCRoot(updatedQuads, []);
  const newMerkleLeafCount = computeFlatKCMerkleLeafCountV10(updatedQuads, []);
  // 4-term N-Quad serialization, same as the publisher's update() path.
  const nquadsStr = updatedQuads
    .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`)
    .join('\n');
  const stagingQuads = new TextEncoder().encode(nquadsStr);
  const newByteSize = BigInt(stagingQuads.length);

  const fakePeerId = { toString: () => 'publisher-peer' };

  function makeConfig(wallet: ethers.Wallet, identityId: bigint): StorageACKHandlerConfig {
    return {
      nodeRole: 'core',
      nodeIdentityId: identityId,
      signerWallet: wallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      isCgCurated: async () => true,
    };
  }

  function buildIntent(): Uint8Array {
    return encodeUpdateIntent({
      kaId: kaId.toString(),
      contextGraphId,
      preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
      newMerkleRoot,
      newByteSize: Number(newByteSize),
      newTokenAmount: newTokenAmount.toString(),
      mintAmount: Number(mintAmount),
      burnTokenIds: burnTokenIds.map((b) => b.toString()),
      newMerkleLeafCount,
      publisherPeerId: 'publisher-0',
      stagingQuads,
    });
  }

  function expectedDigest(): Uint8Array {
    return computeUpdateACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      cgIdBigInt,
      kaId,
      preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintAmount,
      burnTokenIds,
      BigInt(newMerkleLeafCount),
    );
  }

  it('peer signs computeUpdateACKDigest and the signature recovers to the operational key', async () => {
    const wallet = ethers.Wallet.createRandom();
    const handler = new StorageACKHandler(
      new OxigraphStore() as any,
      makeConfig(wallet, 42n),
      new TypedEventBus() as any,
    );

    const response = await handler.updateHandler(buildIntent(), fakePeerId);
    const ack = decodeStorageACK(response);
    expect(isStorageACKDecline(ack)).toBe(false);

    // merkleRoot field carries newMerkleRoot.
    const decodedRoot = ack.merkleRoot instanceof Uint8Array ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(decodedRoot).equals(Buffer.from(newMerkleRoot))).toBe(true);

    const recovered = ethers.recoverAddress(ethers.hashMessage(expectedDigest()), {
      r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
      yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
    });
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('declines with MERKLE_MISMATCH_IN_SWM when newMerkleRoot does not match the quads', async () => {
    const wallet = ethers.Wallet.createRandom();
    const handler = new StorageACKHandler(
      new OxigraphStore() as any,
      makeConfig(wallet, 42n),
      new TypedEventBus() as any,
    );
    const wrongRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('wrong')));
    const intent = encodeUpdateIntent({
      kaId: kaId.toString(),
      contextGraphId,
      preUpdateMerkleRootCount: Number(preUpdateMerkleRootCount),
      newMerkleRoot: wrongRoot,
      newByteSize: Number(newByteSize),
      newTokenAmount: newTokenAmount.toString(),
      newMerkleLeafCount,
      publisherPeerId: 'publisher-0',
      stagingQuads,
    });
    const ack = decodeStorageACK(await handler.updateHandler(intent, fakePeerId));
    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
  });

  it('collectUpdate reaches a 3-of-4 quorum, recovering each signer against the update digest', async () => {
    const coreWallets = [
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
    ];
    // One real handler instance per peer (distinct signer + identity).
    const handlers = coreWallets.map((w, i) =>
      new StorageACKHandler(new OxigraphStore() as any, makeConfig(w, BigInt(i + 1)), new TypedEventBus() as any),
    );

    const recoveredByPeer = new Map<string, string>();
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId, protocol, data) => {
        expect(protocol).toBe(PROTOCOL_STORAGE_UPDATE_ACK);
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        return handlers[idx].updateHandler(data, { toString: () => peerId });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
      // Pre-flight: accept every signer; record the recovered address so we
      // can assert the collector recovered the correct operational keys.
      verifyIdentity: async (recoveredAddress, identityId) => {
        recoveredByPeer.set(identityId.toString(), recoveredAddress);
        return true;
      },
      log: () => {},
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collectUpdate({
      kaId,
      contextGraphId: cgIdBigInt,
      preUpdateMerkleRootCount,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintAmount,
      burnTokenIds,
      newMerkleLeafCount,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      publisherPeerId: 'publisher-0',
      requiredACKs: 3,
      stagingQuads,
    });

    expect(result.acks).toHaveLength(3);
    expect(result.contextGraphId).toBe(cgIdBigInt);
    expect(Buffer.from(result.merkleRoot).equals(Buffer.from(newMerkleRoot))).toBe(true);
    for (const ack of result.acks) {
      expect(ack.signatureR.length).toBe(32);
      expect(ack.signatureVS.length).toBe(32);
      expect(ack.nodeIdentityId).toBeGreaterThan(0n);
      // Each collected identity recovered to its core wallet.
      const idx = Number(ack.nodeIdentityId) - 1;
      expect(recoveredByPeer.get(ack.nodeIdentityId.toString())?.toLowerCase()).toBe(
        coreWallets[idx].address.toLowerCase(),
      );
    }
  });

  it('collectUpdate throws QuorumUnmet when fewer peers than required can sign', async () => {
    const coreWallets = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
    const handlers = coreWallets.map((w, i) =>
      new StorageACKHandler(new OxigraphStore() as any, makeConfig(w, BigInt(i + 1)), new TypedEventBus() as any),
    );
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId, _protocol, data) => {
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        return handlers[idx].updateHandler(data, { toString: () => peerId });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1'],
      verifyIdentity: async () => true,
      log: () => {},
    };
    const collector = new ACKCollector(deps);
    await expect(
      collector.collectUpdate({
        kaId,
        contextGraphId: cgIdBigInt,
        preUpdateMerkleRootCount,
        newMerkleRoot,
        newByteSize,
        newTokenAmount,
        mintAmount,
        burnTokenIds,
        newMerkleLeafCount,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        publisherPeerId: 'publisher-0',
        requiredACKs: 3,
        stagingQuads,
      }),
    ).rejects.toThrow(/quorum impossible/i);
  });
});
