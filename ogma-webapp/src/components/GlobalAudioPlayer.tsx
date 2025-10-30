// src/components/GlobalAudioPlayer.tsx
import React from "react";
import type { Track } from "@/types/types";
import ElasticSlider from "@/components/ElasticSlider";
import { streamUrlFor } from "@/lib/api";
import { goArtist, goPlaylist, goPlaylistHandle } from "@/lib/router";
import GlassSurface from "@/components/GlassSurface";
import { inPlaylist } from "@/lib/playlists";
import {
  usePlayerStore,
  selectCurrentTrack,
  selectIsPaused,
  selectShuffle,
  selectPauseLock,
} from "@/store/playerStore";
import {
  nextTrack as nextTrackController,
  prevTrack as prevTrackController,
  setPaused as setPausedController,
  setShuffle as setShuffleController,
  setPauseLock as setPauseLockController,
} from "@/lib/playerController";

import RoundGlassButton from "@/components/RoundGlassButton";
import {
  IconPlay,
  IconPause,
  IconNextNew,
  IconPrevNew,
  IconAdd,
  IconShuffle,
} from "@/components/PlayerIcons";

/** Что за плейлист был последним, куда добавили текущий трек */
type LastAdded =
  | { type: "local" }
  | { type: "server"; id?: string; handle?: string | null; title?: string | null; is_public?: boolean }
  | null;

type Props = {
  // добавление в плейлист из плеера
  onAddToPlaylist?: (track: Track) => void;

  /** жестовое раскрытие в полноэкранный плеер */
  onRequestExpand?: (track: Track, originRect: DOMRect) => void;
};

const EXPAND_CANCEL_PX = 12;
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  '[role="button"]',
  '[role="link"]',
  "[data-player-interactive]",
  "[data-no-expand]",
].join(",");

const triggerHapticImpact = (
  kind: "light" | "medium" | "heavy" | "soft" | "rigid" = "medium"
) => {
  if (typeof window === "undefined") return;
  try {
    const wa = (window as any)?.Telegram?.WebApp;
    const ok =
      !!wa?.HapticFeedback &&
      (typeof wa?.isVersionAtLeast === "function"
        ? wa.isVersionAtLeast("6.1")
        : parseFloat(wa?.version || "0") >= 6.1);
    if (ok) {
      wa.HapticFeedback.impactOccurred(kind);
      return;
    }
  } catch { }
  try {
    window.navigator?.vibrate?.(20);
  } catch { }
};

const isInteractiveTarget = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false;
  return target.closest(INTERACTIVE_SELECTOR) != null;
};

/** Разрешаем проигрывание инлайн (iOS) */
function ensureInline(a: HTMLAudioElement) {
  a.setAttribute("playsinline", "true");
  a.setAttribute("webkit-playsinline", "true");
  (a as any).playsInline = true;
}

/** Грубая эвристика по MIME */
function guessMimeFromTrack(t: Track, url: string): string {
  const m = (t as any)?.mime?.toLowerCase?.() || "";
  if (m) {
    if (m.includes("mp3")) return "audio/mpeg";
    if (m.includes("ogg")) return "audio/ogg";
    if (m.includes("wav")) return "audio/wav";
    return m;
  }
  if (/\.mp3(\?|$)/i.test(url)) return "audio/mpeg";
  if (/\.ogg(\?|$)/i.test(url)) return "audio/ogg";
  if (/\.wav(\?|$)/i.test(url)) return "audio/wav";
  return "audio/mpeg";
}

/** Устанавливаем источник аудио через <source> (стабильнее для смены кодеков) */
function setAudioSource(a: HTMLAudioElement, t: Track) {
  const url = streamUrlFor(t);
  if (!url || typeof url !== "string") throw new Error("Bad stream URL");
  let source = a.querySelector('source[data-ogma="1"]') as HTMLSourceElement | null;
  if (!source) {
    source = document.createElement("source");
    source.setAttribute("data-ogma", "1");
    a.appendChild(source);
  }
  source.src = url;
  source.type = guessMimeFromTrack(t, url);
  a.removeAttribute("src");
  a.setAttribute("data-track-id", t.id);
  a.load();
}

