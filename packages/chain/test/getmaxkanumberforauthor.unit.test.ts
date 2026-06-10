/**
 * `EVMChainAdapter.getMaxKaNumberForAuthor` — OT-RFC-43 Option 1 / issue #1080.
 *
 * Verifies the wiring of the on-chain getter:
 *   1. Prefers the O(1) `getMaxKaNumberForAuthor(address) -> int256` view (a
 *      single eth_call) and does NOT scan logs when the view answers.
 *   2. Falls back to a PAGINATED, RPC-safe (<= 2000-block window) log scan when
 *      the view is absent or the selector call cannot be decoded on older
 *      deployments. The fallback must never use the old unbounded
 *      `queryFilter(filter, 0)` shape that overflowed provider eth_getLogs caps.
 *   3. Propagates transient RPC failures instead of hiding them behind a
 *      historical crawl on the same provider.
 *
 * Private state is injected via `as any`, the same convention the rest of the
 * chain unit tests use.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
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

const AUTHOR = ethers.getAddress('0x1111111111111111111111111111111111111111');
const pack = (n: bigint) => (BigInt(AUTHOR) << 96n) | n; // packed kaId for AUTHOR
const EMPTY_VIEW_RESULT = 'could not decode result data (value="0x", info={ method: "getMaxKaNumberForAuthor", signature: "getMaxKaNumberForAuthor(address)" }, code=BAD_DATA, version=6.16.0)';

/** A ContractMethod-shaped mock: a function carrying a `.staticCall`. */
function viewMock(impl: () => Promise<bigint>) {
  const fn: any = vi.fn();
  fn.staticCall = vi.fn(impl);
  return fn;
}

function makeAdapter(storage: any, head = 0) {
  const a = new EVMChainAdapter(minimalConfig());
  storage.target ??= '0x2222222222222222222222222222222222222222';
  (a as any).contracts = { knowledgeAssetStorage: storage };
  // getMaxKaNumberForAuthor now `await this.init()`s first (re-resolve handles
  // on Hub rotation). Mark initialized so init() short-circuits and the injected
  // mock handle is used; the post-rotation test below exercises the
  // initialized=false re-resolution path explicitly.
  (a as any).initialized = true;
  (a as any).provider = {
    getBlockNumber: vi.fn(async () => head),
    getCode: vi.fn(async () => '0x6000'),
  };
  return a;
}

