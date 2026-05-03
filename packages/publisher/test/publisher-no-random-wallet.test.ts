/**
 * Regression test: DKGPublisher must NOT auto-mint a random publisher wallet
 * when no `publisherPrivateKey` is supplied.
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
 * `publisherWallet` undefined; every signing call site is already guarded
 * by `if (this.publisherWallet)` and skips gracefully.
 */
import { describe, it, expect } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';

// Minimal stub — DKGPublisher's constructor only reads `chain.chainId`.
// All other ChainAdapter methods are unused in this test.
function makeStubChain(chainId: string): ChainAdapter {
  return { chainId } as unknown as ChainAdapter;
}

describe('DKGPublisher: no random publisher wallet without explicit key', () => {
  it('leaves publisherWallet undefined when chain is enabled but no key supplied', async () => {
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('test-evm-chain'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: '0x000000000000000000000000000000000000dEaD',
    });

    // Cast to any so we can assert on the private field — the regression we
    // are guarding against is exactly that this field used to be a freshly
    // generated random wallet, which is observable here.
    expect((publisher as any).publisherWallet).toBeUndefined();
    expect((publisher as any).publisherAddress).toBe('0x000000000000000000000000000000000000dEaD');
  });

  it('leaves publisherWallet undefined when chain is disabled and no key supplied', async () => {
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('none'),
      eventBus: new TypedEventBus(),
      keypair,
    });

    expect((publisher as any).publisherWallet).toBeUndefined();
  });

  it('still constructs publisherWallet when an explicit key is supplied', async () => {
    const keypair = await generateEd25519Keypair();
    // Deterministic test-only key (not used elsewhere in the suite).
    const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
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
});
