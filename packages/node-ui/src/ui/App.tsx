import React, { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Header } from './components/Shell/Header.js';
import { PanelLeft } from './components/Shell/PanelLeft.js';
import { PanelCenter } from './components/Shell/PanelCenter.js';
import { PanelBottom } from './components/Shell/PanelBottom.js';
import { PanelRight } from './components/Shell/PanelRight.js';
import { useLayoutStore, maxBottomHeight } from './stores/layout.js';
import { useAgentsStore } from './stores/agents.js';
import { useTabsStore } from './stores/tabs.js';
import { api } from './api-wrapper.js';
import { CONTEXT_GRAPH_PRIMER_TAB } from './lib/contextGraphPrimer.js';
import { useVisibilityPolling } from './hooks/useVisibilityPolling.js';

function useLiveStatus() {
  const setNodeStatus = useAgentsStore((s) => s.setNodeStatus);
  // Status was previously polled every 10s with a raw `setInterval`,
  // even when the tab was hidden — burning ~6 requests/minute against
  // the daemon for nothing. Route through the visibility-aware
  // helper so a backgrounded tab stops polling entirely (BUG-007).
  useVisibilityPolling(() => {
    api.fetchStatus().then(setNodeStatus).catch(() => {});
  }, 10_000);
}

function useKeyboardShortcuts() {
  const { toggleLeft, toggleRight, toggleBottom } = useLayoutStore();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Normalise the key — Chrome reports the *uppercase* letter when
      // Shift is held (or Caps Lock is on), so the lowercase comparisons
      // below would silently miss `Cmd+Shift+B` and `Cmd+B` with Caps
      // Lock. Normalising here keeps the dispatch table case-insensitive.
      const k = e.key.toLowerCase();
      // Order matters: handle the shift-modified shortcut first and
      // `return` so the non-shift branches below can't double-fire on
      // the same event.
      if (e.shiftKey && k === 'b') { e.preventDefault(); toggleRight(); return; }
      if (e.shiftKey) return;
      if (k === 'b') { e.preventDefault(); toggleLeft(); return; }
      if (k === 'j') { e.preventDefault(); toggleBottom(); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleLeft, toggleRight, toggleBottom]);
}

function useDragResize(onDrag: (delta: number) => void) {
  const handleRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef(onDrag);
  cbRef.current = onDrag;

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    let startX = 0;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      startX = e.clientX;
      cbRef.current(delta);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.classList.remove('active');
    };

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      startX = e.clientX;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      handle.classList.add('active');
    };

    handle.addEventListener('mousedown', onMouseDown);
    return () => handle.removeEventListener('mousedown', onMouseDown);
  }, []);

  return handleRef;
}

// Vertical twin of useDragResize for the bottom panel — tracks clientY
// and uses a row-resize cursor. Kept as a separate hook (rather than
// generalising useDragResize) to keep the horizontal path untouched.
function useDragResizeV(onDrag: (delta: number) => void) {
  const cbRef = useRef(onDrag);
  cbRef.current = onDrag;
  // The bottom handle only renders while the panel is expanded, and the
  // panel defaults to collapsed — so a one-shot useEffect([]) keyed on a
  // ref would bind to `null` on its only run and never re-bind when the
  // handle later appears, leaving it inert. Track the node in state and
  // key the effect on it so the listener (re)attaches whenever the
  // handle mounts/unmounts (Codex).
  const [handle, setHandle] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!handle) return;

    let startY = 0;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - startY;
      startY = e.clientY;
      cbRef.current(delta);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.classList.remove('active');
    };

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      handle.classList.add('active');
    };

    handle.addEventListener('mousedown', onMouseDown);
    return () => {
      handle.removeEventListener('mousedown', onMouseDown);
      // If the handle unmounts (panel collapsed) or the shell unmounts
      // mid-drag, fully tear down: onMouseUp removes the document
      // mousemove/mouseup listeners and resets the body cursor/
      // user-select so the app can't get stuck in row-resize still
      // firing setBottomHeight (Codex).
      onMouseUp();
    };
  }, [handle]);

  // Stable callback ref: React invokes it with the node on mount and
  // null on unmount, driving the effect above.
  return useCallback((node: HTMLDivElement | null) => setHandle(node), []);
}

// Map between deep-link URL paths and centre-tab IDs. Keeping this here
// (rather than inside `useTabsStore`) lets the route layer stay a thin
// adapter — the store is still the source of truth for which tabs are
// open, but a fresh navigation to e.g. `/ui/settings` opens that tab on
// mount and clicking the tab pushes the corresponding URL.
const URL_PATH_TO_TAB: Record<string, { id: string; label: string }> = {
  '/observability': { id: 'operations', label: 'Observability' },
  '/operations': { id: 'operations', label: 'Observability' },
  '/settings': { id: 'settings', label: 'Settings' },
};
const TAB_TO_URL_PATH: Record<string, string> = {
  operations: '/observability',
  settings: '/settings',
  dashboard: '/',
};

