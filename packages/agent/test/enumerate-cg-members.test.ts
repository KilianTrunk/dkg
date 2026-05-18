import { describe, it, expect } from 'vitest';
import {
  createCGMemberEnumerator,
  type CGMemberEnumeratorDeps,
} from '../src/swm/enumerate-cg-members.js';

const SELF = '12D3KooWSelf';

function makeDeps(overrides: Partial<CGMemberEnumeratorDeps>): CGMemberEnumeratorDeps {
  return {
    getContextGraphAllowedPeers: async () => null,
    getTopicSubscribers: () => [],
    topicForCG: (cgId) => `dkg/context-graph/${cgId}/shared-memory`,
    selfPeerId: SELF,
    ...overrides,
  };
}

describe('createCGMemberEnumerator: curated CG (allowlist source)', () => {
  it('returns allowlist members and excludes self', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => ['peerA', 'peerB', SELF, 'peerC'],
    }));

    const result = await enumerator.enumerate('cg-curated-1');

    expect(result.source).toBe('allowlist');
    expect(result.members.sort()).toEqual(['peerA', 'peerB', 'peerC']);
  });

  it('preserves source=allowlist even when allowlist is empty', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => [],
      getTopicSubscribers: () => ['shouldNotAppearPeer'],
    }));

    const result = await enumerator.enumerate('cg-curated-empty');

    expect(result.source).toBe('allowlist');
    expect(result.members).toEqual([]);
  });

  it('does not consult topic subscribers when an allowlist exists', async () => {
    let subscribersCalled = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => ['peerA'],
      getTopicSubscribers: () => {
        subscribersCalled += 1;
        return ['peerB'];
      },
    }));

    await enumerator.enumerate('cg-curated-2');

    expect(subscribersCalled).toBe(0);
  });

  it('dedupes a curated allowlist that contains duplicates', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => ['peerA', 'peerA', 'peerB', 'peerA'],
    }));

    const result = await enumerator.enumerate('cg-curated-dups');

    expect(result.members.sort()).toEqual(['peerA', 'peerB']);
  });
});

describe('createCGMemberEnumerator: public CG (topic-subscribers source)', () => {
  it('falls through to topic subscribers when allowlist is null', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => null,
      getTopicSubscribers: (topic) => {
        expect(topic).toBe('dkg/context-graph/cg-public-1/shared-memory');
        return ['peerX', 'peerY'];
      },
    }));

    const result = await enumerator.enumerate('cg-public-1');

    expect(result.source).toBe('topic-subscribers');
    expect(result.members.sort()).toEqual(['peerX', 'peerY']);
  });

  it('excludes self from topic subscribers', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => null,
      getTopicSubscribers: () => [SELF, 'peerY'],
    }));

    const result = await enumerator.enumerate('cg-public-2');

    expect(result.source).toBe('topic-subscribers');
    expect(result.members).toEqual(['peerY']);
  });
});

describe('createCGMemberEnumerator: legacy / unknown CG (none source)', () => {
  it('returns source=none and empty members when no allowlist + no subscribers', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => null,
      getTopicSubscribers: () => [],
    }));

    const result = await enumerator.enumerate('cg-bootstrap');

    expect(result).toEqual({ source: 'none', members: [] });
  });
});

describe('createCGMemberEnumerator: TTL cache', () => {
  it('returns cached value within TTL without re-calling deps', async () => {
    let allowedCalls = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => {
        allowedCalls += 1;
        return ['peerA'];
      },
    }));

    await enumerator.enumerate('cg-cached');
    await enumerator.enumerate('cg-cached');
    await enumerator.enumerate('cg-cached');

    expect(allowedCalls).toBe(1);
  });

  it('recomputes after TTL elapses', async () => {
    let allowedCalls = 0;
    let nowMs = 1_000_000;
    const enumerator = createCGMemberEnumerator(makeDeps({
      now: () => nowMs,
      cacheTtlMs: 1000,
      getContextGraphAllowedPeers: async () => {
        allowedCalls += 1;
        return ['peerA'];
      },
    }));

    await enumerator.enumerate('cg-ttl');
    nowMs += 500;
    await enumerator.enumerate('cg-ttl');
    expect(allowedCalls).toBe(1);

    nowMs += 600;
    await enumerator.enumerate('cg-ttl');
    expect(allowedCalls).toBe(2);
  });

  it('isolates cache per cgId', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async (cgId) => {
        if (cgId === 'cg-1') return ['peerA'];
        if (cgId === 'cg-2') return ['peerB'];
        return null;
      },
    }));

    const a = await enumerator.enumerate('cg-1');
    const b = await enumerator.enumerate('cg-2');

    expect(a.members).toEqual(['peerA']);
    expect(b.members).toEqual(['peerB']);
    expect(enumerator.size()).toBe(2);
  });

  it('invalidate() forces a fresh resolution on the next call', async () => {
    let nthCall = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => {
        nthCall += 1;
        return nthCall === 1 ? ['peerOld'] : ['peerNew'];
      },
    }));

    const first = await enumerator.enumerate('cg-invalidate');
    expect(first.members).toEqual(['peerOld']);

    const cached = await enumerator.enumerate('cg-invalidate');
    expect(cached.members).toEqual(['peerOld']);

    enumerator.invalidate('cg-invalidate');
    const refreshed = await enumerator.enumerate('cg-invalidate');
    expect(refreshed.members).toEqual(['peerNew']);
  });

  it('invalidate() on an unknown cgId is a no-op', () => {
    const enumerator = createCGMemberEnumerator(makeDeps({}));
    expect(() => enumerator.invalidate('never-seen')).not.toThrow();
  });
});

describe('createCGMemberEnumerator: source label transitions', () => {
  it('reflects the live source whenever recompute fires (post-TTL)', async () => {
    let nowMs = 1_000_000;
    let allowed: string[] | null = ['peerCurated'];
    const enumerator = createCGMemberEnumerator(makeDeps({
      now: () => nowMs,
      cacheTtlMs: 100,
      getContextGraphAllowedPeers: async () => allowed,
      getTopicSubscribers: () => ['peerOpen'],
    }));

    const first = await enumerator.enumerate('cg-transition');
    expect(first.source).toBe('allowlist');

    allowed = null;
    nowMs += 200;

    const second = await enumerator.enumerate('cg-transition');
    expect(second.source).toBe('topic-subscribers');
    expect(second.members).toEqual(['peerOpen']);
  });
});
