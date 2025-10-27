// /home/ogma/ogma/ogma-webapp/src/components/TrackCard.tsx
import { useEffect, useMemo, useRef, useState, useCallback, type ComponentType } from "react";
import Counter from "@/components/Counter";
import { useAudioProgressForTrack } from "@/hooks/useAudioProgressForTrack";
import type { Track } from "@/types/types";
import { sendTrackToMe } from "@/lib/api";
import { emitPlayTrack } from "@/hooks/usePlayerBus";
import GradientRing from "@/components/GradientRing";
import { addToPlaylist, inPlaylist, removeFromPlaylist, addItemToPlaylist, listMyPlaylists } from "@/lib/playlists";
import AddToPlaylistPopover from "@/components/AddToPlaylistPopover";
import { useSwipeable } from 'react-swipeable';

// Новые импорты фоновых компонентов React Bits
import LiquidChrome from "@/components/backgrounds/LiquidChrome";
import Squares from "@/components/backgrounds/Squares";
import LetterGlitch from "@/components/backgrounds/LetterGlitch";
import Orb from "@/components/backgrounds/Orb";
import Ballpit from "@/components/backgrounds/Ballpit";
import Waves from "@/components/backgrounds/Waves";
import Iridescence from "@/components/backgrounds/Iridescence";
import Hyperspeed from "@/components/backgrounds/Hyperspeed";
import Threads from "@/components/backgrounds/Threads";
import DotGrid from "@/components/backgrounds/DotGrid";
import RippleGrid from "@/components/backgrounds/RippleGrid";
import FaultyTerminal from "@/components/backgrounds/FaultyTerminal";
import Dither from "@/components/backgrounds/Dither";
import Galaxy from "@/components/backgrounds/Galaxy";
import PrismaticBurst from "@/components/backgrounds/PrismaticBurst";
import Lightning from "@/components/backgrounds/Lightning";
import Beams from "@/components/backgrounds/Beams";
import GradientBlinds from "@/components/backgrounds/GradientBlinds";
import Particles from "@/components/backgrounds/Particles";
import Plasma from "@/components/backgrounds/Plasma";
import Aurora from "@/components/backgrounds/Aurora";
import PixelBlast from "@/components/backgrounds/PixelBlast";
import LightRays from "@/components/backgrounds/LightRays";
import Silk from "@/components/backgrounds/Silk";
import DarkVeil from "@/components/backgrounds/DarkVeil";
import Prism from "@/components/backgrounds/Prism";
import LiquidEther from "@/components/backgrounds/LiquidEther";
import GlassSurface from "@/components/GlassSurface";

type Props = {
  t: Track;
  isActive?: boolean;
  isPaused?: boolean;
  onToggle: () => void;
  mode?: "default" | "playlist";
  onRemoveFromPublic?: (track: Track) => Promise<void> | void;

  /** форсируем режим/ключ фона (нужно для предпросмотров в настройках) */
  forceBgMode?: "random" | "fixed";
  forceBgKey?: string;
};


const TRIGGER_COMMIT = 84;
const MAX_SWIPE = 160;
const LEFT_REVEAL = 96;
const LEFT_MIN_OPEN = 28;
const SCRUB_SENS = 1.5;

// --- параметры натяжения/вибрации ---
const FULL_PULL_PCT = 0.30;
const BUZZ_MIN_MS = 18;
const BUZZ_MAX_MS = 220;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type MyPlaylist = { id: string; title: string; is_public: boolean; handle?: string | null };

