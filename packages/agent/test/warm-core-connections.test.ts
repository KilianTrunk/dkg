import { describe, it, expect } from 'vitest';
import {
  selectWarmCoreCandidates,
  reconcileWarmCoreConnections,
  type WarmCoreAgent,
  type WarmCoreDeps,
} from '../src/p2p/warm-core-connections.js';

describe('selectWarmCoreCandidates', () => {
  it('keeps only nodeRole=core, drops self, dedupes, preserves order', () => {
    const agents: WarmCoreAgent[] = [
      { peerId: 'edge1', nodeRole: 'edge' },
      { peerId: 'core1', nodeRole: 'core' },
      { peerId: 'self', nodeRole: 'core' },
      { peerId: 'core2', nodeRole: 'core' },
      { peerId: 'core1', nodeRole: 'core' }, // dup
      { peerId: 'noRole' },
    ];
    expect(selectWarmCoreCandidates(agents, 'self').map((a) => a.peerId)).toEqual([
      'core1',
      'core2',
    ]);
  });

  it('returns empty when there are no cores', () => {
    expect(selectWarmCoreCandidates([{ peerId: 'e', nodeRole: 'edge' }], 'self')).toEqual([]);
  });
});

/** Build deps with sensible spies; override per test. */
function makeDeps(overrides: Partial<WarmCoreDeps> = {}): {
  deps: WarmCoreDeps;
  dialed: string[];
  pinned: string[];
  unpinned: string[];
} {
  const dialed: string[] = [];
  const pinned: string[] = [];
  const unpinned: string[] = [];
  const deps: WarmCoreDeps = {
    selfPeerId: 'self',
    maxCores: 8,
    findCoreAgents: async () => [
      { peerId: 'core1', nodeRole: 'core', agentAddress: '0x1' },
      { peerId: 'core2', nodeRole: 'core', agentAddress: '0x2' },
      { peerId: 'edge1', nodeRole: 'edge', agentAddress: '0x3' },
    ],
    isShardingTableCore: async () => true,
    isConnected: () => false,
    pin: async (peerId) => {
      pinned.push(peerId);
    },
    unpin: async (peerId) => {
      unpinned.push(peerId);
    },
    dial: async (peerId) => {
      dialed.push(peerId);
      return true;
    },
    log: () => undefined,
    ...overrides,
  };
  return { deps, dialed, pinned, unpinned };
}

describe('reconcileWarmCoreConnections', () => {
  it('pins + dials all gated cores when none are connected', async () => {
    const { deps, dialed, pinned } = makeDeps();
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ candidates: 2, pinned: 2, dialed: 2, skippedGate: 0, unpinned: 0 });
    expect(dialed).toEqual(['core1', 'core2']);
    expect(pinned).toEqual(['core1', 'core2']);
  });

  it('skips cores that fail the ShardingTable gate', async () => {
    const { deps, dialed } = makeDeps({
      isShardingTableCore: async (addr) => addr === '0x1',
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 1, dialed: 1, skippedGate: 1 });
    expect(dialed).toEqual(['core1']);
  });

  it('still pins (tags) an already-connected core, but does not redial it', async () => {
    // Regression: a connected core MUST be tagged keep-alive so libp2p
    // auto-redials it after a disconnect — the old `continue` skipped pinning.
    const { deps, dialed, pinned } = makeDeps({ isConnected: (id) => id === 'core1' });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 2, dialed: 1 });
    expect(pinned).toEqual(['core1', 'core2']); // both tagged
    expect(dialed).toEqual(['core2']); // only the disconnected one dialed
  });

  it('honors the maxCores cap, counting only gated cores', async () => {
    const { deps, dialed } = makeDeps({
      maxCores: 1,
      findCoreAgents: async () => [
        { peerId: 'core1', nodeRole: 'core', agentAddress: '0x1' },
        { peerId: 'core2', nodeRole: 'core', agentAddress: '0x2' },
        { peerId: 'core3', nodeRole: 'core', agentAddress: '0x3' },
      ],
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res.pinned).toBe(1);
    expect(dialed).toEqual(['core1']);
  });

  it('treats a throwing gate as a denial (does not pin)', async () => {
    const { deps, dialed } = makeDeps({
      isShardingTableCore: async () => {
        throw new Error('rpc down');
      },
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 0, dialed: 0, skippedGate: 2 });
    expect(dialed).toEqual([]);
  });

  it('counts a failed dial as pinned-but-not-dialed', async () => {
    const { deps } = makeDeps({ dial: async () => false });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 2, dialed: 0 });
  });

  it('unpins cores that were warm last pass but are no longer selected', async () => {
    // Regression: the keep-alive tag must be removed when a core drops out of
    // the candidate/gated set, else pins leak and drift above maxCores.
    const { deps, unpinned } = makeDeps({
      previouslyWarmed: new Set(['core1', 'core2', 'gone1', 'gone2']),
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res.pinned).toBe(2);
    expect(res.unpinned).toBe(2);
    expect(unpinned.sort()).toEqual(['gone1', 'gone2']);
    // the returned warmed set is what the caller carries into the next pass
    expect([...res.warmed].sort()).toEqual(['core1', 'core2']);
  });

  it('unpins a core that newly fails the gate (cap-drift guard)', async () => {
    const { deps, unpinned } = makeDeps({
      previouslyWarmed: new Set(['core1', 'core2']),
      isShardingTableCore: async (addr) => addr === '0x1', // core2 now ungated
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 1, skippedGate: 1, unpinned: 1 });
    expect(unpinned).toEqual(['core2']);
  });
});
