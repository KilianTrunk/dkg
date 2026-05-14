// chat-tools.test.ts
//
// Unit tests for the Phase 1 agent-to-agent debug-chat MCP tools
// (`dkg_send_message` + `dkg_check_inbox`). Verifies tool wiring,
// happy-path behaviour, ACL-error surfacing, and inbox formatting
// (friendly-name resolution, since/peer/limit filters, direction
// filtering). Uses the in-memory FakeClient/FakeServer harness.

import { describe, it, expect, beforeEach } from 'vitest';
import { registerChatTools } from '../src/tools/chat.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

describe('chat tools — dkg_send_message + dkg_check_inbox', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerChatTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers both chat tools', () => {
    expect(server.tools.has('dkg_send_message')).toBe(true);
    expect(server.tools.has('dkg_check_inbox')).toBe(true);
  });

  describe('dkg_send_message', () => {
    it('forwards to / text / contextGraphId to the client', async () => {
      const result = await server.call('dkg_send_message', {
        to: 'alice-node',
        text: 'hey, can you see the test failure on your end?',
        contextGraphId: 'cg-dkg-debug',
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/Delivered to alice-node/);
      expect(client.sendChatCalls).toHaveLength(1);
      expect(client.sendChatCalls[0]).toEqual({
        to: 'alice-node',
        text: 'hey, can you see the test failure on your end?',
        contextGraphId: 'cg-dkg-debug',
      });
    });

    it('omits contextGraphId on the wire when not provided', async () => {
      await server.call('dkg_send_message', { to: 'bob', text: 'hello' });
      expect(client.sendChatCalls[0]).toEqual({ to: 'bob', text: 'hello' });
    });

    it('surfaces ACL-rejection with actionable guidance', async () => {
      client.chatDeliveryOverride = {
        delivered: false,
        error: 'unauthorized: sender is not an active member of cg-debug',
      };
      const result = await server.call('dkg_send_message', {
        to: 'alice',
        text: 'ping',
      });
      expect(result.isError).toBe(true);
      const body = result.content[0].text;
      expect(body).toMatch(/unauthorized/);
      // The model should be guided toward a human-fixable next step.
      expect(body).toMatch(/peerAllowlist|context graph|ACL/i);
    });

    it('surfaces transport/timeout errors verbatim', async () => {
      client.chatDeliveryOverride = {
        delivered: false,
        error: 'PEER_NOT_FOUND',
      };
      const result = await server.call('dkg_send_message', {
        to: 'unknown',
        text: 'hi',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/PEER_NOT_FOUND/);
    });
  });

  describe('dkg_check_inbox', () => {
    it('returns a friendly empty-state when no messages exist', async () => {
      const result = await server.call('dkg_check_inbox', {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/No unread peer messages/);
    });

    it('formats inbound messages with friendly names + timestamps', async () => {
      client.agents = [{ peerId: '12D3KooWAliceXYZ', name: 'alice-node' }];
      client.chatMessages.push(
        { ts: 1715670000000, direction: 'in', peer: '12D3KooWAliceXYZ', text: 'msg-one' },
        { ts: 1715680000000, direction: 'in', peer: '12D3KooWBobABC', text: 'msg-two' },
      );
      const result = await server.call('dkg_check_inbox', {});
      expect(result.isError).toBeFalsy();
      const body = result.content[0].text;
      expect(body).toMatch(/2 unread peer messages/);
      // Friendly name surfaces for the agent we know about
      expect(body).toMatch(/alice-node \(…AliceXYZ\)/);
      // Bare short-form for unknown peers
      expect(body).toMatch(/…oWBobABC/);
      // Both message bodies present
      expect(body).toContain('msg-one');
      expect(body).toContain('msg-two');
      // Reply hint surfaced
      expect(body).toMatch(/dkg_send_message/);
    });

    it('filters out outbound messages by default', async () => {
      client.chatMessages.push(
        { ts: 1, direction: 'out', peer: 'peer', text: 'sent', delivered: true },
        { ts: 2, direction: 'in', peer: 'peer', text: 'received' },
      );
      const result = await server.call('dkg_check_inbox', {});
      expect(result.content[0].text).toMatch(/1 unread peer message/);
      expect(result.content[0].text).toContain('received');
      expect(result.content[0].text).not.toContain('sent');
    });

    it('shows both directions when directionFilter=both', async () => {
      client.chatMessages.push(
        { ts: 1, direction: 'out', peer: 'peer', text: 'outbound-text', delivered: true },
        { ts: 2, direction: 'in', peer: 'peer', text: 'inbound-text' },
      );
      const result = await server.call('dkg_check_inbox', { directionFilter: 'both' });
      const body = result.content[0].text;
      expect(body).toContain('outbound-text');
      expect(body).toContain('inbound-text');
      expect(body).toMatch(/direction=both/);
    });

    it('flags undelivered outbound messages when directionFilter shows out', async () => {
      client.chatMessages.push(
        { ts: 1, direction: 'out', peer: 'peer', text: 'failed-message', delivered: false },
      );
      const result = await server.call('dkg_check_inbox', { directionFilter: 'out' });
      expect(result.content[0].text).toMatch(/UNDELIVERED/);
    });

    it('respects since= filter against the daemon query', async () => {
      client.chatMessages.push(
        { ts: 1000, direction: 'in', peer: 'peer', text: 'old' },
        { ts: 5000, direction: 'in', peer: 'peer', text: 'new' },
      );
      const result = await server.call('dkg_check_inbox', { since: 2000 });
      expect(result.content[0].text).toContain('new');
      expect(result.content[0].text).not.toContain('old');
    });

    it('passes peer= filter to the daemon query', async () => {
      client.chatMessages.push(
        { ts: 1, direction: 'in', peer: 'alice', text: 'from-alice' },
        { ts: 2, direction: 'in', peer: 'bob', text: 'from-bob' },
      );
      const result = await server.call('dkg_check_inbox', { peer: 'alice' });
      const body = result.content[0].text;
      expect(body).toContain('from-alice');
      expect(body).not.toContain('from-bob');
    });

    it('caps results by limit', async () => {
      for (let i = 0; i < 10; i++) {
        client.chatMessages.push({ ts: i, direction: 'in', peer: 'peer', text: `m${i}` });
      }
      const result = await server.call('dkg_check_inbox', { limit: 3 });
      const body = result.content[0].text;
      expect(body).toMatch(/3 unread peer messages/);
      // The FakeClient.getMessages keeps the LAST N rows when limit is set,
      // matching the daemon's most-recent-first ordering. Tests should
      // not over-constrain on which specific messages appear; just that
      // the cap is honoured.
      const matches = body.match(/m\d/g) ?? [];
      expect(matches).toHaveLength(3);
    });
  });
});
