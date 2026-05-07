import { describe, it, expect } from 'vitest';
import { isMultiaddrRemotelyDialable } from '../src/ui/components/Modals/ShareProjectModal.js';

// Pure unit test for the invite-ready gate. The full ShareProjectModal
// renders against /api/status; here we only exercise the multiaddr
// classifier so it stays in sync with the ranges enumerated in
// `isMultiaddrRemotelyDialable`'s JSDoc as the heuristic gets revised.

describe('isMultiaddrRemotelyDialable', () => {
  describe('dialable', () => {
    it('accepts circuit-relay multiaddrs (NAT\'d edge node case)', () => {
      const addr = '/ip4/49.12.4.64/tcp/9090/p2p/12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ/p2p-circuit/p2p/12D3KooWEw3Xh7KuDwRDSuhbpTpA5PeN58gchyQqQ321YYeppmXj';
      expect(isMultiaddrRemotelyDialable(addr)).toBe(true);
    });
    it('accepts public IPv4 + tcp', () => {
      expect(isMultiaddrRemotelyDialable('/ip4/178.156.252.147/tcp/9090/p2p/12D3Koo...')).toBe(true);
    });
    it('accepts dns / dns4 / dnsaddr', () => {
      expect(isMultiaddrRemotelyDialable('/dns4/relay.example.com/tcp/443/p2p/12D3Koo...')).toBe(true);
      expect(isMultiaddrRemotelyDialable('/dnsaddr/example.com/p2p/12D3Koo...')).toBe(true);
    });
    it('accepts global-unicast IPv6', () => {
      expect(isMultiaddrRemotelyDialable('/ip6/2a01:4ff:f4:843b::1/tcp/9090/p2p/12D3Koo...')).toBe(true);
    });
  });

  describe('not dialable (the invite-ready gate refuses these)', () => {
    it('rejects loopback IPv4', () => {
      expect(isMultiaddrRemotelyDialable('/ip4/127.0.0.1/tcp/57550/p2p/12D3Koo...')).toBe(false);
    });
    it('rejects RFC1918 ranges', () => {
      expect(isMultiaddrRemotelyDialable('/ip4/10.0.0.5/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/172.16.0.1/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/172.31.255.255/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/192.168.0.171/tcp/57550/p2p/12D3Koo...')).toBe(false);
    });
    it('rejects link-local + CGNAT', () => {
      expect(isMultiaddrRemotelyDialable('/ip4/169.254.1.5/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip4/100.105.212.110/tcp/57550/p2p/12D3Koo...')).toBe(false);
    });
    it('rejects loopback + link-local + ULA IPv6', () => {
      expect(isMultiaddrRemotelyDialable('/ip6/::1/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip6/fe80::1/tcp/9090/p2p/12D3Koo...')).toBe(false);
      expect(isMultiaddrRemotelyDialable('/ip6/fc00::1/tcp/9090/p2p/12D3Koo...')).toBe(false);
    });
    it('rejects garbage / empty', () => {
      expect(isMultiaddrRemotelyDialable('')).toBe(false);
      expect(isMultiaddrRemotelyDialable('not-a-multiaddr')).toBe(false);
    });
  });
});
