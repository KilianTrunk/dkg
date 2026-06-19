import { describe, it, expect } from 'vitest';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import {
  computePublishACKDigest,
  encodePublishIntent,
  decodeStorageACK,
  isStorageACKDecline,
  STORAGE_ACK_DECLINE_CODES,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';

/**
 * Issue #1124 / PR #1239 — the *end-state* demonstration Branimir asked for.
 *
 * The PR's stated purpose is "public CGs **reach** storage-ACK quorum." The
 * agent-side gate fix (`isConfirmedPublicForHostMode` admitting a self-signed
 * public plaintext on a non-member host) is *necessary*, but the review's open
 * question was whether it is *sufficient*: does the quorum actually become
 * reachable on a host-mode sharded topology whose storage cores are
 * NON-MEMBERS of the CG?
 *
 * That sub-scenario can't be reproduced on a small all-staked devnet, because
 * there every core is a member of every *registered* CG (live: a CG-4 publish
 * reached quorum with every ACK tagged `source=member`, including the
 * host-mode node). So this proves it deterministically at the layer that
 * actually decides quorum, wiring the REAL `ACKCollector` to REAL
 * `StorageACKHandler`s over REAL stores.
 *
 * The load-bearing architectural fact: `StorageACKHandlerConfig` has NO
 * membership input. A core signs a quorum-eligible ACK iff (role=core ∧
 * data-present-in-SWM ∧ merkle-matches ∧ signer-registered) — membership is
 * never consulted. So a non-member host that obtained the public plaintext
 * purely via the #1124 host-mode ingest contributes an ACK identical to a
 * member's. These cores are seeded EXACTLY as the host-mode ingest seeds them:
 * the public plaintext written into `<cg>/_shared_memory` (the same graph
 * `loadSWMQuads` reads). No membership, no on-chain shard assignment.
 */
const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

const contextGraphId = '77';
const cgIdBigInt = 77n;
const swmGraphUri = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;

function makeQuad(s: string, p: string, o: string): Quad {
  return { subject: s, predicate: p, object: o, graph: swmGraphUri };
}

// The public plaintext a host-mode non-member core ingested off gossip.
const publicQuads: Quad[] = [
  makeQuad('urn:public:asset:1', 'http://schema.org/name', '"Public Knowledge Asset"'),
  makeQuad('urn:public:asset:1', 'http://schema.org/description', '"reachable-quorum-demo"'),
  makeQuad('urn:public:asset:1', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'urn:test:Asset'),
];
const merkleRoot = computeFlatKCRoot(publicQuads, []);
const merkleLeafCount = computeFlatKCMerkleLeafCountV10(publicQuads, []);
const publicByteSize = BigInt(publicQuads.length * 100);

const noopBus = { emit: () => {}, on: () => {}, off: () => {}, once: () => {} };

/**
 * Build N non-member host-mode core handlers. `seeded=true` mimics the
 * post-#1124 world (the gate admitted + stored the public plaintext);
 * `seeded=false` mimics the pre-#1124 world (the gate dropped it, SWM empty).
 */
async function makeNonMemberCores(count: number, seeded: boolean) {
  const wallets = Array.from({ length: count }, () => ethers.Wallet.createRandom());
  const handlers = [];
  for (let i = 0; i < count; i++) {
    const store = new OxigraphStore();
    if (seeded) {
      // EXACTLY what `ingestSwmHostModeEnvelope` writes for a public CG: the
      // plaintext quads into `<cg>/_shared_memory`. Nothing about membership.
      await store.insert(publicQuads.map((q) => ({ ...q })));
    }
    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: BigInt(i + 1),
      signerWallet: wallets[i],
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      // No `isCgCurated`, no membership hook — these are plain non-member hosts.
    };
    handlers.push(new StorageACKHandler(store as any, config, noopBus as any));
  }
  return { wallets, handlers };
}

function makeCollector(handlers: StorageACKHandler[]) {
  const peers = handlers.map((_, i) => `host-${i}`);
  const deps: ACKCollectorDeps = {
    gossipPublish: async () => {},
    sendP2P: async (peerId, _protocol, data) => {
      const idx = parseInt(peerId.replace('host-', ''), 10);
      return handlers[idx].handler(data, { toString: () => peerId });
    },
    getConnectedCorePeers: () => peers,
    log: () => {},
  };
  return new ACKCollector(deps);
}

const collectArgs = {
  merkleRoot,
  contextGraphId: cgIdBigInt,
  contextGraphIdStr: contextGraphId,
  publisherPeerId: 'publisher-edge',
  publicByteSize,
  isPrivate: false,
  kaCount: 1,
  rootEntities: [] as string[],
  chainId: TEST_CHAIN_ID,
  kav10Address: TEST_KAV10_ADDR,
  merkleLeafCount,
};

describe('#1124 end-state: public-CG quorum is REACHED purely via non-member host-mode cores', () => {
  it('POST-FIX — 3 non-member hosts holding the host-mode-ingested plaintext reach quorum with valid signed ACKs', async () => {
    const { wallets, handlers } = await makeNonMemberCores(3, /* seeded */ true);
    const collector = makeCollector(handlers);

    const result = await collector.collect({ ...collectArgs });

    // Quorum (DEFAULT_REQUIRED_ACKS = 3) reached entirely from non-members.
    expect(result.acks).toHaveLength(3);

    // Every ACK is a real EIP-191 signature over the canonical V10 publish
    // digest, recovering to one of the non-member host signers — i.e. each is
    // a consensus-valid, on-chain-submittable ACK, not a courtesy response.
    const digest = computePublishACKDigest(
      TEST_CHAIN_ID, TEST_KAV10_ADDR, cgIdBigInt, merkleRoot,
      1n, publicByteSize, 1n, 0n, BigInt(merkleLeafCount),
    );
    const prefixedHash = ethers.hashMessage(digest);
    const hostAddresses = wallets.map((w) => w.address.toLowerCase());
    for (const ack of result.acks) {
      const recovered = ethers.recoverAddress(prefixedHash, {
        r: ethers.hexlify(ack.signatureR),
        yParityAndS: ethers.hexlify(ack.signatureVS),
      });
      expect(hostAddresses).toContain(recovered.toLowerCase());
    }
  });

  it('PRE-FIX (negative control) — with the plaintext DROPPED (empty SWM) every host DECLINEs NO_DATA, the quorum-blocking signal', async () => {
    // This is the #1124 failure mode: the gate dropped the self-signed public
    // plaintext, SWM stayed empty. Each host then returns NO_DATA_IN_SWM — a
    // permanent decline the collector cannot count, so quorum is unreachable.
    // Asserting it at the handler layer (vs. burning the collector's ~31s
    // retry-then-fail budget) pins the exact decline AND proves the seeded
    // data above — not some membership side-channel — is what makes quorum
    // reachable.
    const { handlers } = await makeNonMemberCores(3, /* seeded */ false);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-edge',
      publicByteSize: Number(publicByteSize),
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      merkleLeafCount,
    });
    for (const handler of handlers) {
      const decoded = decodeStorageACK(await handler.handler(intent, { toString: () => 'publisher-edge' }));
      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
    }
  });
});
