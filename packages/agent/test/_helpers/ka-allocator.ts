/**
 * OT-RFC-43 Option-1 (variant 1a) — test-side KA-number allocator factory for
 * agent tests.
 *
 * The real EVM adapter now REQUIRES a packed
 *   reservedKaId = (uint160(author) << 96) | number
 * per V10 mint. `DKGAgent` only allocates one when `kaNumberAllocator` is set
 * on its config (it forwards it to the publisher as `kaAllocator`); otherwise
 * the real adapter throws "reservedKaId is required". Real-chain agent tests
 * therefore wire an allocator.
 *
 * This reuses the production `KaNumberAllocator` (packages/agent/src/allocator)
 * backed by an in-memory `KaNumberStore` (mirrors the durable
 * `SqliteKaNumberStore` contract: monotonic-from-0 numbers, never reclaimed,
 * `reconcileFloor` raises but never lowers). The agent's publish path calls
 * `reconcile()` + `markReconciled()` before `allocate()` on first use per
 * author, so the allocator does not need to be pre-reconciled here.
 */
import type { KaNumberStore } from '@origintrail-official/dkg-core';
import { KaNumberAllocator } from '../../src/allocator.js';

/** In-memory `KaNumberStore` matching the `SqliteKaNumberStore` contract. */
class InMemoryKaNumberStore implements KaNumberStore {
  private readonly next = new Map<string, number>();

  allocate(authorAddress: string): number {
    const key = authorAddress.toLowerCase();
    const current = this.next.get(key) ?? 0;
    this.next.set(key, current + 1);
    return current;
  }

  reconcileFloor(authorAddress: string, nextNumberFloor: number): void {
    const key = authorAddress.toLowerCase();
    const current = this.next.get(key) ?? 0;
    this.next.set(key, Math.max(current, nextNumberFloor));
  }

  peekNext(authorAddress: string): number {
    return this.next.get(authorAddress.toLowerCase()) ?? 0;
  }
}

/**
 * Build a fresh `KaNumberAllocator` over an in-memory store. A fresh allocator
 * per agent keeps per-author state from leaking across snapshot/revert
 * boundaries between tests.
 */
export function makeTestKaNumberAllocator(): KaNumberAllocator {
  return new KaNumberAllocator(new InMemoryKaNumberStore());
}
