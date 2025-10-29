//home/ogma/ogma/ogma-webapp/src/components/ExpandedPlayerOverlay.tsx
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import type { Track } from "@/types/types";

// backgrounds
import ElasticSlider from "@/components/ElasticSlider";
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

// components
import RoundGlassButton from "@/components/RoundGlassButton";
import {
  IconAdd,
  IconShuffle,
  IconNextNew,
  IconPrevNew,
  IconPause,
  IconPlay,
} from "@/components/PlayerIcons";
import GlassSurface from "@/components/GlassSurface";

type Phase = "opening" | "open" | "closing";
type RectLike = { left: number; top: number; width: number; height: number };

type Props = {
  track: Track | null;
  phase: Phase;
  originRect: RectLike | null;
  onOpened: () => void;
  onClosed: () => void;
  onCloseRequested: () => void;

  paused: boolean;
  onTogglePlayPause: () => void;
  onNext: () => void;
  onPrev: () => void;

  getAudio: () => HTMLAudioElement | null;

  shuffle?: boolean;
  onToggleShuffle?: (enabled: boolean) => void;

  onAddToPlaylist?: (t: Track) => void;
};

type BackgroundComponent = ComponentType<any>;

const BACKGROUNDS: BackgroundComponent[] = [
  LiquidChrome,
  Squares,
  LetterGlitch,
  Orb,
  Ballpit,
  Waves,
  Iridescence,
  Hyperspeed,
  Threads,
  DotGrid,
  RippleGrid,
  FaultyTerminal,
  Dither,
  Galaxy,
  PrismaticBurst,
  Lightning,
  Beams,
  GradientBlinds,
  Particles,
  Plasma,
  Aurora,
  PixelBlast,
  LightRays,
  Silk,
  DarkVeil,
  Prism,
  LiquidEther,
];

const BG_BY_KEY: Record<string, BackgroundComponent> = {
  LiquidChrome,
  Squares,
  LetterGlitch,
  Orb,
  Ballpit,
  Waves,
  Iridescence,
  Hyperspeed,
  Threads,
  DotGrid,
  RippleGrid,
  FaultyTerminal,
  Dither,
  Galaxy,
  PrismaticBurst,
  Lightning,
  Beams,
  GradientBlinds,
  Particles,
  Plasma,
  Aurora,
  PixelBlast,
  LightRays,
  Silk,
  DarkVeil,
  Prism,
  LiquidEther,
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, min: number, max: number) =>
  Math.max(min, Math.min(max, x));

function pickBackground(trackId: string | number | null | undefined) {
  const idStr = trackId == null ? "" : String(trackId);
  let hash = 0;
  for (let i = 0; i < idStr.length; i += 1) {
    hash = (hash * 31 + idStr.charCodeAt(i)) >>> 0;
  }

  const mode =
    (typeof window !== "undefined"
      ? (localStorage.getItem("ogma_track_bg_mode") as
          | "random"
          | "fixed"
          | null)
      : null) ?? "random";

  if (mode === "fixed") {
    const key =
      (typeof window !== "undefined"
        ? localStorage.getItem("ogma_track_bg_key")
        : null) || "";
    if (key && BG_BY_KEY[key]) return BG_BY_KEY[key];
  }

  const idx = BACKGROUNDS.length ? hash % BACKGROUNDS.length : 0;
  return BACKGROUNDS[idx] || Waves;
}

function getLetterGlitchProps(track: Track | null) {
  if (!track) return {};
  return {
    glitchColors: ["#67d4d9", "#5b95f7", "#66daea"],
    glitchSpeed: 0.75,
    centerVignette: false,
    outerVignette: false,
    smooth: true,
    characters: (track.title || "OGMA").slice(0, 18),
  };
}

