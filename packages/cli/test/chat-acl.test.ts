// chat-acl.test.ts
//
// Unit-tests for the daemon's inbound-chat ACL helper. Exercises all four
// ACL modes (`any`, `peer-allowlist`, `scoped`, `shared-context-graph`)
// plus loopback and the fail-closed behaviour when a `scoped` ACL has
// no `contextGraphId` configured. Mocks `DashboardDB` with a minimal
// in-memory stand-in covering only the two helpers the ACL touches.

import { describe, it, expect } from 'vitest';
import { buildChatAcl } from '../src/daemon/chat-acl.js';
import type {
  ContextGraphMemberRow,
  ContextGraphSubscriptionRow,
  DashboardDB,
} from '@origintrail-official/dkg-node-ui';

const LOCAL_PEER = 'localPeerId';
const ALICE = '12D3KooWAlice';
const BOB = '12D3KooWBob';
const CAROL = '12D3KooWCarol';

function makeRow(
  cg: string,
  peerId: string,
  status: 'active' | 'removed' | 'pending' = 'active',
): ContextGraphMemberRow {
  return {
    context_graph_id: cg,
    principal_type: 'node',
    principal_id: peerId,
    role: null,
    status,
    source: null,
    display_name: null,
    metadata: null,
    first_seen_at: 0,
    updated_at: 0,
  };
}

function makeSub(cg: string, subscribed = 1): ContextGraphSubscriptionRow {
  return {
    context_graph_id: cg,
    name: null,
    subscribed,
    synced: 1,
    shared_memory_synced: 1,
    meta_synced: 1,
    on_chain_id: null,
    sync_scoped: 0,
    updated_at: 0,
  };
}

/**
 * Minimal `DashboardDB` stand-in covering only the methods the ACL helper
 * actually calls. Anything else throws so a mis-mock surfaces loudly.
 */
function makeDb(rows: {
  members?: Record<string, ContextGraphMemberRow[]>;
  subscriptions?: ContextGraphSubscriptionRow[];
}): DashboardDB {
  const stub: Partial<DashboardDB> = {
    listContextGraphMembers: (cg?: string) => {
      if (!cg) return Object.values(rows.members ?? {}).flat();
      return rows.members?.[cg] ?? [];
    },
    listContextGraphSubscriptions: () => rows.subscriptions ?? [],
  };
  return stub as DashboardDB;
}

