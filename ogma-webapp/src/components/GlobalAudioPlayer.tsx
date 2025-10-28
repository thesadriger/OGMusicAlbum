// src/components/GlobalAudioPlayer.tsx
import React from "react";
import type { Track } from "@/types/types";
import ElasticSlider from "@/components/ElasticSlider";
import { streamUrlFor } from "@/lib/api";
import { goArtist, goPlaylist, goPlaylistHandle } from "@/lib/router";
import GlassSurface from "@/components/GlassSurface";
import { inPlaylist } from "@/lib/playlists";

/** Что за плейлист был последним, куда добавили текущий трек */
type LastAdded =
  | { type: "local" }
  | { type: "server"; id?: string; handle?: string | null; title?: string | null; is_public?: boolean }
  | null;

type Props = {
  now: Track | null;
  paused: boolean;
  onEnded?: () => void;
  onPlayPauseChange?: (paused: boolean) => void;

  // для медиа-кнопок
  onPrev?: () => boolean | void;
  onNext?: () => boolean | void;

  // очередь
  queue?: Track[];
  currentIndex?: number;
  onPickFromQueue?: (i: number) => void;

  // добавление в плейлист из плеера
  onAddToPlaylist?: (track: Track) => void;

  // перемешивание
  shuffle?: boolean;
  onToggleShuffle?: (enabled: boolean) => void;
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

// --- Иконки ---
const IconPlay = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path d="M8 5.5v13a1 1 0 001.5.9l9.5-6.5a1 1 0 000-1.7L9.5 4.7A1 1 0 008 5.5z" fill="currentColor" />
  </svg>
);
const IconPause = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="6.5" y="4.8" width="3.4" height="14.4" rx="1.2" fill="currentColor" />
    <rect x="14.1" y="4.8" width="3.4" height="14.4" rx="1.2" fill="currentColor" />
  </svg>
);
const IconNextNew = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path
      d="M15.3371,12.4218 L5.76844,18.511 C5.43558,18.7228 5,18.4837 5,18.0892 L5,5.91084 C5,5.51629 5.43558,5.27718 5.76844,5.48901 L15.3371,11.5782 C15.6459,11.7746 15.6459,12.2254 15.3371,12.4218 Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const IconPrevNew = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <g transform="translate(24,0) scale(-1,1)">
      <path
        d="M15.3371,12.4218 L5.76844,18.511 C5.43558,18.7228 5,18.4837 5,18.0892 L5,5.91084 C5,5.51629 5.43558,5.27718 5.76844,5.48901 L15.3371,11.5782 C15.6459,11.7746 15.6459,12.2254 15.3371,12.4218 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </g>
  </svg>
);
const IconAdd = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1z" fill="currentColor" />
  </svg>
);
const IconShuffle = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
    <path d="M21.333,149.327H64c18.773,0,37.227,4.928,53.333,14.272c3.371,1.963,7.061,2.88,10.688,2.88
      c7.36,0,14.528-3.819,18.475-10.624c5.931-10.197,2.432-23.253-7.744-29.163C116.117,113.594,90.283,106.66,64,106.66H21.333
      C9.536,106.66,0,116.218,0,127.994S9.536,149.327,21.333,149.327z" fill="currentColor" />
    <path d="M320,149.327h42.667v64c0,8.192,4.715,15.68,12.075,19.221c2.965,1.408,6.123,2.112,9.259,2.112
      c4.757,0,9.472-1.6,13.333-4.672L504,144.655c5.056-4.053,8-10.176,8-16.661c0-6.485-2.944-12.608-8-16.661L397.333,25.999
      c-6.421-5.12-15.232-6.101-22.592-2.56s-12.075,11.029-12.075,19.221v64H320c-82.325,0-149.333,66.987-149.333,149.333
      c0,58.816-47.851,106.667-106.667,106.667H21.333C9.536,362.66,0,372.218,0,383.994s9.536,21.333,21.333,21.333H64
      c82.325,0,149.333-66.987,149.333-149.333C213.333,197.178,261.184,149.327,320,149.327z" fill="currentColor" />
    <path d="M504,367.336l-106.667-85.333c-6.421-5.141-15.232-6.123-22.592-2.581c-7.36,3.563-12.075,11.029-12.075,19.243v64H320
      c-21.077,0-41.472-6.144-58.965-17.771c-9.856-6.485-23.061-3.861-29.568,5.973c-6.528,9.813-3.861,23.061,5.952,29.568
      c24.512,16.277,53.056,24.896,82.581,24.896h42.667v64c0,8.192,4.715,15.68,12.075,19.221c2.965,1.408,6.123,2.112,9.259,2.112
      c4.757,0,9.472-1.6,13.333-4.672L504,400.659c5.056-4.053,8-10.197,8-16.661C512,377.512,509.056,371.368,504,367.336z"
      fill="currentColor" />
  </svg>
);

// формат М:СС
const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
};

