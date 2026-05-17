import { describe, it, expect, vi } from 'vitest';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import {
  encodePublishIntent, decodeStorageACK, computePublishACKDigest,
  isStorageACKDecline, STORAGE_ACK_DECLINE_CODES,
} from '@origintrail-official/dkg-core';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';

// Test H5 prefix inputs — must match whatever `StorageACKHandlerConfig`
// carries so that the ACK digest the test computes equals the one the
// handler computes. The handler rejects non-numeric / zero CG ids
// (production guard), so the test CG id is a plain numeric string.
const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('StorageACKHandler', () => {
  const contextGraphId = '42';
  const cgIdBigInt = 42n;

  const swmQuads: Quad[] = [
    makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
    makeQuad('urn:entity:1', 'urn:p', 'urn:o2'),
    makeQuad('urn:entity:2', 'urn:p', 'urn:o3'),
  ];
  const merkleRoot = computeFlatKCRoot(swmQuads, []);
  const swmMerkleLeafCount = computeFlatKCMerkleLeafCountV10(swmQuads, []);

  const coreWallet = ethers.Wallet.createRandom();
  const coreIdentityId = 42n;
  const fakePeerId = { toString: () => 'publisher-peer' };

  async function createHandler(
    storeQuads: Quad[],
    configOverrides: Partial<StorageACKHandlerConfig> = {},
  ) {
    const store = new OxigraphStore();

    const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
    if (storeQuads.length > 0) {
      await store.insert(
        storeQuads.map(q => ({ ...q, graph: swmGraph })),
      );
    }

    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: coreIdentityId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      ...configOverrides,
    };

    return new StorageACKHandler(store as any, config, new TypedEventBus() as any);
  }

  it('returns valid StorageACK for matching data', async () => {
    const handler = await createHandler(swmQuads);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(ack.contextGraphId).toBe(contextGraphId);

    const decodedRoot = ack.merkleRoot instanceof Uint8Array
      ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(decodedRoot).equals(Buffer.from(merkleRoot))).toBe(true);

    const digest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      cgIdBigInt,
      merkleRoot,
      2n,
      300n,
      1n,
      1000n,
      BigInt(swmMerkleLeafCount),
    );
    const prefixedHash = ethers.hashMessage(digest);
    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array
        ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
      yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array
        ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
    });
    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());
  });

  it('declines (SIGNER_NOT_REGISTERED) when the signer is no longer confirmed registered', async () => {
    // PR #557: this used to throw, which the publisher saw as a libp2p
    // stream reset; now the handler returns a typed decline so the
    // collector can record the reason and skip retries against this
    // peer.
    const handler = await createHandler(swmQuads, {
      isSignerRegistered: async () => false,
    });
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED);
    expect(decoded.declineMessage).toContain('not confirmed on-chain');
  });

  it('refuses to sign when signer registration lookup fails', async () => {
    const lookupFailed = vi.fn();
    const unregistered = vi.fn();
    const handler = await createHandler(swmQuads, {
      isSignerRegistered: async () => { throw new Error('rpc unavailable'); },
      onSignerRegistrationLookupFailed: lookupFailed,
      onSignerUnregistered: unregistered,
    });
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
    });

    await expect(handler.handler(intent, fakePeerId)).rejects.toThrow(
      'StorageACK signer registration lookup failed; refusing to sign',
    );
    expect(lookupFailed).toHaveBeenCalledOnce();
    expect(unregistered).not.toHaveBeenCalled();
  });

  it('declines (NO_DATA_IN_SWM) when SWM has no data', async () => {
    // PR #557: this is the exact #541 path. Used to throw → stream reset
    // → publisher retried 3× → quorum failed → on-chain
    // MinSignaturesRequirementNotMet. Now decline → publisher records
    // the reason and surfaces it in the final error.
    const handler = await createHandler([]);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1'],
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
    expect(decoded.declineMessage).toContain('No data found in SWM');
    expect(decoded.declineMessage).toContain('urn:entity:1');
  });

  it('declines (MERKLE_MISMATCH_IN_SWM) when SWM data does not match the publisher merkle root', async () => {
    const differentQuads = [makeQuad('urn:other', 'urn:p', 'urn:val')];
    const handler = await createHandler(differentQuads);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(decoded.declineMessage).toContain('Merkle root mismatch');
  });

  it('rejects non-core node role', async () => {
    const store = new OxigraphStore();
    const config: StorageACKHandlerConfig = {
      nodeRole: 'edge',
      nodeIdentityId: 1n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: () => 'urn:test',
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };

    const handler = new StorageACKHandler(store as any, config, new TypedEventBus() as any);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Only core nodes can issue StorageACKs');
  });
});