/** Дожидаемся возможности играть, но не висим бесконечно */
function waitForCanPlay(a: HTMLAudioElement, timeoutMs = 6000) {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      a.removeEventListener("loadedmetadata", onOK);
      a.removeEventListener("canplay", onOK);
      a.removeEventListener("error", onErr);
      clearTimeout(tid);
      ok ? resolve() : reject(new Error("load-timeout"));
    };
    const onOK = () => finish(true);
    const onErr = () => finish(false);
    const tid = window.setTimeout(onErr, timeoutMs);
    a.addEventListener("loadedmetadata", onOK, { once: true });
    a.addEventListener("canplay", onOK, { once: true });
    a.addEventListener("error", onErr, { once: true });
  });
}


// формат М:СС
const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
};


export default function GlobalAudioPlayer({ onAddToPlaylist, onRequestExpand }: Props) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const expandSurfaceRef = React.useRef<HTMLDivElement | null>(null);
  const expandPointerRef = React.useRef<{ x: number; y: number; pointerId: number } | null>(null);

  const now = usePlayerStore(selectCurrentTrack);
  const paused = usePlayerStore(selectIsPaused);
  const shuffle = usePlayerStore(selectShuffle);
  const isExpanded = usePlayerStore((state) => state.expanded.phase !== "closed");
  const pauseLock = usePlayerStore(selectPauseLock);

  const handlePrev = React.useCallback(() => {
    prevTrackController(false);
  }, []);

  const handleNext = React.useCallback(() => {
    nextTrackController(false);
  }, []);

  const handleShuffleToggle = React.useCallback(() => {
    setShuffleController(!shuffle);
  }, [shuffle]);

  const handleEnded = React.useCallback(() => {
    if (pauseLock) {
      setPausedController(true);
      return;
    }
    const next = nextTrackController(false);
    if (!next) {
      setPausedController(true);
    }
  }, [pauseLock]);

  const requestOverlayExpand = React.useCallback(() => {
    if (!expandSurfaceRef.current || !onRequestExpand || !now) return;
    try {
      const rect = expandSurfaceRef.current.getBoundingClientRect();
      onRequestExpand(now, rect);
      triggerHapticImpact("medium");
    } catch { }
  }, [now, onRequestExpand]);

  React.useEffect(() => {
    expandPointerRef.current = null;
  }, [now?.id]);

  const handleExpandPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!onRequestExpand || !now) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (isInteractiveTarget(e.target)) return;

      expandPointerRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [now, onRequestExpand]
  );

  const handleExpandPointerMove = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const state = expandPointerRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    const dx = Math.abs(e.clientX - state.x);
    const dy = Math.abs(e.clientY - state.y);
    if (dx > EXPAND_CANCEL_PX || dy > EXPAND_CANCEL_PX) {
      expandPointerRef.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
  }, []);

  const handleExpandPointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const state = expandPointerRef.current;
      if (!state || state.pointerId !== e.pointerId) {
        expandPointerRef.current = null;
        return;
      }
      expandPointerRef.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      requestOverlayExpand();
    },
    [requestOverlayExpand]
  );

  const handleExpandPointerCancel = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const state = expandPointerRef.current;
    if (state && state.pointerId === e.pointerId) {
      expandPointerRef.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
  }, []);

  // состояние прогресса/длительности/ошибки
  const [progress, setProgress] = React.useState(0);
  const [duration, setDuration] = React.useState<number>(0);
  const [error, setError] = React.useState<string | null>(null);

  // флажки «добавленности»
  const [isAddedLocal, setIsAddedLocal] = React.useState(false); // локальный плейлист
  const [addedByEvent, setAddedByEvent] = React.useState(false); // серверный плейлист (по событию)
  const [lastAdded, setLastAdded] = React.useState<LastAdded>(null); // данные последнего плейлиста (для клика)

  const BOTTOM_GAP = 14;

  const trackMsgId =
    (now as any)?.msgId ?? (now as any)?.msg_id ?? null;
  const trackChatRaw =
    (now as any)?.chat ??
    (now as any)?.chat_username ??
    (now as any)?.chatUsername ??
    null;
  const normalizedTrackChat =
    trackChatRaw != null
      ? String(trackChatRaw).replace(/^@/, "").toLowerCase()
      : null;

  /** Слушаем «добавлено в плейлист» и учитываем ТОЛЬКО для текущего трека */
  React.useEffect(() => {
    const onAdded = (e: Event) => {
      const det = (e as CustomEvent)?.detail || {};
      if (!det?.trackId || det.trackId !== now?.id) return; // защищаемся от «липкой» плашки
      setAddedByEvent(true);
      setLastAdded(det.playlist as LastAdded);
    };
    window.addEventListener("ogma:playlist-added" as any, onAdded);
    return () => window.removeEventListener("ogma:playlist-added" as any, onAdded);
  }, [now?.id]);

  /** При смене трека — переоцениваем локальную «добавленность» и сбрасываем «серверную» */
  React.useEffect(() => {
    const id = now?.id;
    if (!id) {
      setIsAddedLocal(false);
      setAddedByEvent(false);
      setLastAdded(null);
      return;
    }
    try {
      setIsAddedLocal(inPlaylist(id));
    } catch {
      setIsAddedLocal(false);
    }
    // серверный признак считаем «мгновенной вспышкой» для текущего трека; при смене — сбрасываем
    setAddedByEvent(false);
    setLastAdded(null);
  }, [now?.id]);

  /** Реакция на изменения локального плейлиста (чтобы плашка корректно тухла/загоралась) */
  React.useEffect(() => {
    const onChange = () => {
      const id = now?.id;
      if (!id) {
        setIsAddedLocal(false);
        return;
      }
      try {
        setIsAddedLocal(inPlaylist(id));
      } catch {
        setIsAddedLocal(false);
      }
    };
    window.addEventListener("ogma:playlist-change" as any, onChange);
    return () => window.removeEventListener("ogma:playlist-change" as any, onChange);
  }, [now?.id]);

  React.useEffect(() => {
    const nowTrack = now;
    const matchesTrack = (candidate: any) => {
      if (!nowTrack) return false;
      const nowId = nowTrack.id;
      if (candidate?.id && nowId && String(candidate.id) === String(nowId)) {
        return true;
      }

      const candMsg = candidate?.msgId ?? candidate?.msg_id ?? null;
      if (candMsg != null && trackMsgId != null) {
        const candChatRaw =
          candidate?.chat ??
          candidate?.chat_username ??
          candidate?.chatUsername ??
          null;
        const candChat = candChatRaw
          ? String(candChatRaw).replace(/^@/, "").toLowerCase()
          : null;
        if (Number(candMsg) === Number(trackMsgId)) {
          if (!normalizedTrackChat || !candChat) return true;
          return candChat === normalizedTrackChat;
        }
      }

      return false;
    };

    const onPublicAdded = (event: Event) => {
      const detail = (event as CustomEvent<any>)?.detail ?? {};
      const track = detail.track ?? detail;
      if (!matchesTrack(track)) return;
      const playlistIdRaw = detail.playlistId ?? detail.playlist_id ?? null;
      const handleRaw = detail.handle ?? detail.playlistHandle ?? null;
      const normalizedHandle = handleRaw
        ? String(handleRaw).replace(/^@/, "")
        : null;
      setAddedByEvent(true);
      setLastAdded({
        type: "server",
        id: playlistIdRaw != null ? String(playlistIdRaw) : undefined,
        handle: normalizedHandle,
        title: detail.playlistTitle ?? detail.title ?? null,
        is_public: true,
      });
    };

    const onPublicRemoved = (event: Event) => {
      const detail = (event as CustomEvent<any>)?.detail ?? {};
      const track = detail.track ?? detail;
      if (!matchesTrack(track)) return;
      const playlistIdRaw = detail.playlistId ?? detail.playlist_id ?? null;
      const playlistIdStr = playlistIdRaw != null ? String(playlistIdRaw) : null;
      const handleRaw = detail.handle ?? null;
      const normalizedHandle = handleRaw
        ? String(handleRaw).replace(/^@/, "").toLowerCase()
        : null;
      let cleared = false;
      setLastAdded((prev) => {
        if (!prev || prev.type !== "server") return prev;
        const prevHandle = prev.handle
          ? String(prev.handle).replace(/^@/, "").toLowerCase()
          : null;
        if (playlistIdStr && prev.id && String(prev.id) !== playlistIdStr) {
          return prev;
        }
        if (!playlistIdStr && normalizedHandle && prevHandle && prevHandle !== normalizedHandle) {
          return prev;
        }
        cleared = true;
        return null;
      });
      if (cleared) {
        setAddedByEvent(false);
      }
    };

    window.addEventListener("ogma:public-playlist-item-added" as any, onPublicAdded);
    window.addEventListener("ogma:public-playlist-item-removed" as any, onPublicRemoved);
    return () => {
      window.removeEventListener("ogma:public-playlist-item-added" as any, onPublicAdded);
      window.removeEventListener("ogma:public-playlist-item-removed" as any, onPublicRemoved);
    };
  }, [now, trackMsgId, normalizedTrackChat]);

  /** Итоговый индикатор плашки «Добавлено» */
  const showAdded = (isAddedLocal || addedByEvent) && !!now;

  /** Навигация при клике по плашке */
  const openAddedPlaylist = React.useCallback(() => {
    if (!showAdded) return;
    // локальный — всегда goPlaylist()
    if (lastAdded?.type === "local" || !lastAdded) {
      goPlaylist();
      return;
    }
    // серверный — предпочитаем хэндл
    if (lastAdded?.type === "server") {
      const clean = (lastAdded.handle || "").replace(/^@/, "");
      if (clean) {
        try {
          goPlaylistHandle(clean);
          return;
        } catch {
          // если что-то не так — в локальный, чтобы не ломать UX
          goPlaylist();
          return;
        }
      }
      // если хэндла нет — запасной вариант
      goPlaylist();
    }
  }, [showAdded, lastAdded]);

  // === glue с внешним кодом для управления аудио ===
  const playRequestIdRef = React.useRef(0);
  React.useEffect(() => {
    (window as any).__ogmaPlay = async (t: Track) => {
      const req = ++playRequestIdRef.current;
      try {
        const a = audioRef.current;
        if (!a) return;
        if (a.getAttribute("data-track-id") !== t.id) {
          setAudioSource(a, t);
          setProgress(0);
          setDuration(0);
          setError(null);
        }
        ensureInline(a);
        try { await waitForCanPlay(a); } catch { }
        const p = a.play();
        if (p && typeof (p as any).then === "function") await p;
        if (req !== playRequestIdRef.current) return;
        requestAnimationFrame(() => setPausedController(false));
      } catch (e: any) {
        const msg = String(e?.message || "");
        if (e?.name === "AbortError" || msg.includes("interrupted by a call to pause")) return;
        console.warn("__ogmaPlay failed:", e);
        setError("Не удалось воспроизвести трек");
      }
    };
    (window as any).__ogmaPause = () => {
      playRequestIdRef.current++;
      try { audioRef.current?.pause(); } catch { }
    };
    (window as any).__ogmaGetAudio = () => audioRef.current;
    return () => {
      try { delete (window as any).__ogmaPlay; } catch { }
      try { delete (window as any).__ogmaPause; } catch { }
      try { delete (window as any).__ogmaGetAudio; } catch { }
    };
  }, []);

  // === реакция на входящие пропсы now/paused ===
  React.useEffect(() => {
    const a = audioRef.current;
    if (!a || !now) return;

    const needSrc = a.getAttribute("data-track-id") !== now.id;
    if (needSrc) {
      setAudioSource(a, now);
      a.setAttribute("data-track-id", now.id);
      setProgress(0);
      setDuration(0);
      setError(null);
    }

    const req = ++playRequestIdRef.current;

    (async () => {
      if (paused) {
        playRequestIdRef.current++;
        (window as any).__ogmaPause?.();
        return;
      }

      try {
        ensureInline(a);
        try { await waitForCanPlay(a); } catch { }
        if (req !== playRequestIdRef.current) return;

        const p = a.play();
        if (p && typeof (p as any).then === "function") await p;
        if (req !== playRequestIdRef.current) return;

        requestAnimationFrame(() => setPausedController(false));
      } catch (e: any) {
        const msg = String(e?.message || "");
        if (e?.name !== "AbortError" && !msg.includes("interrupted by a call to pause")) {
          console.warn("__ogmaPlay failed:", e);
        }
        setError("Не удалось воспроизвести трек");
        requestAnimationFrame(() => setPausedController(true));
      }
    })();

    try {
      if ("mediaSession" in navigator && now) {
        // @ts-ignore
        navigator.mediaSession.metadata = new (window as any).MediaMetadata({
          title: now.title,
          artist: (now.artists || []).join(", "),
          album: "OGMA",
        });
        // @ts-ignore
        navigator.mediaSession.setActionHandler?.("previoustrack", handlePrev);
        // @ts-ignore
        navigator.mediaSession.setActionHandler?.("nexttrack", handleNext);
        // @ts-ignore
        navigator.mediaSession.setActionHandler?.("play", async () => {
          try {
            await a.play();
            setPausedController(false);
            setPauseLockController(false);
          } catch { }
        });
        // @ts-ignore
        navigator.mediaSession.setActionHandler?.("pause", () => {
          a.pause();
          setPausedController(true);
          setPauseLockController(true);
        });
      }
    } catch { }
  }, [now, paused, handlePrev, handleNext]);

  // === слушаем события тега <audio> ===
  React.useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      const d = a.duration || 0;
      setDuration(d);
      if (d > 0 && isFinite(d)) setProgress(a.currentTime / d);
    };
    const onPlay = () => setPausedController(false);
    const onPause = () => setPausedController(true);
    const onEndedWrap = () => {
      setProgress(1);
      handleEnded();
    };
    const onError = () =>
      setError(a.error ? `Ошибка воспроизведения (код ${a.error.code})` : "Ошибка воспроизведения");
    const onLoadedMeta = () => setDuration(a.duration || 0);

    a.addEventListener("timeupdate", onTime);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEndedWrap);
    a.addEventListener("error", onError);
    a.addEventListener("loadedmetadata", onLoadedMeta);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEndedWrap);
      a.removeEventListener("error", onError);
      a.removeEventListener("loadedmetadata", onLoadedMeta);
    };
  }, [handleEnded]);

  /** Промотка по проценту */
  const seekTo = (pct: number) => {
    const a = audioRef.current;
    if (!a || !duration || !isFinite(duration)) return;
    const t = Math.max(0, Math.min(duration, pct * duration));
    a.currentTime = t;
    setProgress(duration > 0 ? t / duration : 0);
  };

  const currentSec = Math.max(0, (progress || 0) * (duration || 0));

  return (
    <>
      {/* ==== PLAYER + КНОПКИ (две строки) ==== */}
      <div
        className={
          "fixed left-0 right-0 z-[70] pointer-events-none transition-opacity duration-200 " +
          (isExpanded ? "opacity-0" : "opacity-100")
        }
        style={{
          bottom: `calc(env(safe-area-inset-bottom, 0px) + ${BOTTOM_GAP}px)`,
          paddingBottom: "12px",
        }}
        aria-hidden={isExpanded ? true : false}
      >
        <div
          className={
            "w-full px-2 sm:px-4 pt-2 flex justify-center touch-pan-y " +
            // если развёрнут fullscreen, то ивенты вниз не должны ловиться мини-плеером
            (isExpanded ? "pointer-events-none" : "pointer-events-auto")
          }
        >
          <div className="w-full max-w-[940px] flex flex-col items-center gap-2">
            {/* 1-я строка: плеер (инфо + таймлайн) */}
            <div
              ref={expandSurfaceRef}
              className="w-full"
              onPointerDown={handleExpandPointerDown}
              onPointerMove={handleExpandPointerMove}
              onPointerUp={handleExpandPointerUp}
              onPointerCancel={handleExpandPointerCancel}
              onPointerLeave={(e) => {
                const state = expandPointerRef.current;
                if (state && state.pointerId === e.pointerId) {
                  expandPointerRef.current = null;
                  e.currentTarget.releasePointerCapture?.(e.pointerId);
                }
              }}
            >
              <GlassSurface
                borderRadius={28}
                backgroundOpacity={0.22}
                saturation={1.8}
                className="w-full text-white"
              >
                <div className="mx-auto w-full max-w-[640px] px-4 sm:px-5 py-3 sm:py-3.5 flex flex-col gap-3">
                  {/* Заголовок/Артист слева + кнопка «Артист» справа */}
                  <div className="w-full flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 text-left">
                      <div className="text-[15px] leading-tight font-medium truncate flex items-center gap-2">
                        <span className="truncate">{now?.title ?? ""}</span>

                        {/* Плашка «Добавлено». Появляется только для текущего трека. Кликабельна. */}
                        {showAdded && (
                          <button
                            type="button"
                            onClick={openAddedPlaylist}
                            className="shrink-0 px-2 py-0.5 rounded-md text-[11px]
                                     bg-emerald-500/20 text-emerald-50 border border-emerald-400/30
                                     hover:bg-emerald-500/25 active:bg-emerald-500/30
                                     focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40"
                            aria-label="Открыть плейлист"
                            title={
                              lastAdded?.type === "server"
                                ? `Открыть плейлист ${lastAdded?.handle || lastAdded?.title || "плейлист"}`
                                : "Открыть плейлист"
                            }
                          >
                            В плейлисте
                          </button>
                        )}
                      </div>
                      <div className="text-[13px] leading-tight text-zinc-300 truncate">
                        {(now?.artists ?? []).join(", ")}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        // все артисты трека → чтобы показать чипы на странице артиста
                        const artists = (now?.artists || []).map(a => a.trim()).filter(Boolean);
                        const primary = artists[0];
                        if (!primary) return;
                        // прокидываем «пиров» через глобальную переменную (мягкий и локальный способ)
                        try { (window as any).__ogmaArtistPeers = artists; } catch { }
                        goArtist(primary);
                      }}
                      disabled={!now?.artists?.[0]}
                      className="shrink-0 px-3 py-1.5 rounded-lg text-xs
             bg-white/10 hover:bg-white/15 active:bg-white/20
             border border-white/15 text-white/90
             disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Артист
                    </button>
                  </div>

                  {/* Таймлайн */}
                  <div className="w-full">
                    <div className="flex items-center gap-4">
                      <div className="w-12 text-[12px] tabular-nums opacity-90">
                        {fmt(currentSec)}
                      </div>
                      <div className="flex-1" data-player-interactive>
                        <ElasticSlider
                          value={(progress || 0) * 100}
                          startingValue={0}
                          maxValue={100}
                          className="w-full"
                          onChangeStart={() => { }}
                          onChange={(v) => seekTo(v / 100)}
                          onChangeEnd={(v) => seekTo(v / 100)}
                        />
                      </div>
                      <div className="w-12 text-[12px] tabular-nums text-right opacity-70">
                        -{fmt(Math.max(0, (duration || 0) - currentSec))}
                      </div>
                    </div>
                  </div>

                  {/* Сам <audio/> спрятан — UI свой */}
                  <audio
                    ref={audioRef}
                    preload="metadata"
                    playsInline
                    // @ts-ignore
                    webkit-playsinline="true"
                    controlsList="nodownload noplaybackrate"
                    crossOrigin="anonymous"
                    data-ogma-player="1"
                  >
                    <source data-ogma="1" />
                  </audio>
                </div>
              </GlassSurface>
            </div>

            {/* 2-я строка: кнопки управления */}
            <div className="w-full max-w-[640px] flex items-center justify-center gap-6 py-1">
              <RoundGlassButton
                size={36}
                ariaLabel={shuffle ? "Перемешивание: включено" : "Перемешивание: выключено"}
                title="Перемешать"
                onClick={handleShuffleToggle}
              >
                <div className={shuffle ? "text-white" : "text-white/70"}>
                  <IconShuffle />
                </div>
              </RoundGlassButton>

              <RoundGlassButton
                ariaLabel="Предыдущий"
                title="Предыдущий"
                disabled={!now}
                onPointerDown={(e) => {
                  e.preventDefault();
                  handlePrev();
                }}
              >
                <IconPrevNew />
              </RoundGlassButton>

              <RoundGlassButton
                size={56}
                ariaLabel={paused ? "Воспроизвести" : "Пауза"}
                title={paused ? "Воспроизвести" : "Пауза"}
                disabled={!now}
                onClick={async () => {
                  const a = audioRef.current;
                  if (!a || !now) return;
                  if (paused) {
                    try {
                      ensureInline(a);
                      await a.play();
                      setPausedController(false);
                      setPauseLockController(false);
                    } catch { }
                  } else {
                    a.pause();
                    setPausedController(true);
                    setPauseLockController(true);
                  }
                }}
              >
                {paused ? <IconPlay /> : <IconPause />}
              </RoundGlassButton>

              <RoundGlassButton
                ariaLabel="Следующий"
                title="Следующий"
                disabled={!now}
                onPointerDown={(e) => {
                  e.preventDefault();
                  handleNext();
                }}
              >
                <IconNextNew />
              </RoundGlassButton>

              {/* Кнопка «Добавить в плейлист» */}
              <RoundGlassButton
                id="ogma-player-add-btn"
                size={36}
                ariaLabel="Добавить трек в плейлист"
                title="Добавить в плейлист"
                disabled={!now}
                onClick={() => {
                  if (!now) return;
                  if (onAddToPlaylist) {
                    onAddToPlaylist(now);
                  } else {
                    try {
                      window.dispatchEvent(
                        new CustomEvent("ogma:add-to-playlist", { detail: { track: now, source: "player" } })
                      );
                    } catch { }
                  }
                }}
              >
                <IconAdd />
              </RoundGlassButton>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}