// Анимация открытия/закрытия оверлея
function useAnimationProgress(
  phase: Phase,
  onOpened: () => void,
  onClosed: () => void
) {
  const [progress, setProgress] = useState(() =>
    phase === "opening" ? 0 : phase === "open" ? 1 : 0
  );
  const progressRef = useRef(progress);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    if (phase === "open") {
      // мгновенно зафризить в opened-состояние
      setProgress(1);
      return;
    }

    if (phase === "closing") {
      // если мы уже свернуты, то не запускаем анимацию (во избежание двойного onClosed)
      if (progressRef.current === 0) {
        onClosed();
        return;
      }
    }

    const target = phase === "closing" ? 0 : 1;
    const duration = phase === "opening" ? 260 : 220;
    let raf: number | null = null;
    let start: number | null = null;
    const from = progressRef.current;

    const step = (ts: number) => {
      if (start == null) start = ts;
      const elapsed = ts - start;
      const tRaw = clamp(elapsed / duration, 0, 1);

      // easeInOutCubic
      const t =
        tRaw < 0.5
          ? 4 * tRaw * tRaw * tRaw
          : 1 - Math.pow(-2 * tRaw + 2, 3) / 2;

      const value = from + (target - from) * t;
      progressRef.current = value;
      setProgress(value);

      if (elapsed < duration) {
        raf = requestAnimationFrame(step);
      } else {
        // финальный снап
        setProgress(target);
        progressRef.current = target;
        if (phase === "opening") onOpened();
        if (phase === "closing") onClosed();
      }
    };

    raf = requestAnimationFrame(step);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [phase, onOpened, onClosed]);

  return progress;
}

// ресайз вьюпорта
function useViewportSize() {
  const [vp, setVp] = useState(() => ({
    width: typeof window !== "undefined" ? window.innerWidth : 360,
    height: typeof window !== "undefined" ? window.innerHeight : 640,
  }));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      setVp({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  return vp;
}

// прогресс текущего трека
function useAudioProgress(
  getAudio: () => HTMLAudioElement | null,
  trackId: string | number | null | undefined
) {
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const audio = getAudio();
    if (!audio) {
      setDuration(0);
      setCurrent(0);
      return;
    }

    let raf: number;
    let mounted = true;

    const update = () => {
      if (!mounted) return;
      const dur =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : 0;
      const cur =
        Number.isFinite(audio.currentTime) && audio.currentTime > 0
          ? audio.currentTime
          : 0;
      setDuration(dur);
      setCurrent(cur);
      raf = requestAnimationFrame(update);
    };

    update();

    const onEnded = () => {
      setCurrent(0);
    };

    audio.addEventListener("ended", onEnded);

    return () => {
      mounted = false;
      if (raf) cancelAnimationFrame(raf);
      audio.removeEventListener("ended", onEnded);
    };
  }, [getAudio, trackId]);

  const progress = duration > 0 ? clamp(current / duration, 0, 1) : 0;
  return { duration, current, progress };
}

const fmtTime = (sec: number) => {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
};