export function TrackCard({ t, isActive, isPaused, onToggle, mode = "default", onRemoveFromPublic, forceBgMode, forceBgKey, }: Props) {
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const cancelledByScroll = useRef(false);

  // SCRUB
  const holdTimer = useRef<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubPct, setScrubPct] = useState(0);
  const scrubStart = useRef<{ pct: number; x: number; width: number }>({ pct: 0, x: 0, width: 1 });
  const lastProgressRef = useRef(0);

  const [dx, setDx] = useState(0);
  const [drag, setDrag] = useState(false);
  const [anim, setAnim] = useState<"none" | "snap" | "remove">("none");
  const [leftOpen, setLeftOpen] = useState(false);
  const [toast, setToast] = useState<null | "added" | "exists" | "removed" | "sending" | "sent" | "error">(null);
  const [addedWhere, setAddedWhere] = useState<string | null>(null);

  // выбор плейлиста
  const [chooseOpen, setChooseOpen] = useState(false);
  const [publicPls, setPublicPls] = useState<MyPlaylist[]>([]);
  const [addingRemote, setAddingRemote] = useState(false);
  const [serverContains, setServerContains] = useState<Record<string, boolean>>({});

  // «заморозка» свайпа пока открыт поповер
  const [frozen, setFrozen] = useState(false);
  const FROZEN_DX = TRIGGER_COMMIT + 18;

  const showBg = frozen || drag || Math.abs(dx) > 1 || leftOpen;

  const toastBgClass =
    toast === "added" || toast === "exists" ? "bg-emerald-600/85" :
      toast === "removed" || toast === "error" ? "bg-red-600/85" :
        toast === "sending" || toast === "sent" ? "bg-blue-600/85" : "bg-black/70";

  const cardRef = useRef<HTMLDivElement | null>(null);
  const fullPullPxRef = useRef(120);
  const pivotYRef = useRef(50);
  const lastBuzzAtRef = useRef(0);
  const crossedRef = useRef({ left: false, right: false, reveal: false });

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => { setToast(null); setAddedWhere(null); }, 900);
    return () => clearTimeout(id);
  }, [toast]);

  // пересчитывать фон при смене настроек
  const [bgVersion, setBgVersion] = useState(0);
  useEffect(() => {
    const onTheme = () => setBgVersion(v => v + 1);
    window.addEventListener("ogma:theme-changed", onTheme as any);
    return () => window.removeEventListener("ogma:theme-changed", onTheme as any);
  }, []);

  const playing = !!isActive && !isPaused;

  async function hasTrackInServerPlaylist(playlistId: string, trackId: string): Promise<boolean> {
    const qs = (s: string) => encodeURIComponent(s);
    const tryPaths = [
      `/api/playlists/${qs(playlistId)}/items?track_id=${qs(trackId)}&limit=10`, // ← сначала универсальный
      `/api/playlists/${qs(playlistId)}/has?track_id=${qs(trackId)}`,
      `/api/playlists/${qs(playlistId)}/contains?track_id=${qs(trackId)}`,
    ];

    for (const url of tryPaths) {
      try {
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        if (res.status === 404 && url.includes('/items')) {
          // если даже items 404 — дальше не стреляем, чтобы не плодить 404
          break;
        }
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) continue;

        const j = await res.json();

        // прямые булевые ответы
        if (typeof j?.has === "boolean") return j.has;
        if (typeof j?.exists === "boolean") return j.exists;
        if (typeof j?.contains === "boolean") return j.contains;

        // ответ списком элементов — ищем именно наш трек
        if (Array.isArray(j?.items)) {
          const found = j.items.some((it: any) =>
            it?.track_id === trackId ||
            it?.trackId === trackId ||
            it?.track?.id === trackId ||
            it?.id === trackId
          );
          if (found) return true;
          continue;
        }
      } catch {
        // молча пробуем следующий url
      }
    }
    return false;
  }

  // Прогресс трека
  const resolve = useCallback(() => {
    const audio = document.querySelector(`audio[data-track-id="${t.id}"]`) as HTMLAudioElement | null;
    const isActiveTrack = !!(t.id && playing);
    return { audio, isActive: isActiveTrack, currentTime: audio?.currentTime, duration: audio?.duration };
  }, [t.id, playing]);

  // объявляем getAudio ДО первого использования
  const getAudio = () =>
    document.querySelector(`audio[data-track-id="${t.id}"]`) as HTMLAudioElement | null;

  const progress = useAudioProgressForTrack(t.id, resolve);
  const already = inPlaylist(t.id);

  // --- Таймер трека (мм:сс) ---
  const a = getAudio();
  const hasDur = !!a && Number.isFinite(a.duration) && a.duration > 0;

  let currentSecExact = 0;
  if (isActive) {
    if (scrubbing && hasDur) currentSecExact = scrubPct * a!.duration;
    else if (hasDur) currentSecExact = lastProgressRef.current * a!.duration;
    else currentSecExact = a?.currentTime ?? 0;
  }
  const currentSec = Math.max(0, Math.floor(currentSecExact));
  const mm = Math.floor(currentSec / 60);
  const ss = currentSec % 60;
  const showTimer = isActive && (hasDur || currentSec > 0);



  // --- выбор фоновой анимации React Bits (стабильно "случайно" по id трека) ---
  const BackgroundComp = useMemo<ComponentType<any>>(() => {
    // список без затенения верхнего объекта
    const BG_LIST: ComponentType<any>[] = [
      LiquidChrome, Squares, LetterGlitch, Orb, Ballpit, Waves, Iridescence,
      Hyperspeed, Threads, DotGrid, RippleGrid, FaultyTerminal, Dither, Galaxy, PrismaticBurst,
      Lightning, Beams, GradientBlinds, Particles, Plasma, Aurora, PixelBlast, LightRays,
      Silk, DarkVeil, Prism, LiquidEther,
    ];
    const byKey = {
      LiquidChrome, Squares, LetterGlitch, Orb, Ballpit, Waves, Iridescence,
      Hyperspeed, Threads, DotGrid, RippleGrid, FaultyTerminal, Dither, Galaxy, PrismaticBurst,
      Lightning, Beams, GradientBlinds, Particles, Plasma, Aurora, PixelBlast, LightRays,
      Silk, DarkVeil, Prism, LiquidEther,
    } as Record<string, ComponentType<any>>;

    const pickRandomById = () => {
      const idStr = String(t.id);
      let hash = 0;
      for (let i = 0; i < idStr.length; i++) hash = ((hash * 31) + idStr.charCodeAt(i)) >>> 0;
      return (BG_LIST[hash % BG_LIST.length] || Waves) as ComponentType<any>;
    };

    // 1) источник правды: принудительные пропсы из предпросмотра, иначе — localStorage
    const mode = (forceBgMode ??
      ((localStorage.getItem("ogma_track_bg_mode") as "random" | "fixed" | null) ?? "random")
    ) as "random" | "fixed";

    if (mode === "fixed") {
      const k = (forceBgKey ?? localStorage.getItem("ogma_track_bg_key") ?? "");
      // 2) безопасный откат: если ключ пуст/неизвестный — рендерим «рандом», а не undefined
      if (k && byKey[k]) return byKey[k];
      return pickRandomById();
    }

    // random
    return pickRandomById();
  }, [t.id, bgVersion, forceBgMode, forceBgKey]);

  // дефолтные пропсы только для LetterGlitch
  const bgExtraProps: any =
    BackgroundComp === (LetterGlitch as unknown as ComponentType<any>)
      ? {
        glitchColors: ["#67d4d9", "#5b95f7", "#66daea"],
        glitchSpeed: 0.75,
        centerVignette: false,
        outerVignette: false,
        smooth: true,
        characters: (t.title || "OGMA").slice(0, 18),
      }
      : {};

  // --- ВЫНЕСЕННЫЕ ЭФФЕКТЫ ---

  // 1) держим lastProgressRef актуальным
  useEffect(() => {
    if (isActive) {
      const val = typeof progress === "number" ? progress : 0;
      if (Number.isFinite(val)) lastProgressRef.current = clamp(val, 0, 1);
    } else {
      lastProgressRef.current = 0;
    }
  }, [isActive, progress]);

  // 2) глобально блокируем touchmove только во время скраба (iOS/TG overscroll)
  useEffect(() => {
    const onTouchMove = (ev: TouchEvent) => { if (scrubbing) ev.preventDefault(); };
    if (scrubbing) document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => document.removeEventListener("touchmove", onTouchMove as any);
  }, [scrubbing]);

  // 3) чистим таймер long-press при размонтировании
  useEffect(() => {
    return () => { if (holdTimer.current) clearTimeout(holdTimer.current); };
  }, []);

  // визуальная «натянутость»
  const pullPct = clamp(Math.abs(leftOpen ? dx + LEFT_REVEAL : dx) / Math.max(1, fullPullPxRef.current), 0, 1);
  const tiltDeg = clamp((dx / Math.max(1, fullPullPxRef.current)) * 3.2, -4, 4);
  const scaleK = 1 + 0.015 * pullPct;

  const style: React.CSSProperties = {
    transform:
      scrubbing ? "translate3d(0,0,0)" :
        (anim === "remove" ? `translate3d(-110%,0,0)` : `translate3d(${(frozen ? FROZEN_DX : dx)}px,0,0) rotate(${tiltDeg}deg) scale(${scaleK})`),
    transition:
      anim === "snap"
        ? "transform 180ms cubic-bezier(.2,.8,.2,1), opacity 180ms"
        : anim === "remove"
          ? "transform 200ms ease, opacity 200ms ease"
          : "none",
    opacity: anim === "remove" ? 0 : 1,
    touchAction: (scrubbing || frozen) ? "none" : "pan-y",
    overscrollBehavior: "contain",
    overscrollBehaviorY: "contain",
    willChange: "transform, opacity",
    backfaceVisibility: "hidden",
    isolation: "isolate",
    transformOrigin: `50% ${pivotYRef.current}%`,
  };

  const tg = (window as any)?.Telegram?.WebApp;
  const HAPTIC_OK =
    !!tg?.HapticFeedback &&
    (typeof tg?.isVersionAtLeast === 'function' ? tg.isVersionAtLeast('6.1') : parseFloat(tg?.version || '0') >= 6.1);

  const canHaptic = () => HAPTIC_OK;

  // iOS/Telegram first, fallback to Vibrate API
  const hapticImpact = (kind: "light" | "medium" | "heavy" | "soft" | "rigid" = "light") => {
    const wa = (window as any)?.Telegram?.WebApp;
    if (canHaptic()) { try { wa.HapticFeedback.impactOccurred(kind); return; } catch { } }
    try { navigator.vibrate?.(20); } catch { }
  };
  const hapticTick = () => {
    const wa = (window as any)?.Telegram?.WebApp;
    if (canHaptic()) { try { wa.HapticFeedback.selectionChanged(); return; } catch { } }
    try { navigator.vibrate?.(6); } catch { }
  };

  // --- add flow: локально или показать выбор публичных ---
  const commitAddLocal = () => {
    const { added } = addToPlaylist(t);
    setAddedWhere(null);
    setToast(added ? "added" : "exists");
    hapticImpact(added ? "medium" : "light");
  };

  const commitAdd = async () => {
    try {
      const r = await listMyPlaylists();
      const publics: MyPlaylist[] = (r?.items || []).filter((p: any) => p?.is_public);
      if (Array.isArray(publics) && publics.length > 0) {
        setPublicPls(publics);
        // попытка предзапросить, где уже есть трек
        try {
          const checks = await Promise.all(
            publics.map(async (p) => {
              const ok = await hasTrackInServerPlaylist(p.id, t.id);
              return [p.id, ok] as const;
            })
          );
          const map: Record<string, boolean> = {};
          for (const [id, ok] of checks) if (ok) map[id] = true;
          setServerContains(map);
        } catch { }
        setFrozen(true);
        setAnim("snap");
        setDx(FROZEN_DX);
        setChooseOpen(true);
        hapticImpact("light");
        return;
      }
    } catch { }
    // fallback — локально
    commitAddLocal();
  };

  // разморозка после закрытия поповера
  useEffect(() => {
    if (!chooseOpen && frozen) {
      setAnim("snap");
      setDx(0);
      setFrozen(false);
    }
  }, [chooseOpen, frozen]);

  const commitDownload = async () => {
    setToast("sending"); hapticImpact("medium");
    try { await sendTrackToMe(t); setToast("sent"); } catch { setToast("error"); }
  };

  const moveRaf = useRef<number | null>(null);
  const pendingMove = useRef<{ x: number, y: number } | null>(null);

  // ВЕСЬ расчёт переносим сюда, вычисляем nextDx локально
  const pumpMove = () => {
    moveRaf.current = null;
    if (frozen || chooseOpen) return;
    if (!drag || startX.current == null || startY.current == null) return;
    if (!pendingMove.current) return;

    const { x, y } = pendingMove.current;
    pendingMove.current = null;

    const deltaX = x - (startX.current as number);
    const deltaY = y - (startY.current as number);

    if (Math.abs(deltaY) > 8 && Math.abs(deltaY) > Math.abs(deltaX)) {
      cancelledByScroll.current = true;
    }

    if (!scrubbing && holdTimer.current && (Math.abs(deltaX) > 6 || Math.abs(deltaY) > 6)) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }

    if (scrubbing) {
      const { pct, x: sx, width } = scrubStart.current;
      const dp = ((x - sx) / Math.max(1, width)) * SCRUB_SENS;
      const next = clamp(pct + dp, 0, 1);
      setScrubPct(next);
      lastProgressRef.current = next;
      const a = getAudio();
      if (a && isFinite(a.duration) && a.duration > 0) a.currentTime = next * a.duration;
      return;
    }

    let delta = deltaX;
    if (leftOpen) delta -= -LEFT_REVEAL;
    const limited = delta > 0 ? Math.min(MAX_SWIPE, delta) : Math.max(-MAX_SWIPE, delta);
    const nextDx = leftOpen ? -LEFT_REVEAL + limited : limited;
    setDx(nextDx);

    const pull = clamp(Math.abs(nextDx + (leftOpen ? LEFT_REVEAL : 0)) / Math.max(1, fullPullPxRef.current), 0, 1);
    if (pull < 1) {
      const interval = lerp(BUZZ_MIN_MS, BUZZ_MAX_MS, pull);
      const now = performance.now();
      if (now - lastBuzzAtRef.current >= interval) { hapticTick(); lastBuzzAtRef.current = now; }
    }

    if (nextDx >= TRIGGER_COMMIT && !crossedRef.current.right) { hapticImpact("medium"); crossedRef.current.right = true; }
    else if (nextDx < TRIGGER_COMMIT && crossedRef.current.right) { crossedRef.current.right = false; }

    if (nextDx <= -TRIGGER_COMMIT && !crossedRef.current.left) { hapticImpact("medium"); crossedRef.current.left = true; }
    else if (nextDx > -TRIGGER_COMMIT && crossedRef.current.left) { crossedRef.current.left = false; }

    if (nextDx <= -LEFT_MIN_OPEN && !crossedRef.current.reveal) { hapticImpact("light"); crossedRef.current.reveal = true; }
    else if (nextDx > -LEFT_MIN_OPEN && crossedRef.current.reveal) { crossedRef.current.reveal = false; }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (frozen || chooseOpen) return;
    if (!drag || startX.current == null || startY.current == null) return;

    pendingMove.current = { x: e.clientX, y: e.clientY };
    if (moveRaf.current == null) {
      moveRaf.current = requestAnimationFrame(pumpMove);
    }
  };

  // ВАЖНО: хук очистки — НА УРОВНЕ КОМПОНЕНТА, а не внутри onPointerMove
  useEffect(() => {
    return () => { if (moveRaf.current) cancelAnimationFrame(moveRaf.current); };
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (frozen || chooseOpen) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    startX.current = e.clientX;
    startY.current = e.clientY;
    cancelledByScroll.current = false;
    setDrag(true);
    setAnim("none");

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    fullPullPxRef.current = Math.max(40, rect.width * FULL_PULL_PCT);
    lastBuzzAtRef.current = performance.now();
    crossedRef.current = { left: false, right: false, reveal: false };

    // ось поворота под пальцем
    pivotYRef.current = clamp(((e.clientY - rect.top) / Math.max(1, rect.height)) * 100, 0, 100);

    // --- LONG PRESS → SCRUB ---
    const downX = e.clientX;
    if (isActive) {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      holdTimer.current = window.setTimeout(() => {
        const base = typeof progress === "number" ? progress : lastProgressRef.current;
        const pct0 = clamp(Number.isFinite(base as number) ? (base as number) : 0, 0, 1);
        scrubStart.current = { pct: pct0, x: downX, width: rect.width || 1 };
        setScrubPct(pct0);
        setScrubbing(true);
        setLeftOpen(false);
        setDx(0);
        cancelledByScroll.current = true;
        hapticImpact("light");
      }, 300);
    }
  };

  const onPointerCancel = () => {
    if (frozen || chooseOpen) return;
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (scrubbing) { setScrubbing(false); }
    cancelledByScroll.current = true;
    setDrag(false);
    setAnim("snap");
    crossedRef.current = { left: false, right: false, reveal: false };
    setDx(leftOpen ? -LEFT_REVEAL : 0);
  };

  const onPointerUp = () => {
    if (frozen || chooseOpen) return;
    if (!drag) return;
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (scrubbing) {
      setScrubbing(false);
      setAnim("snap");
      setDx(0);
      setLeftOpen(false);
      crossedRef.current = { left: false, right: false, reveal: false };
      return;
    }
    setDrag(false);

    const abs = Math.abs(dx);
    const wasTap = abs < 6 && !cancelledByScroll.current;

    if (leftOpen && wasTap) {
      commitDownload();
      setAnim("snap"); setDx(0); setLeftOpen(false);
      return;
    }

    if (wasTap) {
      if (isActive) { setAnim("snap"); setDx(0); onToggle(); }
      else { emitPlayTrack(t); setAnim("snap"); setDx(0); onToggle(); }
      return;
    }

    const commitRemove = async () => {
      setAnim("remove");
      hapticImpact("heavy");
      try {
        if (mode === "playlist" && onRemoveFromPublic) {
          await onRemoveFromPublic(t);             // серверное удаление
        } else {
          removeFromPlaylist(t.id);                // локальное
        }
        setToast("removed");
      } catch {
        setToast("error");
      } finally {
        setTimeout(() => {
          setAnim("snap"); setDx(0); setLeftOpen(false);
        }, 200);
      }
    };

    if (dx >= TRIGGER_COMMIT) {
      if (mode === "default") awaitMaybe(commitAdd)();
      else commitDownload();
      setAnim("snap"); setDx(0); setLeftOpen(false);
      return;
    }
    if (dx <= -TRIGGER_COMMIT) {
      if (mode === "playlist") { commitRemove(); return; }
      else { commitDownload(); setAnim("snap"); setDx(0); setLeftOpen(false); return; }
    }

    if (dx < 0 && Math.abs(dx) >= LEFT_MIN_OPEN) {
      setAnim("snap"); setDx(-LEFT_REVEAL); setLeftOpen(true);
      return;
    }

    setAnim("snap"); setDx(0); setLeftOpen(false);
  };

  const leftBgColor =
    mode === "playlist"
      ? `rgba(220,38,38,${0.35 + 0.65 * clamp(-dx / TRIGGER_COMMIT, 0, 1)})`
      : `rgba(37,99,235,${0.35 + 0.65 * clamp(-dx / TRIGGER_COMMIT, 0, 1)})`;
  const rightBgColor =
    mode === "default"
      ? `rgba(132,171,123,${0.35 + 0.65 * clamp(dx / TRIGGER_COMMIT, 0, 1)})`
      : `rgba(37,99,235,${0.35 + 0.65 * clamp(dx / TRIGGER_COMMIT, 0, 1)})`;

  return (
    <div className="relative">
      {showBg && !scrubbing && (
        <>
          {(dx < 0 || leftOpen) && (
            <div
              className="absolute inset-0 rounded-2xl overflow-hidden select-none flex items-center justify-end pr-4"
              style={{ background: leftBgColor, transition: "background 120ms linear" }}>
              <span className="text-white text-sm opacity-90">
                {mode === "playlist" ? "Удалить" : "Скачать"}
              </span>
            </div>
          )}
          {dx > 0 && (
            <div
              className="absolute inset-0 rounded-2xl overflow-hidden select-none flex items-center justify-start pl-4"
              style={{ background: rightBgColor, transition: "background 120ms linear" }}>
              <span className="text-white text-sm font-medium">
                {mode === "default" ? (already ? "В плейлисте" : "В плейлист") : "Скачать"}
              </span>
            </div>
          )}
        </>
      )}

      <div
        ref={cardRef}
        role="button"
        tabIndex={0}
        aria-pressed={!!isActive && !isPaused}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onTouchMoveCapture={(e) => { if (scrubbing) e.preventDefault(); }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
          if (e.key === "Escape" && leftOpen) { setAnim("snap"); setDx(0); setLeftOpen(false); }
        }}
        style={{
          ...style,
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
        }}
        className={
          "relative z-10 cursor-pointer rounded-2xl p-4 shadow bg-white dark:bg-zinc-900 " +
          "border border-zinc-200 dark:border-zinc-800 overflow-hidden select-none " +
          (isActive ? (isPaused ? "opacity-95" : "") : "hover:bg-white/95 dark:hover:bg-zinc-900/95")
        }
      >
        {/* Фоновая анимация из React Bits + серый полупрозрачный прогресс */}
        {isActive && (
          <div className="absolute inset-0 z-0 pointer-events-none">
            {/* фон-анимация */}
            <div className="absolute inset-0 pointer-events-none opacity-70">
              <BackgroundComp className="absolute inset-0 pointer-events-none" {...bgExtraProps} />
            </div>

            {/* СТЕКЛЯННЫЙ прогресс вместо bg-gray-500/50 */}
            <div className="absolute inset-y-0 left-0 pointer-events-none z-[1]"
              style={{ width: `${(scrubbing ? scrubPct : lastProgressRef.current) * 100}%` }}>
              <GlassSurface
                borderRadius={16}
                backgroundOpacity={0.05}  // можно варьировать
                saturation={1}
                blur={25}
                noBorder
                noShadow
                tone="light"
                className="w-full h-full"  // ← будет работать, высота возьмётся из родителя (inset-y-0)
              />
            </div>
          </div>
        )}

        {/* Обводка активного трека */}
        {isActive && (
          <GradientRing
            className="absolute inset-0 z-10"
            radius={16}
            thickness={2}
            colors={["#67d4d9", "#5b95f7", "#66daea", "#5db5f7"]}
            speed={0.6}
            active
          />
        )}

        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0 pr-20 md:pr-24 text-left">
            <div className="text-base font-semibold truncate text-white drop-shadow-[0_1px_2px_rgba(0,0,0,.35)]">
              {t.title}
            </div>
            <div className="text-sm truncate text-zinc-200 drop-shadow-[0_1px_2px_rgba(0,0,0,.35)]">
              {t.artists?.join(", ")}
            </div>
            <div className="mt-1 text-xs truncate text-zinc-300/80 drop-shadow-[0_1px_1px_rgba(0,0,0,.35)]">
              {t.hashtags?.join(" ")}
            </div>
          </div>

          {/* таймер мм:сс справа */}
          {showTimer && (
            <div
              className="
      absolute top-1.5 bottom-1.5 right-1.5
      flex items-center rounded-md px-2
      opacity-40  /* 40% видимости */
    "
            >
              <Counter
                value={mm}
                places={[10, 1]}
                fontSize={50}          /* крупнее */
                padding={0}
                gap={0}                /* меньше расстояние между цифрами */
                textColor="white"
                fontWeight={900}
                gradientHeight={0}
                digitStyle={{ width: '1ch' }}
                counterStyle={{ lineHeight: 1 }}
              />
              <span className="mx-0.5 tabular-nums">:</span>
              <Counter
                value={ss}
                places={[10, 1]}
                fontSize={50}
                padding={0}
                gap={0}
                textColor="white"
                fontWeight={900}
                gradientHeight={0}
                digitStyle={{ width: '1ch' }}
                counterStyle={{ lineHeight: 1 }}
              />
            </div>
          )}
        </div>

        {toast && (
          <div className={`absolute top-2 right-2 z-20 text-xs rounded-md px-2 py-1 ${toastBgClass} text-white shadow-sm pointer-events-none`}>
            {toast === "added" ? (addedWhere ? `Добавлено в ${addedWhere}` : "Добавлено")
              : toast === "exists" ? "Уже в плейлисте"
                : toast === "removed" ? "Удалено"
                  : toast === "sending" ? "Отправляю…"
                    : toast === "sent" ? "Отправлено"
                      : toast === "error" ? "Ошибка отправки"
                        : ""}
          </div>
        )}
      </div>

      <AddToPlaylistPopover
        open={chooseOpen}
        anchorRef={cardRef}
        onClose={() => {
          setChooseOpen(false);
          setFrozen(false);
          setAnim("snap");
          setDx(0);
        }}
        trackTitle={t.title}
        trackArtists={t.artists}
        playlists={publicPls}
        disabled={addingRemote}
        containsServer={serverContains}
        onPickLocal={() => {
          setChooseOpen(false);
          commitAddLocal();
        }}
        onPickServer={async (p) => {
          setAddingRemote(true);
          try {
            await addItemToPlaylist(p.id, t.id);
            const clean = (p.handle || "").toString().replace(/^@/, "");
            setAddedWhere(clean ? `@${clean}` : null);
            setServerContains((m) => ({ ...m, [p.id]: true }));
            setToast("added");
            hapticImpact("medium");

            // уведомим страницу публичного плейлиста (если она открыта)
            if (clean) {
              window.dispatchEvent(new CustomEvent("ogma:public-playlist-item-added", {
                detail: { handle: clean.toLowerCase(), track: t }
              }));
            }
          } catch {
            setToast("error");
          } finally {
            setAddingRemote(false);
            setChooseOpen(false);
          }
        }}
      />
    </div>
  );
}

function awaitMaybe<T extends any[]>(fn: (...a: T) => Promise<any> | any) {
  return (...a: T) => { try { const r = fn(...a); if (r && typeof (r as any).then === "function") (r as any).catch?.(() => { }); } catch { } };
}