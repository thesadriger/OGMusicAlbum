import { create } from "zustand";
import type { Track } from "@/types/types";

export type RectLike = { left: number; top: number; width: number; height: number };
export type ExpandedPlayerPhase = "closed" | "opening" | "open" | "closing";

type QueueState = {
  order: string[];
  currentIndex: number;
};

type ExpandedState = {
  phase: ExpandedPlayerPhase;
  originRect: RectLike | null;
  originTrackId: string | null;
  trackId: string | null;
};

type ToggleResult = {
  track: Track | null;
  paused: boolean;
};

type PlayerStore = {
  tracks: Record<string, Track>;
  queue: QueueState;
  currentTrackId: string | null;
  paused: boolean;
  shuffle: boolean;
  pauseLock: boolean;
  expanded: ExpandedState;
  setPaused: (paused: boolean) => void;
  setShuffle: (enabled: boolean) => void;
  setPauseLock: (locked: boolean) => void;
  playFromList: (list: Track[], startIndex: number) => Track | null;
  toggleTrack: (list: Track[], startIndex: number, trackId?: string | null) => ToggleResult;
  pickFromQueue: (index: number) => Track | null;
  next: (wrap?: boolean) => Track | null;
  prev: (wrap?: boolean) => Track | null;
  requestExpand: (trackId: string, rect: RectLike) => void;
  markOverlayOpened: () => void;
  requestOverlayClose: (rect: RectLike | null) => void;
  markOverlayClosed: () => void;
  syncOverlayTrack: () => void;
};

const EMPTY_QUEUE: QueueState = { order: [], currentIndex: -1 };
const CLOSED_EXPANDED: ExpandedState = {
  phase: "closed",
  originRect: null,
  originTrackId: null,
  trackId: null,
};

const toKey = (track: Track | null | undefined): string | null => {
  if (!track || track.id == null) return null;
  return String(track.id);
};

const sanitizeList = (list: Track[]): Track[] => list.filter((t) => t && t.id != null);

const mergeTracks = (prev: Record<string, Track>, list: Track[]): Record<string, Track> => {
  if (!list.length) return prev;
  const next = { ...prev } as Record<string, Track>;
  for (const t of list) {
    const key = toKey(t);
    if (!key) continue;
    next[key] = t;
  }
  return next;
};

const withExpandedTrack = (expanded: ExpandedState, trackId: string | null): ExpandedState => {
  if (expanded.phase === "closed") return expanded;
  if (!trackId) return { ...expanded, trackId: null };
  if (expanded.trackId === trackId) return expanded;
  return { ...expanded, trackId };
};

const pickRandomIndex = (len: number, exclude: number): number => {
  if (len <= 1) return exclude;
  let idx = exclude;
  for (let guard = 0; guard < 8 && idx === exclude; guard += 1) {
    idx = Math.floor(Math.random() * len);
  }
  if (idx === exclude) idx = (exclude + 1) % len;
  return idx;
};

