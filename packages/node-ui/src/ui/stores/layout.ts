import { create } from 'zustand';

interface LayoutState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
  bottomMaximised: boolean;
  theme: 'dark' | 'light';
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;

  toggleLeft: () => void;
  toggleRight: () => void;
  toggleBottom: () => void;
  toggleBottomMaximised: () => void;
  setTheme: (t: 'dark' | 'light') => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setBottomHeight: (h: number) => void;
}

const LAYOUT_STORAGE_KEY = 'dkg-layout';

interface PersistedLayout {
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  bottomCollapsed?: boolean;
  leftWidth?: number;
  rightWidth?: number;
  bottomHeight?: number;
}

const BOTTOM_HEIGHT_MIN = 80;
const BOTTOM_HEIGHT_MAX = 900;
const BOTTOM_HEIGHT_DEFAULT = 260;

const DEFAULTS = {
  leftCollapsed: false,
  rightCollapsed: false,
  bottomCollapsed: true,
  leftWidth: 240,
  rightWidth: 360,
  bottomHeight: BOTTOM_HEIGHT_DEFAULT,
};

// Must match the live drag handlers in App.tsx (`useDragResize`); without
// clamping on load, a stale or manually edited `dkg-layout` entry like
// `{"leftWidth":2000}` would reload into an unusable shell that can't be
// recovered without clearing storage.
const LEFT_WIDTH_MIN = 140;
const LEFT_WIDTH_MAX = 400;
const RIGHT_WIDTH_MIN = 200;
const RIGHT_WIDTH_MAX = 500;
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
function clampWidth(parsed: unknown, fallback: number, min: number, max: number): number {
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function loadPersisted(): Required<PersistedLayout> {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as PersistedLayout;
    return {
      leftCollapsed: typeof parsed.leftCollapsed === 'boolean' ? parsed.leftCollapsed : DEFAULTS.leftCollapsed,
      rightCollapsed: typeof parsed.rightCollapsed === 'boolean' ? parsed.rightCollapsed : DEFAULTS.rightCollapsed,
      bottomCollapsed: typeof parsed.bottomCollapsed === 'boolean' ? parsed.bottomCollapsed : DEFAULTS.bottomCollapsed,
      leftWidth: clampWidth(parsed.leftWidth, DEFAULTS.leftWidth, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX),
      rightWidth: clampWidth(parsed.rightWidth, DEFAULTS.rightWidth, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX),
      bottomHeight: clampWidth(parsed.bottomHeight, DEFAULTS.bottomHeight, BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX),
    };
  } catch {
    return DEFAULTS;
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist(state: PersistedLayout): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage may be unavailable (private mode, quota); silently skip
    }
  }, 150);
}

const initial = loadPersisted();

function getAndPersist(get: () => LayoutState) {
  const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight } = get();
  persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight });
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  leftCollapsed: initial.leftCollapsed,
  rightCollapsed: initial.rightCollapsed,
  bottomCollapsed: initial.bottomCollapsed,
  bottomMaximised: false,
  theme: (localStorage.getItem('dkg-theme') as 'dark' | 'light') || 'dark',
  leftWidth: initial.leftWidth,
  rightWidth: initial.rightWidth,
  bottomHeight: initial.bottomHeight,

  toggleLeft: () => {
    set((s) => ({ leftCollapsed: !s.leftCollapsed }));
    getAndPersist(get);
  },
  toggleRight: () => {
    set((s) => ({ rightCollapsed: !s.rightCollapsed }));
    getAndPersist(get);
  },
  toggleBottom: () => {
    set((s) => ({ bottomCollapsed: !s.bottomCollapsed, bottomMaximised: false }));
    getAndPersist(get);
  },
  toggleBottomMaximised: () => {
    set((s) => ({ bottomMaximised: !s.bottomMaximised, bottomCollapsed: false }));
    getAndPersist(get);
  },
  setTheme: (t) => {
    localStorage.setItem('dkg-theme', t);
    set({ theme: t });
  },
  setLeftWidth: (w) => {
    set({ leftWidth: clamp(w, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX) });
    getAndPersist(get);
  },
  setRightWidth: (w) => {
    set({ rightWidth: clamp(w, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX) });
    getAndPersist(get);
  },
  setBottomHeight: (h) => {
    set({ bottomHeight: clamp(h, BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX) });
    getAndPersist(get);
  },
}));
