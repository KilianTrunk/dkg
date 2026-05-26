/**
 * PR3 / RC11 — guard for the `isLikelyPublicRpc` helper that drives
 * the daemon startup WARN when `chain.rpcUrl` is inherited from
 * `network/<env>.json` and points at a known-public endpoint. The
 * WARN is informational, but the helper itself must NOT mis-flag a
 * private endpoint just because it happens to share a substring with
 * a public host's path segment.
 */
import { describe, it, expect } from 'vitest';
import { isLikelyPublicRpc } from '../src/daemon.js';

describe('isLikelyPublicRpc (PR3 / RC11 — startup WARN on inherited public RPC)', () => {
  it.each([
    'https://sepolia.base.org',
    'https://mainnet.base.org',
    'https://rpc.sepolia.org',
    'https://ethereum-sepolia.publicnode.com',
    'https://rpc.ankr.com/eth_sepolia',
    'https://eth-sepolia.public.blastapi.io',
    'https://sepolia.gateway.tenderly.co/foo',
    'HTTPS://Sepolia.Base.ORG',
  ])('flags well-known public endpoint %s', (url) => {
    expect(isLikelyPublicRpc(url)).toBe(true);
  });

  it.each([
    'https://my-private-alchemy.alchemyapi.io/v2/abc123',
    'https://eth-rpc.my-company.example/sepolia',
    'http://127.0.0.1:8545',
    'https://infura.io/v3/private-key',
    'http://localhost:8545',
  ])('does NOT flag private/private-relayed endpoint %s', (url) => {
    expect(isLikelyPublicRpc(url)).toBe(false);
  });
});
