/**
 * Per-wallet nonce serialization for the two V10 write paths
 * (`publishToContextGraph`, `updateKnowledgeCollectionV10`) — both route
 * through the private `dispatchSerializedV10Write` seam.
 *
 * Regression guard for OriginTrail/dkg#953: the round-robin signer pool can
 * hand the SAME operational wallet to two concurrent writes; without
 * serialization both read the same `pending` nonce before either broadcasts,
 * so the second reverts "Nonce too low" and the publish degrades to a
 * tentative kaId:0. These tests drive the actual seam (private methods reached
 * via `as any`, the same convention the rest of evm-adapter.unit.test.ts uses)
 * so deleting the `signerTxSerializer.run(...)` wrap turns the suite red.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b63b91100';
const ADMIN_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    adminPrivateKey: ADMIN_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    ...overrides,
  };
}

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const neverNull = (): never => {
  throw new Error('unexpected null receipt');
};
const fakeReceipt = (hash: string) =>
  ({ hash, blockNumber: 1, index: 0, status: 1, logs: [] }) as unknown as ethers.TransactionReceipt;

describe('dispatchSerializedV10Write — per-wallet nonce serialization (#953)', () => {
  it('serializes concurrent writes routed to the SAME wallet (no overlapping send windows)', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    const events: string[] = [];
    const build = (id: string) => async () => {
      events.push(`build:${id}`);
      await tick(10);
      return { signedTx: `tx-${id}`, txHash: `0x${id}` };
    };
    (a as any).sendSignedTransactionAndWait = vi.fn(async (signedTx: string) => {
      events.push(`send:${signedTx}`);
      await tick(10);
      events.push(`done:${signedTx}`);
      return fakeReceipt(signedTx);
    });

    await Promise.all([
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build('a'), neverNull),
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build('b'), neverNull),
    ]);

    // The entire build → send → done of 'a' must complete before 'b' starts.
    expect(events).toEqual([
      'build:a', 'send:tx-a', 'done:tx-a',
      'build:b', 'send:tx-b', 'done:tx-b',
    ]);
  });

  it('runs writes to DIFFERENT wallets concurrently', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const s1 = new ethers.Wallet(DEPLOYER_PK);
    const s2 = new ethers.Wallet(OTHER_PK);
    expect(s1.address).not.toBe(s2.address);
    const events: string[] = [];
    const build = (id: string) => async () => {
      events.push(`build:${id}`);
      await tick(20);
      return { signedTx: `tx-${id}`, txHash: `0x${id}` };
    };
    (a as any).sendSignedTransactionAndWait = vi.fn(async (signedTx: string) => fakeReceipt(signedTx));

    await Promise.all([
      (a as any).dispatchSerializedV10Write(s1, 'publish', undefined, build('a'), neverNull),
      (a as any).dispatchSerializedV10Write(s2, 'publish', undefined, build('b'), neverNull),
    ]);

    // Both builds started before either finished → genuinely concurrent.
    expect(events.slice(0, 2).sort()).toEqual(['build:a', 'build:b']);
  });

  it('keeps the pending nonce monotonic for same-wallet writes (the #953 regression guard)', async () => {
    // Model the real chain: `buildSignedTx` reads the wallet's pending nonce,
    // `sendSignedTransactionAndWait` "broadcasts" it (the nonce must equal the
    // current pending count, then it increments). Without per-wallet
    // serialization, the three concurrent reads all see pending=0 and the
    // later broadcasts throw "Nonce too low" → Promise.all rejects.
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    let pending = 0;
    const build = () => async () => {
      const nonce = pending; // read pending
      await tick(5); // populate / sign gap
      return { signedTx: String(nonce), txHash: `0x${nonce}` };
    };
    (a as any).sendSignedTransactionAndWait = vi.fn(async (signedTx: string) => {
      const nonce = Number(signedTx);
      await tick(5);
      if (nonce !== pending) {
        throw new Error(`Nonce too low: expected ${pending} but got ${nonce}`);
      }
      pending += 1;
      return fakeReceipt(signedTx);
    });

    const receipts = await Promise.all([
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build(), neverNull),
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build(), neverNull),
      (a as any).dispatchSerializedV10Write(signer, 'publish', undefined, build(), neverNull),
    ]);

    expect(receipts.map((r) => r.hash)).toEqual(['0', '1', '2']);
    expect(pending).toBe(3);
  });

  it('fails closed when the WAL onBroadcast hook throws — never broadcasts', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    const send = vi.fn(async () => fakeReceipt('0xsent'));
    (a as any).sendSignedTransactionAndWait = send;
    const onBroadcast = vi.fn(async () => {
      throw new Error('WAL disk full');
    });

    await expect(
      (a as any).dispatchSerializedV10Write(
        signer,
        'publish',
        onBroadcast,
        async () => ({ signedTx: 'tx', txHash: '0xpre' }),
        neverNull,
      ),
    ).rejects.toThrow('chain:writeahead hook failed before publish broadcast: WAL disk full');
    expect(send).not.toHaveBeenCalled();
  });

  it('a failed write does not wedge the wallet — the next same-wallet write still runs', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    (a as any).sendSignedTransactionAndWait = vi.fn(async (signedTx: string) => {
      if (signedTx === 'boom') throw new Error('broadcast failed');
      return fakeReceipt(signedTx);
    });

    await expect(
      (a as any).dispatchSerializedV10Write(
        signer,
        'publish',
        undefined,
        async () => ({ signedTx: 'boom', txHash: '0x1' }),
        neverNull,
      ),
    ).rejects.toThrow('broadcast failed');

    const r = await (a as any).dispatchSerializedV10Write(
      signer,
      'publish',
      undefined,
      async () => ({ signedTx: 'ok', txHash: '0x2' }),
      neverNull,
    );
    expect(r.hash).toBe('ok');
  });

  it('invokes onNullReceipt with the pre-broadcast tx hash when the receipt is null', async () => {
    const a = new EVMChainAdapter(minimalConfig());
    const signer = new ethers.Wallet(DEPLOYER_PK);
    (a as any).sendSignedTransactionAndWait = vi.fn(async () => null);

    await expect(
      (a as any).dispatchSerializedV10Write(
        signer,
        'update',
        undefined,
        async () => ({ signedTx: 'tx', txHash: '0xPRE' }),
        (pre: string): never => {
          throw new Error(`null receipt for ${pre}`);
        },
      ),
    ).rejects.toThrow('null receipt for 0xPRE');
  });
});