export default function ExpandedPlayerOverlay({
  track,
  phase,
  originRect,
  onOpened,
  onClosed,
  onCloseRequested,
  paused,
  onTogglePlayPause,
  onNext,
  onPrev,
  getAudio,
  shuffle,
  onToggleShuffle,
  onAddToPlaylist,
}: Props) {
  const progress = useAnimationProgress(phase, onOpened, onClosed);
  const viewport = useViewportSize();
  const {
    duration,
    current,
    progress: playbackProgress,
  } = useAudioProgress(getAudio, track?.id);

  const [dragState, setDragState] = useState<{
    mode: "none" | "vertical" | "horizontal";
    offsetX: number;
    offsetY: number;
  }>({ mode: "none", offsetX: 0, offsetY: 0 });

  // инфа о текущем жесте
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    mode: "undetermined" | "horizontal" | "vertical";
  } | null>(null);

  // блокируем свайпы на интерактивных элементах
  const shouldIgnoreGesture = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest('[data-expanded-gesture="lock"]'));
  }, []);

  // целевой прямоугольник оверлея (конечное состояние)
  const targetRect = useMemo<RectLike>(() => {
    const safeTop =
      typeof window !== "undefined" && window.visualViewport
        ? window.visualViewport.offsetTop
        : 0;
    const safeBottom =
      typeof window !== "undefined" && window.visualViewport
        ? Math.max(
            0,
            window.innerHeight -
              (window.visualViewport.offsetTop +
                window.visualViewport.height)
          )
        : 0;

    const horizontalMargin = viewport.width >= 768 ? 64 : 24;
    const width = Math.max(320, viewport.width - horizontalMargin);
    const left = Math.max((viewport.width - width) / 2, 8);
    const top = Math.max(12 + safeTop, 12);
    const height = Math.max(
      360,
      viewport.height - top - Math.max(16, safeBottom + 16)
    );

    return { left, top, width, height };
  }, [viewport]);

  const startRect = originRect ?? targetRect;

  const currentRect = {
    left: lerp(startRect.left, targetRect.left, progress),
    top: lerp(startRect.top, targetRect.top, progress),
    width: lerp(startRect.width, targetRect.width, progress),
    height: lerp(startRect.height, targetRect.height, progress),
  };

  const borderRadius = lerp(18, 28, progress);
  const shadowOpacity = 0.12 + 0.28 * progress;

  const Bg = useMemo(
    () => pickBackground(track?.id ?? null),
    [track?.id]
  );

  const bgExtra =
    Bg === (LetterGlitch as unknown as BackgroundComponent)
      ? getLetterGlitchProps(track)
      : {};

  // стиль основного окна плеера
  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    left: `${currentRect.left}px`,
    top: `${currentRect.top}px`,
    width: `${currentRect.width}px`,
    height: `${currentRect.height}px`,
    borderRadius: `${borderRadius}px`,
    overflow: "hidden",
    zIndex: 70,
    pointerEvents: "auto",
    transform: `translate3d(${
      dragState.mode === "horizontal" ? dragState.offsetX : 0
    }px, ${dragState.mode === "vertical" ? dragState.offsetY : 0}px, 0)`,
    boxShadow: `0 34px 80px rgba(15, 18, 25, ${shadowOpacity})`,
    transition: "none",
    background: "rgba(15,15,20,0.92)",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    opacity:
      phase === "closing" && !originRect
        ? Math.max(progress, 0.02)
        : phase === "opening" && !originRect
        ? Math.max(progress, 0.02)
        : 1,
  };

  const backdropOpacity =
    progress *
    (dragState.mode === "vertical"
      ? Math.max(0, 1 - dragState.offsetY / 260)
      : 1);

  const handleSeek = useCallback(
    (pct: number) => {
      const audio = getAudio();
      if (!audio) return;
      const dur =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : 0;
      if (!dur) return;
      const clampedPct = clamp(pct, 0, 1);
      audio.currentTime = clampedPct * dur;
    },
    [getAudio]
  );

  // жесты
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (phase === "closing") return;
    if (shouldIgnoreGesture(e.target)) {
      gestureRef.current = null;
      return;
    }

    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);

    gestureRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      mode: "undetermined",
    };

    setDragState({ mode: "none", offsetX: 0, offsetY: 0 });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;

    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;

    if (gesture.mode === "undetermined") {
      if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) {
        gesture.mode = "vertical";
      } else if (Math.abs(dx) > 14) {
        gesture.mode = "horizontal";
      } else {
        return;
      }
    }

    if (gesture.mode === "vertical") {
      setDragState({
        mode: "vertical",
        offsetX: 0,
        offsetY: Math.max(0, dy),
      });
    } else if (gesture.mode === "horizontal") {
      setDragState({
        mode: "horizontal",
        offsetX: clamp(dx, -260, 260),
        offsetY: 0,
      });
    }
  };

  const finishGesture = useCallback(
    (
      dx: number,
      dy: number,
      mode: "undetermined" | "horizontal" | "vertical"
    ) => {
      gestureRef.current = null;
      setDragState({ mode: "none", offsetX: 0, offsetY: 0 });

      if (mode === "vertical" && dy > 140) {
        onCloseRequested();
        return;
      }

      if (mode === "horizontal") {
        if (dx < -120) {
          onNext();
          return;
        }
        if (dx > 120) {
          onPrev();
          return;
        }
      }
    },
    [onCloseRequested, onNext, onPrev]
  );

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;

    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

    finishGesture(
      e.clientX - gesture.startX,
      e.clientY - gesture.startY,
      gesture.mode
    );
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;

    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

    finishGesture(
      e.clientX - gesture.startX,
      e.clientY - gesture.startY,
      gesture.mode
    );
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[65]"
      aria-hidden={phase === "closing" && progress === 0}
    >
      {/* затемнённый фон за оверлеем */}
      <div
        className="absolute inset-0 bg-black"
        style={{ opacity: backdropOpacity }}
      />

      {/* контейнер центрирования карточки */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{ opacity: progress }}
      >
        <div style={overlayStyle} className="pointer-events-auto">
          <div className="relative flex-1 overflow-hidden">
            {/* фон с анимированным бэкграундом */}
            <div className="absolute inset-0">
              <Bg className="absolute inset-0 w-full h-full" {...bgExtra} />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-black/60" />
            </div>

            {/* контент */}
            <div className="relative h-full flex flex-col">
              {/* header */}
              <div className="flex items-center justify-between px-6 pt-6">
                <span className="text-[15px] tracking-[0.15em] text-white/70">
                  OGMusicAlbum
                </span>

                <button
                  type="button"
                  onClick={onCloseRequested}
                  className="h-9 w-9 rounded-full bg-black/40 border border-white/10 text-white flex items-center justify-center hover:bg-black/55"
                  aria-label="Закрыть плеер"
                >
                  ×
                </button>
              </div>

              {/* центр (инфо трека / слайдер / контролы) */}
              <div
                className="flex-1 flex flex-col items-center justify-end gap-5 px-5 pb-5"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                style={{ touchAction: "none" }}
              >
                {/* трек-инфо */}
                <div className="text-center space-y-2">
                  <div className="text-sm text-white/70">
                    {track?.artists?.length
                      ? track.artists.join(" · ")
                      : "Неизвестный артист"}
                  </div>
                  <div className="text-2xl font-semibold text-white leading-tight">
                    {track?.title || "Без названия"}
                  </div>
                  {track?.hashtags?.length ? (
                    <div className="text-xs text-white/60">
                      {track.hashtags.join("  •  ")}
                    </div>
                  ) : null}
                </div>

                {/* таймлайн + тайминги */}
                <div
                  className="w-full max-w-[520px]"
                  data-expanded-gesture="lock"
                >
                  <ElasticSlider
                    value={playbackProgress * 100}
                    startingValue={0}
                    maxValue={100}
                    leftIcon={<></>}
                    rightIcon={<></>}
                    onChange={(v) => handleSeek(v / 100)}
                    onChangeEnd={(v) => handleSeek(v / 100)}
                  />
                  <div className="flex justify-between text-[12px] text-white/70 mt-1 tabular-nums">
                    <span>{fmtTime(current)}</span>
                    <span>-{fmtTime(Math.max(0, duration - current))}</span>
                  </div>
                </div>

                {/* блок кнопок управления */}
                <div
                  className="flex items-center justify-center gap-6"
                  data-expanded-gesture="lock"
                >
                  {/* Shuffle */}
                  <RoundGlassButton
                    size={36}
                    ariaLabel={
                      shuffle
                        ? "Перемешивание: включено"
                        : "Перемешивание: выключено"
                    }
                    title="Перемешать"
                    onClick={() => onToggleShuffle?.(!shuffle)}
                  >
                    <div
                      className={
                        shuffle
                          ? "text-[#51a2ff]"
                          : "text-white/70"
                      }
                    >
                      <IconShuffle />
                    </div>
                  </RoundGlassButton>

                  {/* Previous */}
                  <RoundGlassButton
                    ariaLabel="Предыдущий трек"
                    title="Предыдущий"
                    disabled={!track}
                    onClick={onPrev}
                  >
                    <IconPrevNew />
                  </RoundGlassButton>

                  {/* Play/Pause */}
                  <RoundGlassButton
                    size={72}
                    ariaLabel={paused ? "Воспроизвести" : "Пауза"}
                    title={paused ? "Воспроизвести" : "Пауза"}
                    disabled={!track}
                    onClick={onTogglePlayPause}
                  >
                    {paused ? <IconPlay size={36} /> : <IconPause size={36} />}
                  </RoundGlassButton>

                  {/* Next */}
                  <RoundGlassButton
                    ariaLabel="Следующий трек"
                    title="Следующий"
                    disabled={!track}
                    onClick={onNext}
                  >
                    <IconNextNew />
                  </RoundGlassButton>

                  {/* Add to playlist */}
                  <RoundGlassButton
                    id="ogma-player-add-btn-expanded"
                    size={36}
                    ariaLabel="Добавить трек в плейлист"
                    title="Добавить в плейлист"
                    disabled={!track}
                    onClick={() => {
                      if (!track) return;
                      if (onAddToPlaylist) {
                        onAddToPlaylist(track);
                      } else {
                        try {
                          window.dispatchEvent(
                            new CustomEvent("ogma:add-to-playlist", {
                              detail: { track, source: "expanded" },
                            })
                          );
                        } catch {
                          // no-op
                        }
                      }
                    }}
                  >
                    <IconAdd />
                  </RoundGlassButton>
                </div>

                {/* подсказки по жестам
                <GlassSurface
                  className="w-full max-w-[480px] bg-white/8 border-white/15 text-white/80 text-sm px-4 py-3 rounded-2xl"
                  data-expanded-gesture="lock"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <div className="text-xs uppercase tracking-[0.2em] text-white/60">
                        Очередь
                      </div>
                      <div className="text-sm font-medium text-white/90">
                        Свайпните влево/вправо, чтобы переключить трек
                      </div>
                    </div>
                    <div className="text-xs text-white/60">
                      Свайп вниз — закрыть
                    </div>
                  </div>
                </GlassSurface> */}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}