// ── RoundGlassButton: мягкая анимация нажатия ────────────────────────────────
function usePrefersReducedMotion() {
  const [prefers, setPrefers] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => setPrefers(e.matches);
    setPrefers(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return prefers;
}

/** Кнопка с мягкой «стеклянной» интеракцией */
function RoundGlassButton({
  id,
  size = 48,
  disabled,
  ariaLabel,
  title,
  onClick,
  onPointerDown,
  children,
}: {
  id?: string;
  size?: number;
  disabled?: boolean;
  ariaLabel: string;
  title?: string;
  onClick?: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const btnRef = React.useRef<HTMLButtonElement>(null);

  const pressIn = React.useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    if (reduced || !el.animate) {
      el.style.transition = "transform 120ms cubic-bezier(.2,.8,.2,1)";
      el.style.transform = "scale(0.96)";
      return;
    }
    el.animate(
      [{ transform: "scale(1)" }, { transform: "scale(0.96)" }],
      { duration: 130, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }
    );
  }, [reduced]);

  const release = React.useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    if (reduced || !el.animate) {
      el.style.transform = "scale(1)";
      return;
    }
    el.animate(
      [
        { transform: "scale(0.96)" },
        { transform: "scale(1.06)" },
        { transform: "scale(1)" },
      ],
      { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }
    );
  }, [reduced]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") pressIn();
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") release();
  };

  return (
    <GlassSurface
      width={size}
      height={size}
      borderRadius={9999}
      backgroundOpacity={0.22}
      saturation={1.8}
      className="shrink-0"
    >
      <button
        id={id}
        ref={btnRef}
        type="button"
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={onClick}
        onPointerDown={(e) => {
          pressIn();
          onPointerDown?.(e);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerLeave={release}
        onBlur={release}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        className="w-full h-full grid place-items-center rounded-full
                   text-white/90 hover:text-white
                   disabled:opacity-40 disabled:pointer-events-none
                   outline-none focus-visible:ring-2 focus-visible:ring-white/40
                   will-change-transform select-none bg-transparent"
        style={{ transition: reduced ? undefined : "transform 180ms cubic-bezier(.2,.8,.2,1)" }}
      >
        {children}
      </button>
    </GlassSurface>
  );
}

export default function GlobalAudioPlayer({
  now,
  paused,
  onEnded,
  onPlayPauseChange,
  onPrev,
  onNext,
  queue = [],
  currentIndex = -1,
  onPickFromQueue,
  onAddToPlaylist,
  shuffle = false,
  onToggleShuffle,
}: Props) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

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
        requestAnimationFrame(() => onPlayPauseChange?.(false));
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
    return () => {
      try { delete (window as any).__ogmaPlay; } catch { }
      try { delete (window as any).__ogmaPause; } catch { }
    };
  }, [onPlayPauseChange]);

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

        requestAnimationFrame(() => onPlayPauseChange?.(false));
      } catch (e: any) {
        const msg = String(e?.message || "");
        if (e?.name !== "AbortError" && !msg.includes("interrupted by a call to pause")) {
          console.warn("__ogmaPlay failed:", e);
        }
        setError("Не удалось воспроизвести трек");
        requestAnimationFrame(() => onPlayPauseChange?.(true));
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
        navigator.mediaSession.setActionHandler?.("previoustrack", onPrev || null);
        // @ts-ignore
        navigator.mediaSession.setActionHandler?.("nexttrack", onNext || null);
        // @ts-ignore
        navigator.mediaSession.setActionHandler?.("play", async () => { try { await a.play(); onPlayPauseChange?.(false); } catch { } });
        // @ts-ignore
        navigator.mediaSession.setActionHandler?.("pause", () => { a.pause(); onPlayPauseChange?.(true); });
      }
    } catch { }
  }, [now, paused, onPlayPauseChange, onPrev, onNext]);

  // === слушаем события тега <audio> ===
  React.useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      const d = a.duration || 0;
      setDuration(d);
      if (d > 0 && isFinite(d)) setProgress(a.currentTime / d);
    };
    const onPlay = () => onPlayPauseChange?.(false);
    const onPause = () => onPlayPauseChange?.(true);
    const onEndedWrap = () => { setProgress(1); onEnded?.(); };
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
  }, [onEnded, onPlayPauseChange]);

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
        className="fixed left-0 right-0 z-[70] pointer-events-none"
        style={{
          bottom: `calc(env(safe-area-inset-bottom, 0px) + ${BOTTOM_GAP}px)`,
          paddingBottom: "12px",
        }}
      >
        <div className="w-full px-2 sm:px-4 pt-2 flex justify-center pointer-events-auto touch-pan-y">
          <div className="w-full max-w-[940px] flex flex-col items-center gap-2">
            {/* 1-я строка: плеер (инфо + таймлайн) */}
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
                    <div className="flex-1">
                      <ElasticSlider
                        value={(progress || 0) * 100}
                        startingValue={0}
                        maxValue={100}
                        leftIcon={<></>}
                        rightIcon={<></>}
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
                >
                  <source data-ogma="1" />
                </audio>
              </div>
            </GlassSurface>

            {/* 2-я строка: кнопки управления */}
            <div className="w-full max-w-[640px] flex items-center justify-center gap-6 py-1">
              <RoundGlassButton
                size={36}
                ariaLabel={shuffle ? "Перемешивание: включено" : "Перемешивание: выключено"}
                title="Перемешать"
                onClick={() => onToggleShuffle?.(!shuffle)}
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
                  onPrev?.();
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
                      onPlayPauseChange?.(false);
                    } catch { }
                  } else {
                    a.pause();
                    onPlayPauseChange?.(true);
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
                  onNext?.();
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