function useShellRouting() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openTab = useTabsStore((s) => s.openTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);

  // Step 1: when the user lands on a deep-link path, open the matching
  // centre tab once. We deliberately key the effect on `pathname` so
  // browser back/forward also re-opens the corresponding tab.
  //
  // We intentionally do NOT force-switch to the dashboard at `/`: other
  // routes (e.g. the Context-Graph primer) redirect to `/` after
  // opening their own tab, and stomping the active tab here would
  // ping-pong the user back to the dashboard mid-flow.
  useEffect(() => {
    const match = URL_PATH_TO_TAB[pathname];
    if (match) {
      openTab({ id: match.id, label: match.label, closable: true });
    }
  }, [pathname, openTab]);
  void setActiveTab; // kept on the hook surface for future deep-link work

  // Step 2: keep the URL aligned with the *active* tab so a refresh
  // restores you to the same place and the location bar reflects what
  // the user sees. We only touch the URL when the canonical mapping
  // disagrees with the current pathname — non-deep-linkable tabs
  // (project:..., context-graph-primer, etc.) leave the URL alone.
  useEffect(() => {
    const target = TAB_TO_URL_PATH[activeTabId];
    if (target && target !== pathname) {
      navigate(target, { replace: true });
    }
  }, [activeTabId, pathname, navigate]);
}

function AppShell() {
  useLiveStatus();
  useKeyboardShortcuts();
  useShellRouting();
  const { leftCollapsed, rightCollapsed, bottomCollapsed, theme, leftWidth, rightWidth, setLeftWidth, setRightWidth, setBottomHeight } = useLayoutStore();
  const [, setVpTick] = useState(0);

  useEffect(() => {
    // Toggle the class on `<html>` (documentElement) — not `<body>` —
    // because `:root` defines `--bg-root: #000000` and the
    // `html, body, #root { background: var(--bg-root) }` rule applies
    // that variable to the `<html>` element first. Putting the override
    // class on `<body>` only re-cascaded the variable to the body, so
    // the html element kept rendering the dark colour and rubber-band
    // overscroll on macOS showed a black strip in light mode. Keep the
    // body class as well for any selectors authored against `body.light`
    // historically.
    document.documentElement.classList.toggle('light', theme === 'light');
    document.body.classList.toggle('light', theme === 'light');
  }, [theme]);

  // Re-render on viewport resize so the render-time clamp in PanelBottom
  // and the drag base both recompute against the new maxBottomHeight().
  // We deliberately do NOT write a clamped value back into the store
  // here: persisting the shrunk height would destroy the user's
  // preferred panel size whenever the window is only temporarily
  // smaller, and it could never be restored on re-enlarge (Codex). The
  // unclamped preference stays in the store; only a user drag changes
  // it. Shrink-drag still isn't sticky because onDragBottom bases off
  // the clamped effective height, not the raw stored value.
  useEffect(() => {
    const onResize = () => setVpTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onDragLeft = useCallback((delta: number) => {
    const w = useLayoutStore.getState().leftWidth;
    setLeftWidth(Math.max(140, Math.min(400, w + delta)));
  }, [setLeftWidth]);

  const onDragRight = useCallback((delta: number) => {
    const w = useLayoutStore.getState().rightWidth;
    setRightWidth(Math.max(200, Math.min(500, w - delta)));
  }, [setRightWidth]);

  // Handle sits above the bottom panel; dragging UP (negative delta)
  // makes the panel taller, so subtract the delta. Clamp to the
  // viewport-aware max so the center pane keeps its minimum height.
  // Base the drag off the *clamped effective* height (what the user
  // actually sees), not the raw stored preference — otherwise, when the
  // stored value exceeds the viewport max, the first shrink-drag has to
  // chew through the phantom off-screen height before the panel moves
  // (Codex). This write is a user-initiated change, so persisting it is
  // intended.
  const onDragBottom = useCallback((delta: number) => {
    const eff = Math.min(useLayoutStore.getState().bottomHeight, maxBottomHeight());
    setBottomHeight(Math.min(eff - delta, maxBottomHeight()));
  }, [setBottomHeight]);

  const leftHandle = useDragResize(onDragLeft);
  const rightHandle = useDragResize(onDragRight);
  const bottomHandle = useDragResizeV(onDragBottom);

  return (
    <div className="v10-app">
      <Header />
      <div className="v10-app-body">
        {!leftCollapsed && (
          <>
            <div className="v10-panel-left" style={{ width: leftWidth }}>
              <PanelLeft />
            </div>
            <div className="v10-resize-handle-h" ref={leftHandle} />
          </>
        )}

        <div className="v10-center-region" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <PanelCenter />
          </div>
          {!bottomCollapsed && <div className="v10-resize-handle-v" ref={bottomHandle} />}
          <PanelBottom />
        </div>

        {!rightCollapsed && (
          <>
            <div className="v10-resize-handle-h" ref={rightHandle} />
            <div className="v10-panel-right" style={{ width: rightWidth }}>
              <PanelRight />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const NetworkDebugPage = React.lazy(() =>
  import('./pages/Network.js').then((m) => ({ default: m.NetworkPage }))
);

function ContextGraphPrimerRoute() {
  const openTab = useTabsStore((s) => s.openTab);

  useLayoutEffect(() => {
    openTab(CONTEXT_GRAPH_PRIMER_TAB);
  }, [openTab]);

  return <Navigate to="/" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/network" element={
        <React.Suspense fallback={<div className="lazy-spinner">Loading...</div>}>
          <NetworkDebugPage />
        </React.Suspense>
      } />
      <Route path="/context-graph-primer" element={<ContextGraphPrimerRoute />} />
      <Route path="/agent" element={<Navigate to="/" replace />} />
      <Route path="/explorer" element={<Navigate to="/" replace />} />
      <Route path="/messages" element={<Navigate to="/" replace />} />
      {/* V9 installable apps framework was retired in V10 (see daemon 410 handler).
          Redirect stale bookmarks for /ui/apps/... back to the dashboard so upgraded
          nodes don't silently render AppShell under a dead URL. */}
      <Route path="/apps/*" element={<Navigate to="/" replace />} />
      <Route path="*" element={<AppShell />} />
    </Routes>
  );
}
