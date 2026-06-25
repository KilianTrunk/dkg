// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { FallbackProvider, JsonRpcProvider } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';

const PK = '0x' + '1'.repeat(64);
const HUB = '0x0000000000000000000000000000000000000001';

// Constructing the adapter is offline (providers are lazy / never dialled), so
// these assertions need no live RPC — they exercise the backwards-compat split
// in the constructor: 1 endpoint => bare JsonRpcProvider (identical to the
// pre-multi-RPC path), >1 endpoint => FallbackProvider failover.
describe('multi-RPC provider shape (backwards compatibility)', () => {
  it('a single rpcUrl yields a bare JsonRpcProvider (no FallbackProvider)', () => {
    const a = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: HUB,
      privateKey: PK,
      allowNoAdminSigner: true,
    });
    const read = a.getReadProvider();
    expect(read).toBeInstanceOf(JsonRpcProvider);
    expect(read).not.toBeInstanceOf(FallbackProvider);
    expect(a.getRpcUrls()).toEqual(['http://127.0.0.1:1']);
  });

  it('multiple rpcUrls yield a FallbackProvider over all endpoints (primary first)', () => {
    const a = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      rpcUrls: ['http://127.0.0.1:2', 'http://127.0.0.1:3'],
      hubAddress: HUB,
      privateKey: PK,
      allowNoAdminSigner: true,
    });
    expect(a.getReadProvider()).toBeInstanceOf(FallbackProvider);
    expect(a.getRpcUrls()).toEqual(['http://127.0.0.1:1', 'http://127.0.0.1:2', 'http://127.0.0.1:3']);
  });

  it('dedupes a backup that repeats the primary (no redundant provider)', () => {
    const a = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      rpcUrls: ['http://127.0.0.1:1'],
      hubAddress: HUB,
      privateKey: PK,
      allowNoAdminSigner: true,
    });
    // Collapses to a single unique endpoint -> no FallbackProvider.
    expect(a.getReadProvider()).not.toBeInstanceOf(FallbackProvider);
    expect(a.getRpcUrls()).toEqual(['http://127.0.0.1:1']);
  });
});