export const usePlayerStore = create<PlayerStore>()((set, get) => ({
  tracks: {},
  queue: EMPTY_QUEUE,
  currentTrackId: null,
  paused: true,
  shuffle: false,
  pauseLock: false,
  expanded: CLOSED_EXPANDED,

  setPaused: (paused) =>
    set((state) => ({
      paused,
      pauseLock: paused ? state.pauseLock : false,
    })),

  setShuffle: (enabled) => set({ shuffle: !!enabled }),

  setPauseLock: (locked) => set({ pauseLock: !!locked }),

  playFromList: (list, startIndex) => {
    const safe = sanitizeList(list);
    if (!safe.length) return null;
    let result: Track | null = null;
    set((state) => {
      const merged = mergeTracks(state.tracks, safe);
      const order = safe.map((t) => String(t.id));
      const idx = Math.max(0, Math.min(startIndex, order.length - 1));
      const trackId = order[idx] ?? null;
      result = trackId ? merged[trackId] ?? null : null;
      return {
        tracks: merged,
        queue: { order, currentIndex: idx },
        currentTrackId: trackId,
        paused: false,
        pauseLock: false,
        expanded: withExpandedTrack(state.expanded, trackId),
      };
    });
    return result;
  },

  toggleTrack: (list, startIndex, trackIdMaybe) => {
    const safe = sanitizeList(list);
    const keyExplicit = trackIdMaybe != null ? String(trackIdMaybe) : null;
    let outcome: ToggleResult = { track: null, paused: get().paused };

    set((state) => {
      const merged = mergeTracks(state.tracks, safe);
      const currentId = state.currentTrackId;
      const queueOrder = safe.map((t) => String(t.id));
      const fallbackIdx = Math.max(0, Math.min(startIndex, queueOrder.length - 1));
      const targetId = keyExplicit ?? queueOrder[fallbackIdx] ?? null;

      if (targetId && currentId === targetId) {
        const nextPaused = !state.paused;
        outcome = { track: targetId ? merged[targetId] ?? null : null, paused: nextPaused };
        return {
          tracks: merged,
          paused: nextPaused,
          pauseLock: nextPaused ? true : false,
          expanded: withExpandedTrack(state.expanded, targetId),
        };
      }

      if (!targetId) {
        outcome = { track: null, paused: state.paused };
        return { tracks: merged };
      }

      const idx = queueOrder.indexOf(targetId);
      const finalIdx = idx >= 0 ? idx : fallbackIdx;
      const resolvedId = queueOrder[finalIdx] ?? targetId;
      const track = merged[resolvedId] ?? null;
      outcome = { track, paused: false };

      return {
        tracks: merged,
        queue: { order: queueOrder, currentIndex: finalIdx },
        currentTrackId: resolvedId,
        paused: false,
        pauseLock: false,
        expanded: withExpandedTrack(state.expanded, resolvedId),
      };
    });

    return outcome;
  },

  pickFromQueue: (index) => {
    let result: Track | null = null;
    set((state) => {
      const len = state.queue.order.length;
      if (len === 0) return state;
      const idx = Math.max(0, Math.min(index, len - 1));
      const trackId = state.queue.order[idx] ?? null;
      if (!trackId) return state;
      result = state.tracks[trackId] ?? null;
      return {
        currentTrackId: trackId,
        queue: { ...state.queue, currentIndex: idx },
        paused: false,
        pauseLock: false,
        expanded: withExpandedTrack(state.expanded, trackId),
      };
    });
    return result;
  },

  next: (wrap = false) => {
    let result: Track | null = null;
    set((state) => {
      const { order, currentIndex } = state.queue;
      const len = order.length;
      if (!len || state.pauseLock) return state;

      let nextIdx = currentIndex;
      if (state.shuffle && len > 1) {
        nextIdx = pickRandomIndex(len, currentIndex >= 0 ? currentIndex : 0);
      } else {
        nextIdx = currentIndex + 1;
        if (nextIdx >= len) {
          if (!wrap) {
            return {
              ...state,
              paused: true,
              pauseLock: true,
            };
          }
          nextIdx = 0;
        }
      }

      const trackId = order[nextIdx] ?? null;
      if (!trackId) return state;
      result = state.tracks[trackId] ?? null;
      return {
        currentTrackId: trackId,
        queue: { order, currentIndex: nextIdx },
        paused: false,
        pauseLock: false,
        expanded: withExpandedTrack(state.expanded, trackId),
      };
    });
    return result;
  },

  prev: (wrap = false) => {
    let result: Track | null = null;
    set((state) => {
      const { order, currentIndex } = state.queue;
      const len = order.length;
      if (!len || state.pauseLock) return state;

      let nextIdx = currentIndex;
      if (state.shuffle && len > 1) {
        nextIdx = pickRandomIndex(len, currentIndex >= 0 ? currentIndex : 0);
      } else {
        nextIdx = currentIndex - 1;
        if (nextIdx < 0) {
          if (!wrap) {
            return state;
          }
          nextIdx = len > 0 ? len - 1 : 0;
        }
      }

      const trackId = order[nextIdx] ?? null;
      if (!trackId) return state;
      result = state.tracks[trackId] ?? null;
      return {
        currentTrackId: trackId,
        queue: { order, currentIndex: nextIdx },
        paused: false,
        pauseLock: false,
        expanded: withExpandedTrack(state.expanded, trackId),
      };
    });
    return result;
  },

  requestExpand: (trackId, rect) =>
    set((state) => {
      if (!trackId || state.currentTrackId !== trackId) return state;
      return {
        expanded: {
          phase: "opening",
          originRect: rect,
          originTrackId: trackId,
          trackId: trackId,
        },
      };
    }),

  markOverlayOpened: () =>
    set((state) => {
      if (state.expanded.phase !== "opening") return state;
      return { expanded: { ...state.expanded, phase: "open" } };
    }),

  requestOverlayClose: (rect) =>
    set((state) => {
      if (state.expanded.phase === "closed") return state;
      return {
        expanded: {
          ...state.expanded,
          phase: "closing",
          originRect: rect,
        },
      };
    }),

  markOverlayClosed: () => set({ expanded: CLOSED_EXPANDED }),

  syncOverlayTrack: () =>
    set((state) => ({
      expanded: withExpandedTrack(state.expanded, state.currentTrackId),
    })),
}));

export type { PlayerStore };

export const selectCurrentTrackId = (state: PlayerStore) => state.currentTrackId;
export const selectCurrentTrack = (state: PlayerStore): Track | null => {
  const id = state.currentTrackId;
  return id ? state.tracks[id] ?? null : null;
};
export const selectQueue = (state: PlayerStore): Track[] =>
  state.queue.order.map((id) => state.tracks[id]).filter((t): t is Track => Boolean(t));
export const selectQueueIndex = (state: PlayerStore) => state.queue.currentIndex;
export const selectIsPaused = (state: PlayerStore) => state.paused;
export const selectShuffle = (state: PlayerStore) => state.shuffle;
export const selectPauseLock = (state: PlayerStore) => state.pauseLock;
export const selectExpandedState = (state: PlayerStore) => state.expanded;
export const selectExpandedTrackId = (state: PlayerStore) =>
  state.expanded.phase === "closed" ? null : state.expanded.originTrackId;
export const selectExpandedVisibleTrack = (state: PlayerStore): Track | null => {
  const trackId = state.expanded.trackId;
  return trackId ? state.tracks[trackId] ?? null : null;
};