describe('buildChatAcl', () => {
  // Default mode is `any` → null callback ⇒ MessageHandler accepts every
  // authenticated peer (legacy behaviour). Critical for backwards-compat
  // because nodes that haven't configured `chat.acl` shouldn't suddenly
  // start rejecting valid messages after this RFC lands.
  it('returns null when mode is unset', () => {
    const acl = buildChatAcl({
      dashDb: makeDb({}),
      getLocalPeerId: () => LOCAL_PEER,
    });
    expect(acl).toBeNull();
  });

  it('returns null when mode is "any"', () => {
    const acl = buildChatAcl({
      config: { mode: 'any' },
      dashDb: makeDb({}),
      getLocalPeerId: () => LOCAL_PEER,
    });
    expect(acl).toBeNull();
  });

  describe('mode: peer-allowlist', () => {
    it('accepts peers on the allowlist, rejects others', () => {
      const acl = buildChatAcl({
        config: { mode: 'peer-allowlist', peerAllowlist: [ALICE] },
        dashDb: makeDb({}),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl).not.toBeNull();
      expect(acl!(ALICE, {})).toEqual({ accept: true });
      const denied = acl!(BOB, {});
      expect(denied.accept).toBe(false);
      expect(denied.reason).toMatch(/not in peer-allowlist/);
    });

    it('rejects everyone when allowlist is empty', () => {
      const acl = buildChatAcl({
        config: { mode: 'peer-allowlist', peerAllowlist: [] },
        dashDb: makeDb({}),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, {});
      expect(verdict.accept).toBe(false);
    });
  });

  describe('mode: scoped', () => {
    it('accepts senders that are active node-members of the scoped CG', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped', contextGraphId: 'cg-1' },
        dashDb: makeDb({
          members: { 'cg-1': [makeRow('cg-1', ALICE)] },
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl!(ALICE, {})).toEqual({ accept: true });
      expect(acl!(BOB, {}).accept).toBe(false);
    });

    it('rejects senders whose membership is "removed" or "pending"', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped', contextGraphId: 'cg-1' },
        dashDb: makeDb({
          members: {
            'cg-1': [
              makeRow('cg-1', ALICE, 'removed'),
              makeRow('cg-1', BOB, 'pending'),
            ],
          },
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl!(ALICE, {}).accept).toBe(false);
      expect(acl!(BOB, {}).accept).toBe(false);
    });

    it('fail-closes (rejects all) when contextGraphId is missing', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped' },
        dashDb: makeDb({}),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, {});
      expect(verdict.accept).toBe(false);
      expect(verdict.reason).toMatch(/no contextGraphId/);
    });

    it('reports CG mismatch when sender claims a different CG', () => {
      const acl = buildChatAcl({
        config: { mode: 'scoped', contextGraphId: 'cg-1' },
        dashDb: makeDb({ members: { 'cg-1': [] } }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, { contextGraphId: 'cg-2' });
      expect(verdict.accept).toBe(false);
      expect(verdict.reason).toMatch(/cg-2.*cg-1|cg-1.*cg-2/);
    });
  });

  describe('mode: shared-context-graph', () => {
    it('accepts senders that share at least one subscribed CG', () => {
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({
          members: {
            'cg-1': [makeRow('cg-1', ALICE)],
            'cg-2': [makeRow('cg-2', BOB)],
          },
          subscriptions: [makeSub('cg-1'), makeSub('cg-2')],
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl!(ALICE, {})).toEqual({ accept: true });
      expect(acl!(BOB, {})).toEqual({ accept: true });
      expect(acl!(CAROL, {}).accept).toBe(false);
    });

    it('ignores CGs that are no longer subscribed', () => {
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({
          members: { 'cg-1': [makeRow('cg-1', ALICE)] },
          subscriptions: [makeSub('cg-1', 0)],
        }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      const verdict = acl!(ALICE, {});
      expect(verdict.accept).toBe(false);
      expect(verdict.reason).toMatch(/shares no active context-graph/i);
    });

    it('rejects with reason when no subscriptions exist', () => {
      const acl = buildChatAcl({
        config: { mode: 'shared-context-graph' },
        dashDb: makeDb({ subscriptions: [] }),
        getLocalPeerId: () => LOCAL_PEER,
      });
      expect(acl!(ALICE, {}).accept).toBe(false);
    });
  });

  describe('loopback', () => {
    it('always accepts when senderPeerId matches getLocalPeerId(), regardless of mode', () => {
      for (const mode of ['peer-allowlist', 'scoped', 'shared-context-graph'] as const) {
        const acl = buildChatAcl({
          config: {
            mode,
            // intentionally empty config — we want to prove loopback
            // wins even when the ACL would otherwise reject everyone.
            peerAllowlist: [],
            contextGraphId: 'cg-1',
          },
          dashDb: makeDb({}),
          getLocalPeerId: () => LOCAL_PEER,
        });
        expect(acl!(LOCAL_PEER, {})).toEqual({ accept: true });
      }
    });

    it('does not blow up if getLocalPeerId throws (agent not yet started)', () => {
      const acl = buildChatAcl({
        config: { mode: 'peer-allowlist', peerAllowlist: [ALICE] },
        dashDb: makeDb({}),
        getLocalPeerId: () => {
          throw new Error('not started');
        },
      });
      // Loopback check short-circuits; non-loopback path still works.
      expect(acl!(ALICE, {})).toEqual({ accept: true });
      expect(acl!(BOB, {}).accept).toBe(false);
    });
  });

  it('rejects unknown modes (defence in depth)', () => {
    // Cast through `any` because we want to simulate a config we don't
    // statically know about — e.g. an operator hand-edited config.json
    // with a typo.
    const acl = buildChatAcl({
      config: { mode: 'totally-unknown' as any },
      dashDb: makeDb({}),
      getLocalPeerId: () => LOCAL_PEER,
    });
    expect(acl).not.toBeNull();
    const verdict = acl!(ALICE, {});
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/unknown ACL mode/);
  });
});
