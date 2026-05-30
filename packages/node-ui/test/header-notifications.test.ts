// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

// ─────────────────────────────────────────────────────────────────────
// Header pulls in `useCurrentAgent` (network), `useNodeEvents`
// (EventSource), `useVisibilityPolling` (interval timer over
// fetchNotifications), and the live api wrapper. We mock the API
// surface so the dropdown renders deterministic data, and stub
// EventSource because happy-dom doesn't ship one.
// ─────────────────────────────────────────────────────────────────────

const fetchNotificationsMock = vi.fn();
const markNotificationsReadMock = vi.fn();
const fetchCurrentAgentMock = vi.fn();
const fetchStatusMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    fetchNotifications: fetchNotificationsMock,
    markNotificationsRead: markNotificationsReadMock,
    fetchCurrentAgent: fetchCurrentAgentMock,
  };
});

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: {
    fetchNotifications: fetchNotificationsMock,
    markNotificationsRead: markNotificationsReadMock,
    fetchCurrentAgent: fetchCurrentAgentMock,
    fetchStatus: fetchStatusMock,
  },
}));

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderHeader() {
  const { Header } = await import('../src/ui/components/Shell/Header.js');
  const { useAgentsStore } = await import('../src/ui/stores/agents.js');
  act(() => {
    useAgentsStore.setState({
      nodeStatus: {
        synced: true,
        connectedPeers: 3,
        connections: { direct: 2, relayed: 1 },
        uptimeMs: 60_000,
        name: 'TestNode',
      } as any,
    });
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Header));
  });
  await flush();
  mountedRoots.push(root);
  mountedContainers.push(container);
  return container;
}

function findBellButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector('button[aria-label^="Notifications"]') as HTMLButtonElement | null;
  if (!btn) throw new Error('bell button not found');
  return btn;
}

