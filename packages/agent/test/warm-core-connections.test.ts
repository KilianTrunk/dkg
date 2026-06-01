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
} {
  const dialed: string[] = [];
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
    pinAndDial: async (peerId) => {
      dialed.push(peerId);
      return true;
    },
    log: () => undefined,
    ...overrides,
  };
  return { deps, dialed };
}

describe('reconcileWarmCoreConnections', () => {
  it('pins + dials all gated cores when none are connected', async () => {
    const { deps, dialed } = makeDeps();
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ candidates: 2, pinned: 2, dialed: 2, skippedGate: 0 });
    expect(dialed).toEqual(['core1', 'core2']);
  });

  it('skips cores that fail the ShardingTable gate', async () => {
    const { deps, dialed } = makeDeps({
      isShardingTableCore: async (addr) => addr === '0x1',
    });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 1, dialed: 1, skippedGate: 1 });
    expect(dialed).toEqual(['core1']);
  });

  it('pins but does not redial cores that are already connected', async () => {
    const { deps, dialed } = makeDeps({ isConnected: (id) => id === 'core1' });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 2, dialed: 1 });
    expect(dialed).toEqual(['core2']);
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
    const { deps } = makeDeps({ pinAndDial: async () => false });
    const res = await reconcileWarmCoreConnections(deps);
    expect(res).toMatchObject({ pinned: 2, dialed: 0 });
  });
});
