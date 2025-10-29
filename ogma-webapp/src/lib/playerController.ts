import type { Track } from "@/types/types";
import {
  usePlayerStore,
  type RectLike,
} from "@/store/playerStore";
import { pushRecentArtists } from "@/lib/recent";

const playThroughGlobal = (track: Track | null) => {
  if (!track) return;
  try {
    (window as any).__ogmaPlay?.(track);
  } catch { }
};

const pauseThroughGlobal = () => {
  try {
    (window as any).__ogmaPause?.();
  } catch { }
};

const ensureRectLike = (rect: DOMRect | RectLike | null | undefined): RectLike | null => {
  if (!rect) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
};

const keyOf = (track: Track | null | undefined) =>
  track && track.id != null ? String(track.id) : null;

export const playList = (list: Track[], startIndex = 0) => {
  const track = usePlayerStore.getState().playFromList(list, startIndex);
  if (track) {
    playThroughGlobal(track);
    pushRecentArtists(track.artists ?? []);
  }
  return track;
};

export const toggleTrack = (list: Track[], index: number, trackId?: string | null) => {
  const prevId = usePlayerStore.getState().currentTrackId;
  const outcome = usePlayerStore.getState().toggleTrack(list, index, trackId);
  const nextId = keyOf(outcome.track);
  if (outcome.paused) {
    pauseThroughGlobal();
    return outcome;
  }
  if (outcome.track) {
    playThroughGlobal(outcome.track);
    if (nextId && nextId !== prevId) {
      pushRecentArtists(outcome.track.artists ?? []);
    }
  }
  return outcome;
};

export const pickFromQueue = (index: number) => {
  const track = usePlayerStore.getState().pickFromQueue(index);
  if (track) {
    playThroughGlobal(track);
    pushRecentArtists(track.artists ?? []);
  }
  return track;
};

export const nextTrack = (wrap = false) => {
  const track = usePlayerStore.getState().next(wrap);
  if (track) {
    playThroughGlobal(track);
    pushRecentArtists(track.artists ?? []);
  } else {
    pauseThroughGlobal();
  }
  return track;
};

export const prevTrack = (wrap = false) => {
  const track = usePlayerStore.getState().prev(wrap);
  if (track) {
    playThroughGlobal(track);
    pushRecentArtists(track.artists ?? []);
  }
  return track;
};

export const setPaused = (paused: boolean) => {
  usePlayerStore.getState().setPaused(paused);
  if (paused) {
    pauseThroughGlobal();
  }
};

export const setShuffle = (enabled: boolean) => {
  usePlayerStore.getState().setShuffle(enabled);
};

export const setPauseLock = (locked: boolean) => {
  usePlayerStore.getState().setPauseLock(locked);
};

export const requestExpand = (track: Track, rect: DOMRect) => {
  const key = keyOf(track);
  if (!key) return;
  const normalized = ensureRectLike(rect);
  if (!normalized) return;
  usePlayerStore.getState().requestExpand(key, normalized);
};

export const markOverlayOpened = () => {
  usePlayerStore.getState().markOverlayOpened();
};

export const requestOverlayClose = (rect: DOMRect | RectLike | null) => {
  usePlayerStore.getState().requestOverlayClose(ensureRectLike(rect));
};

export const markOverlayClosed = () => {
  usePlayerStore.getState().markOverlayClosed();
};

export const syncOverlayTrack = () => {
  usePlayerStore.getState().syncOverlayTrack();
};

export const getAudioElement = () => {
  try {
    const fn = (window as any).__ogmaGetAudio;
    if (typeof fn === "function") {
      const node = fn();
      if (node) return node as HTMLAudioElement | null;
    }
  } catch { }
  return (document.querySelector('audio[data-ogma-player="1"]') as HTMLAudioElement | null) ?? null;
};