describe('EVMChainAdapter.getMaxKaNumberForAuthor — view + bounded fallback (#1080)', () => {
  it('uses the O(1) on-chain view and never scans logs when the view answers', async () => {
    const queryFilter = vi.fn();
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => 5n),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 9_999_999);

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(5n);
    expect(storage.getMaxKaNumberForAuthor.staticCall).toHaveBeenCalledTimes(1);
    expect(storage.getMaxKaNumberForAuthor.staticCall).toHaveBeenCalledWith(AUTHOR);
    expect(queryFilter).not.toHaveBeenCalled();
    expect((a as any).provider.getBlockNumber).not.toHaveBeenCalled();
  });

  it('returns -1n for a never-minted author (allocator next number = 0)', async () => {
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => -1n),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter: vi.fn(),
    };
    expect(await makeAdapter(storage).getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    expect(storage.queryFilter).not.toHaveBeenCalled();
  });

  it('falls back to a paginated bounded scan when the view is absent', async () => {
    const head = 5_000;
    const queryFilter = vi.fn(async (_f: unknown, lo: number, hi: number) =>
      lo <= 2500 && 2500 <= hi ? [{ args: { id: pack(7n) } }] : [],
    );
    const storage = {
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head);

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(7n);
    expect(queryFilter).toHaveBeenCalledTimes(3);
    for (const [, lo, hi] of queryFilter.mock.calls as unknown as [unknown, number, number][]) {
      expect(typeof lo).toBe('number');
      expect(typeof hi).toBe('number');
      expect(hi - lo + 1).toBeLessThanOrEqual(2000);
    }
    expect(queryFilter.mock.calls).toEqual([
      ['F', 0, 1999],
      ['F', 2000, 3999],
      ['F', 4000, 5000],
    ]);
  });

  it('falls back to the bounded scan when an older deployment cannot decode the view result', async () => {
    const badData: any = new Error(EMPTY_VIEW_RESULT);
    badData.code = 'BAD_DATA';
    const view = viewMock(async () => {
      throw badData;
    });
    const queryFilter = vi.fn(async () => [{ args: { id: pack(3n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: view,
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };

    expect(await makeAdapter(storage, 1_500).getMaxKaNumberForAuthor(AUTHOR)).toBe(3n);
    expect(view.staticCall).toHaveBeenCalledTimes(1);
    expect(queryFilter).toHaveBeenCalledWith('F', 0, 1500);
  });

  it('fails loudly instead of scanning empty logs when the resolved storage address has no code', async () => {
    const badData: any = new Error(EMPTY_VIEW_RESULT);
    badData.code = 'BAD_DATA';
    const queryFilter = vi.fn(async () => []);
    const storage = {
      target: '0x3333333333333333333333333333333333333333',
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw badData;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    (a as any).provider.getCode.mockResolvedValueOnce('0x');

    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow(
      'no contract code is deployed there',
    );
    expect((a as any).provider.getCode).toHaveBeenCalledWith(storage.target);
    expect(queryFilter).not.toHaveBeenCalled();
    expect((a as any).provider.getBlockNumber).not.toHaveBeenCalled();
  });

  it('returns -1n when neither the view nor legacy logs yields a number', async () => {
    const storage = {
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter: vi.fn(async () => []),
    };
    expect(await makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
  });

  it('rethrows a transient RPC error from the view instead of crawling logs', async () => {
    const err: any = new Error('rate limited');
    err.code = 'SERVER_ERROR';
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('rate limited');
    expect(queryFilter).not.toHaveBeenCalled();
  });

  it('rethrows non-selector CALL_EXCEPTION errors instead of treating them as absent view', async () => {
    const err: any = new Error('execution reverted: Paused');
    err.code = 'CALL_EXCEPTION';
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('Paused');
    expect(queryFilter).not.toHaveBeenCalled();
  });

  it('re-resolves the DKGKnowledgeAssets handle after a Hub rotation rather than querying the stale pre-rotation contract (#1082 review)', async () => {
    // Long-lived adapter after the 10.0.4 redeploy: the rotation listener has
    // set `initialized = false` but the cached binding still points at the OLD
    // contract. The getter must `await this.init()` to re-resolve before
    // reading, or it answers from the pre-rotation DKGKnowledgeAssets.
    const mkStorage = (n: bigint) => ({
      getMaxKaNumberForAuthor: viewMock(async () => n),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter: vi.fn(),
      target: '0x2222222222222222222222222222222222222222',
    });
    const stale = mkStorage(99n);
    const fresh = mkStorage(7n);

    const a = new EVMChainAdapter(minimalConfig());
    (a as any).contracts = { knowledgeAssetStorage: stale };
    (a as any).initialized = false; // post-rotation: handles need re-resolving
    (a as any).provider = {
      getBlockNumber: vi.fn(async () => 0),
      getCode: vi.fn(async () => '0x6000'),
    };
    // What the real init() does on a re-init: swap in the fresh binding.
    const init = vi.fn(async () => {
      (a as any).contracts.knowledgeAssetStorage = fresh;
      (a as any).initialized = true;
    });
    (a as any).init = init;

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(7n); // FRESH, not stale 99n
    expect(init).toHaveBeenCalledTimes(1);
    expect(fresh.getMaxKaNumberForAuthor.staticCall).toHaveBeenCalledTimes(1);
    expect(stale.getMaxKaNumberForAuthor.staticCall).not.toHaveBeenCalled();
  });

  it('rethrows malformed BAD_DATA instead of treating every decode failure as an absent view', async () => {
    const err: any = new Error(
      'could not decode result data (value="0x1234", info={ method: "getMaxKaNumberForAuthor", signature: "getMaxKaNumberForAuthor(address)" }, code=BAD_DATA, version=6.16.0)',
    );
    err.code = 'BAD_DATA';
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage = {
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    await expect(
      makeAdapter(storage, 100).getMaxKaNumberForAuthor(AUTHOR),
    ).rejects.toThrow('0x1234');
    expect(queryFilter).not.toHaveBeenCalled();
  });

  // #1080 follow-up: a pre-10.0.4 deployment that lacks the selector reverts with
  // CALL_EXCEPTION / "missing revert data" on RPCs like Base Sepolia (no BAD_DATA
  // shape). That is the user-observed failure: it MUST fall back to the scan, not
  // rethrow — but only once the deployed bytecode confirms the selector is absent.
  const VIEW_SELECTOR = '0xe9ed840f'; // getMaxKaNumberForAuthor(address)
  const ifaceWithSelector = { getFunction: () => ({ selector: VIEW_SELECTOR }) };

  it('falls back when a pre-10.0.4 deployment reverts with missing-revert-data and the selector is ABSENT from bytecode', async () => {
    const err: any = new Error(
      'missing revert data (action="call", data=null, reason=null, code=CALL_EXCEPTION, version=6.16.0)',
    );
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = null;
    const queryFilter = vi.fn(async () => [{ args: { id: pack(4n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 1_500);
    (a as any).provider.getCode = vi.fn(async () => '0x6000'); // code, but no selector

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(4n);
    expect(queryFilter).toHaveBeenCalledWith('F', 0, 1500);
  });

  it('rethrows missing-revert-data when the view selector IS present in the deployed bytecode (genuine bare revert)', async () => {
    const err: any = new Error('missing revert data');
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = null;
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    (a as any).provider.getCode = vi.fn(async () => `0x600063${VIEW_SELECTOR.slice(2)}6001`); // PUSH4 <selector> dispatcher entry

    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('missing revert data');
    expect(queryFilter).not.toHaveBeenCalled();
  });

  it('treats a coincidental selector byte-run (no PUSH4 prefix) as absent and falls back, not rethrow', async () => {
    const err: any = new Error('missing revert data');
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = null;
    const queryFilter = vi.fn(async () => [{ args: { id: pack(5n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 1_000);
    // selector bytes present in a constant/metadata blob, but NOT as a `63<selector>` dispatcher entry
    (a as any).provider.getCode = vi.fn(async () => `0x60ff${VIEW_SELECTOR.slice(2)}00`);
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(5n); // view is genuinely absent → scan
    expect(queryFilter).toHaveBeenCalled();
  });

  it('anchors the fallback scan at the contract deploy block, not genesis (#1080 — avoids a 2,000-cap full-history crawl)', async () => {
    const head = 42_650_000;
    const deployBlock = 42_410_000; // ~240k blocks of lifetime => ~120 pages, not ~21k
    const queryFilter = vi.fn(async () => []);
    const storage: any = {
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head); // no view fn => straight to fallback
    // historical getCode: '0x' before deploy, code at/after deploy
    (a as any).provider.getCode = vi.fn(async (_addr: string, block?: number) =>
      block === undefined || block >= deployBlock ? '0x6000' : '0x',
    );

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    const firstLo = (queryFilter.mock.calls[0] as unknown as [unknown, number, number])[1];
    const lastHi = (queryFilter.mock.calls.at(-1) as unknown as [unknown, number, number])[2];
    expect(firstLo).toBe(deployBlock); // anchored, NOT 0
    expect(lastHi).toBe(head);
    // ~120 pages over the contract's lifetime, far below a from-genesis ~21k.
    expect(queryFilter.mock.calls.length).toBe(Math.ceil((head - deployBlock + 1) / 2000));
    expect(queryFilter.mock.calls.length).toBeLessThan(200);
  });

  it('fails loudly (no storm) when the anchored fallback would exceed the eth_getLogs page budget', async () => {
    const head = 80_000_000;
    const queryFilter = vi.fn(async () => []);
    const storage: any = {
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, head);
    (a as any).provider.getCode = vi.fn(async (_addr: string, block?: number) =>
      block === undefined || block >= 0 ? '0x6000' : '0x',
    ); // deploys at genesis => ~40k pages, over the cap

    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow(/eth_getLogs calls|deploy DKGKnowledgeAssets >= 10\.0\.4/);
    expect(queryFilter).not.toHaveBeenCalled();
  });

  // Pin the hasRevertPayload early-return in isKaHighWaterBareRevert: a
  // CALL_EXCEPTION whose message contains "missing revert data" but which
  // carries a reason/data is a GENUINE revert from an existing view and must
  // rethrow, not fall back — even though its message matches the bare shape.
  it('rethrows a CALL_EXCEPTION that says missing-revert-data but carries a reason (genuine revert)', async () => {
    const err: any = new Error('missing revert data: execution reverted');
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = 'Paused';
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    (a as any).provider.getCode = vi.fn(async () => '0x6000'); // selector absent — must STILL rethrow
    // hasRevertPayload trips on the `reason` even though the message matches the
    // bare shape and the selector is absent → rethrown (the original error), not scanned.
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('missing revert data');
    expect(queryFilter).not.toHaveBeenCalled();
  });

  it('rethrows a CALL_EXCEPTION that says missing-revert-data but carries revert data (genuine revert)', async () => {
    const err: any = new Error('missing revert data');
    err.code = 'CALL_EXCEPTION';
    err.data = '0x08c379a0000000000000000000000000000000000000000000000000000000000000'; // Error(string) selector
    err.reason = null;
    const queryFilter = vi.fn(async () => [{ args: { id: pack(9n) } }]);
    const storage: any = {
      interface: ifaceWithSelector,
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 100);
    (a as any).provider.getCode = vi.fn(async () => '0x6000');
    await expect(a.getMaxKaNumberForAuthor(AUTHOR)).rejects.toThrow('missing revert data');
    expect(queryFilter).not.toHaveBeenCalled();
  });

  it('binary-searches the deploy block once and reuses the cached value on later calls', async () => {
    const head = 100_000;
    const deployBlock = 90_000;
    const queryFilter = vi.fn(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: vi.fn(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, head);
    const getCode = vi.fn(async (_addr: string, block?: number) =>
      block === undefined || block >= deployBlock ? '0x6000' : '0x',
    );
    (a as any).provider.getCode = getCode;

    await a.getMaxKaNumberForAuthor(AUTHOR);
    const searchCalls1 = getCode.mock.calls.filter((c) => c.length === 2).length;
    expect(searchCalls1).toBeGreaterThan(0); // first call binary-searches
    expect((a as any).cachedKaStorageDeployBlock).toEqual({ address: storage.target, value: deployBlock });

    getCode.mockClear();
    await a.getMaxKaNumberForAuthor(AUTHOR);
    expect(getCode.mock.calls.filter((c) => c.length === 2).length).toBe(0); // cache hit: no second search
  });

  it('falls back (not rethrow) on a bare revert when the view selector cannot be derived from the interface', async () => {
    const err: any = new Error('missing revert data');
    err.code = 'CALL_EXCEPTION';
    err.data = null;
    err.reason = null;
    const queryFilter = vi.fn(async () => [{ args: { id: pack(2n) } }]);
    const storage: any = {
      interface: {
        getFunction: () => {
          throw new Error('no matching fragment');
        },
      },
      getMaxKaNumberForAuthor: viewMock(async () => {
        throw err;
      }),
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = makeAdapter(storage, 1_000);
    (a as any).provider.getCode = vi.fn(async () => '0x6000');
    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(2n); // un-derivable selector => treat as absent => scan
    expect(queryFilter).toHaveBeenCalled();
  });

  it('degrades to a genesis-anchored scan (not a hard fail) when historical getCode is unavailable, never anchoring above deploy', async () => {
    const head = 100_000; // short chain: from-0 is within budget (51 pages)
    const queryFilter = vi.fn(async () => []);
    const storage: any = { filters: { KnowledgeAssetCreated: vi.fn(() => 'F') }, queryFilter };
    const a = makeAdapter(storage, head);
    // latest getCode (1 arg) confirms code; historical getCode (2 args) throws (pruned/non-archive RPC)
    (a as any).provider.getCode = vi.fn(async (_addr: string, block?: number) => {
      if (block !== undefined) throw new Error('missing trie node (pruned node)');
      return '0x6000';
    });

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n); // still scans — pruned RPCs serve queryFilter
    expect((queryFilter.mock.calls[0] as unknown as [unknown, number, number])[1]).toBe(0); // genesis (safe lower bound, never above deploy)
    expect((a as any).cachedKaStorageDeployBlock).toBeUndefined(); // degraded anchor not cached
  });

  it('uses the configurable kaHighWaterScanPageSize window for the fallback scan', async () => {
    const head = 30_000;
    const queryFilter = vi.fn(async () => []);
    const storage: any = {
      target: '0x2222222222222222222222222222222222222222',
      filters: { KnowledgeAssetCreated: vi.fn(() => 'F') },
      queryFilter,
    };
    const a = new EVMChainAdapter(minimalConfig({ kaHighWaterScanPageSize: 10_000 }));
    (a as any).contracts = { knowledgeAssetStorage: storage };
    (a as any).initialized = true;
    (a as any).provider = {
      getBlockNumber: vi.fn(async () => head),
      getCode: vi.fn(async () => '0x6000'),
    };

    expect(await a.getMaxKaNumberForAuthor(AUTHOR)).toBe(-1n);
    // 10,000-block window (not the 2,000 default): first page is [0, 9999], 4 pages total over 30k blocks.
    expect((queryFilter.mock.calls[0] as unknown as [unknown, number, number])[2]).toBe(9_999);
    expect(queryFilter.mock.calls.length).toBe(Math.ceil((head + 1) / 10_000));
  });
});
