/**
 * Regression test: DKGPublisher must NOT auto-mint a random publisher wallet
 * when no `publisherPrivateKey` is supplied, and must not use the zero
 * address as a placeholder publisher.
 *
 * Background
 * ----------
 * Pre-fix behaviour generated `ethers.Wallet.createRandom()` whenever
 * `chain.chainId !== 'none'` and no key was supplied. The resulting wallet
 * was used to sign on-chain publish digests, ACK self-signatures, and
 * authorship proofs — all attributed (by `publisherAddress`) to whatever
 * address the caller had passed in separately. So signatures looked
 * authoritative but were verifiably-junk: signed by a throw-away key the
 * caller had never seen.
 *
 * This is the same anti-pattern that destroyed nine testnet admin keys via
 * `ensureProfile` (see `scripts/audit-create-random.mjs` header). Fix and
 * test both land in the same PR. The constructor now leaves
 * `publisherWallet` undefined; publish now requires either an explicit local
 * signing key or a configured adapter signer bound to a non-zero publisher
 * address before it can create ACKs, publisher signatures, or authorship
 * proofs. Local tentative/no-chain publishes never use the zero address; when
 * no EVM publisher address exists, they use a deterministic non-zero address
 * derived from the agent keypair solely for tentative metadata/UAL scoping.
 */
import { describe, it, expect } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { MockChainAdapter, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// Minimal stub — DKGPublisher's constructor only reads `chain.chainId`.
// All other ChainAdapter methods are unused in this test.
function makeStubChain(chainId: string): ChainAdapter {
  return { chainId } as unknown as ChainAdapter;
}

class AdapterSigningChain extends MockChainAdapter {
  constructor(private readonly wallet: ethers.Wallet) {
    super('mock:31337', wallet.address);
    this.seedIdentity(wallet.address, 1n);
    this.minimumRequiredSignatures = 1;
  }

  override async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }
}

describe('DKGPublisher: no random publisher wallet without explicit key', () => {
  it('leaves publisherWallet and publisherAddress undefined when no key or address is supplied', async () => {
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('test-evm-chain'),
      eventBus: new TypedEventBus(),
      keypair,
    });

    // Cast to any so we can assert on the private field — the regression we
    // are guarding against is exactly that this field used to be a freshly
    // generated random wallet, which is observable here.
    expect((publisher as any).publisherWallet).toBeUndefined();
    expect((publisher as any).publisherAddress).toBeUndefined();
  });

  it('publishes tentatively with a deterministic non-zero local address when no publisher address is configured', async () => {
    const keypair = await generateEd25519Keypair();
    const chain = {
      ...makeStubChain('test-evm-chain'),
      getRequiredPublishTokenAmount: async () => {
        throw new Error('RPC unavailable');
      },
    } as ChainAdapter;
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    });

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:no-address',
        predicate: 'http://schema.org/name',
        object: '"NoAddress"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    const match = result.ual.match(/^did:dkg:test-evm-chain\/(0x[0-9a-fA-F]{40})\/t/);
    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(match?.[1]).toBeDefined();
    expect(match![1]).not.toBe(ethers.ZeroAddress);
  });

  it('publishes tentatively with an explicit non-zero publisherAddress when no on-chain signer is needed', async () => {
    const keypair = await generateEd25519Keypair();
    const publisherAddress = '0x000000000000000000000000000000000000dEaD';
    const chain = {
      ...makeStubChain('test-evm-chain'),
      getRequiredPublishTokenAmount: async () => {
        throw new Error('RPC unavailable');
      },
    } as ChainAdapter;
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress,
    });

    expect((publisher as any).publisherWallet).toBeUndefined();
    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:no-key',
        predicate: 'http://schema.org/name',
        object: '"NoKey"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(result.ual.toLowerCase()).toContain(publisherAddress.toLowerCase());
  });

  it('rejects a zero publisherAddress instead of treating it as a sentinel', async () => {
    const keypair = await generateEd25519Keypair();
    expect(() => new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('test-evm-chain'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: '0x0000000000000000000000000000000000000000',
    })).toThrow(/zero address/i);
  });

  it('still constructs publisherWallet when an explicit key is supplied', async () => {
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('test-evm-chain'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: TEST_KEY,
    });
    const wallet = (publisher as any).publisherWallet;
    expect(wallet).toBeDefined();
    expect(wallet.address.toLowerCase()).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    expect((publisher as any).publisherAddress.toLowerCase()).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
  });

  it('rejects publisherAddress values that do not match the supplied private key', async () => {
    const keypair = await generateEd25519Keypair();

    expect(() => new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('test-evm-chain'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: TEST_KEY,
      publisherAddress: '0x000000000000000000000000000000000000dEaD',
    })).toThrow(/does not match publisherPrivateKey signer/i);
  });

  it('publishes with an adapter-backed signer when a non-zero publisherAddress is configured', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterSigningChain(wallet);
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: wallet.address,
      publisherNodeIdentityId: 1n,
    });

    expect((publisher as any).publisherWallet).toBeUndefined();
    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-signer',
        predicate: 'http://schema.org/name',
        object: '"AdapterSigner"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('updates with an adapter-backed signer and configured publisherAddress', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterSigningChain(wallet);
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: wallet.address,
      publisherNodeIdentityId: 1n,
    });

    const created = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-update',
        predicate: 'http://schema.org/name',
        object: '"Before"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    const updated = await publisher.update(created.kcId, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-update',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(updated.status).toBe('confirmed');
    expect(updated.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});