describe('Header — notification dropdown wiring', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    // EventSource stub for useNodeEvents — happy-dom doesn't provide one.
    (globalThis as any).EventSource = class StubEventSource {
      url: string;
      readyState = 0;
      onopen: ((e: any) => void) | null = null;
      onmessage: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      constructor(url: string) { this.url = url; }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    };
    fetchCurrentAgentMock.mockResolvedValue({
      agentAddress: '0xabcd00000000000000000000000000000000abcd',
      agentDid: 'did:dkg:agent:0xabcd',
      name: 'Local Agent',
      peerId: 'peer-x',
    });
    fetchStatusMock.mockResolvedValue({
      synced: true,
      connectedPeers: 3,
      connections: { direct: 2, relayed: 1 },
      uptimeMs: 60_000,
    });
    markNotificationsReadMock.mockResolvedValue({ marked: 0 });
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
    vi.useRealTimers();
  });

  it('bell button exposes a Notifications aria-label and tooltip (BUG-002 a11y wiring)', async () => {
    fetchNotificationsMock.mockResolvedValue({ notifications: [], unreadCount: 0 });
    const container = await renderHeader();
    const bell = findBellButton(container);
    expect(bell.getAttribute('aria-label')).toBe('Notifications');
    expect(bell.getAttribute('title')).toBe('Notifications');
  });

  it('bell aria-label includes the unread count when > 0 (screen reader announcement)', async () => {
    fetchNotificationsMock.mockResolvedValue({
      notifications: [
        { id: 1, ts: 1_716_000_000_000, type: 'join_request', title: 'A', message: 'A', source: null, peer: null, read: 0, meta: null },
        { id: 2, ts: 1_716_001_000_000, type: 'join_request', title: 'B', message: 'B', source: null, peer: null, read: 0, meta: null },
      ],
      unreadCount: 2,
    });
    const container = await renderHeader();
    const bell = findBellButton(container);
    expect(bell.getAttribute('aria-label')).toBe('Notifications, 2 unread');
    expect(bell.getAttribute('title')).toBe('Notifications (2 unread)');
  });

  it('opens the dropdown on bell click and renders notifications newest-first (RED-2 sort regression)', async () => {
    // Deliberately shuffled: middle is newest, first is oldest.
    fetchNotificationsMock.mockResolvedValue({
      notifications: [
        { id: 1, ts: 1_716_000_000_000, type: 'join_request', title: 'OLD', message: 'OLDEST', source: null, peer: null, read: 1, meta: null },
        { id: 2, ts: 1_716_900_000_000, type: 'join_request', title: 'NEW', message: 'NEWEST', source: null, peer: null, read: 1, meta: null },
        { id: 3, ts: 1_716_400_000_000, type: 'join_request', title: 'MID', message: 'MIDDLE', source: null, peer: null, read: 1, meta: null },
      ],
      unreadCount: 0,
    });
    const container = await renderHeader();
    const bell = findBellButton(container);
    await act(async () => { bell.click(); });
    await flush();

    const items = Array.from(container.querySelectorAll('.v10-header-notif-item-text'))
      .map((n) => n.textContent);
    expect(items).toEqual(['NEWEST', 'MIDDLE', 'OLDEST']);
  });

  it('renders the empty-state copy when there are zero notifications', async () => {
    fetchNotificationsMock.mockResolvedValue({ notifications: [], unreadCount: 0 });
    const container = await renderHeader();
    const bell = findBellButton(container);
    await act(async () => { bell.click(); });
    await flush();
    expect(container.textContent).toContain('No notifications');
  });

  it('Mark all read button is present only when unread > 0 (Codex YEL-3 copy + visibility)', async () => {
    fetchNotificationsMock.mockResolvedValue({ notifications: [], unreadCount: 0 });
    const container = await renderHeader();
    const bell = findBellButton(container);
    await act(async () => { bell.click(); });
    await flush();
    // Empty + zero unread → no button
    expect(container.querySelector('.v10-header-notif-clear')).toBe(null);
  });

  it('Mark all read button: click marks-but-does-NOT-clear the dropdown rows (YEL-3 alignment with API)', async () => {
    // The bell-click handler ALSO calls markNotificationsRead when
    // unread > 0; we want to test the explicit Mark all read button,
    // so we hang the bell's promise indefinitely (until we resolve
    // it manually) so the button stays visible long enough to click.
    let resolveBellMark: (v: any) => void = () => {};
    let resolveButtonMark: (v: any) => void = () => {};
    markNotificationsReadMock
      .mockImplementationOnce(() => new Promise((r) => { resolveBellMark = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveButtonMark = r; }));

    fetchNotificationsMock.mockResolvedValue({
      notifications: [
        { id: 1, ts: 1_716_900_000_000, type: 'join_request', title: 'A', message: 'A', source: null, peer: null, read: 0, meta: null },
        { id: 2, ts: 1_716_000_000_000, type: 'join_request', title: 'B', message: 'B', source: null, peer: null, read: 0, meta: null },
      ],
      unreadCount: 2,
    });
    const container = await renderHeader();
    const bell = findBellButton(container);
    await act(async () => { bell.click(); });
    await flush();

    // The bell-click fired markNotificationsRead but it's still
    // pending — `unread` is therefore still 2, so the Mark all read
    // button is rendered.
    const markBtn = container.querySelector('.v10-header-notif-clear') as HTMLButtonElement | null;
    expect(markBtn).toBeTruthy();
    expect(markBtn?.textContent).toBe('Mark all read');

    // Click it explicitly (this is the surface YEL-3 fixed).
    await act(async () => { markBtn!.click(); });
    await flush();

    // Resolve both pending promises so React commits the state
    // updates (read=1 and unread=0).
    await act(async () => {
      resolveBellMark({ marked: 0 });
      resolveButtonMark({ marked: 2 });
      await Promise.resolve();
    });
    await flush();

    // Critical YEL-3 assertion: rows must remain in the dropdown
    // (the API only flips `read=1`; clearing the array would
    // misrepresent the API behaviour and re-populate on next poll).
    const remaining = container.querySelectorAll('.v10-header-notif-item-text').length;
    expect(remaining).toBe(2);
    expect(markNotificationsReadMock).toHaveBeenCalledTimes(2);

    // The unread badge button copy should disappear because unread
    // is now 0 (the button is conditional on `unread > 0`).
    expect(container.querySelector('.v10-header-notif-clear')).toBe(null);
    expect(findBellButton(container).getAttribute('aria-label')).toBe('Notifications');
  });

  it('clicking the bell with unread notifications fires markNotificationsRead exactly once', async () => {
    fetchNotificationsMock.mockResolvedValue({
      notifications: [
        { id: 1, ts: 1_716_900_000_000, type: 'join_request', title: 'A', message: 'A', source: null, peer: null, read: 0, meta: null },
      ],
      unreadCount: 1,
    });
    const container = await renderHeader();
    const bell = findBellButton(container);
    await act(async () => { bell.click(); });
    await flush();
    expect(markNotificationsReadMock).toHaveBeenCalledTimes(1);
  });

  it('status pill exposes the multiline tooltip with synced + peer breakdown (BUG-020 wiring)', async () => {
    fetchNotificationsMock.mockResolvedValue({ notifications: [], unreadCount: 0 });
    const container = await renderHeader();
    const meta = container.querySelector('.v10-header-meta') as HTMLElement | null;
    expect(meta).toBeTruthy();
    const tooltip = meta!.getAttribute('title') ?? '';
    expect(tooltip).toContain('Synced with the network');
    expect(tooltip).toContain('3 peers (2 direct, 1 relayed)');
    expect(tooltip).toContain('Uptime');
  });
});
