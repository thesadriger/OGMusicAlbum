import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Track } from "@/types/types";
import { motion, PanInfo, useMotionValue, useTransform } from "motion/react";
import { usePlayerStore, selectCurrentTrackId, selectIsPaused } from "@/store/playerStore";
import { toggleTrack as toggleTrackController } from "@/lib/playerController";
import { useViewportPresence } from "@/hooks/useViewportPresence";

// фоны
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

type Props = {
  tracks: Track[];
  title?: string;
  autoplay?: boolean;
  autoplayDelay?: number; // мс
  loop?: boolean;
};

const GAP = 16;
const DRAG_BUFFER = 0;
const VELOCITY_THRESHOLD = 500;
const SPRING = { type: "spring" as const, stiffness: 140, damping: 26, mass: 1.2 };

const BG_LIST = [
  LiquidChrome, Squares, LetterGlitch, Orb, Ballpit, Waves, Iridescence,
  Hyperspeed, Threads, DotGrid, RippleGrid, FaultyTerminal, Dither, Galaxy, PrismaticBurst,
  Lightning, Beams, GradientBlinds, Particles, Plasma, Aurora, PixelBlast, LightRays,
  Silk, DarkVeil, Prism, LiquidEther,
];

const BG_BY_KEY = {
  LiquidChrome, Squares, LetterGlitch, Orb, Ballpit, Waves, Iridescence,
  Hyperspeed, Threads, DotGrid, RippleGrid, FaultyTerminal, Dither, Galaxy, PrismaticBurst,
  Lightning, Beams, GradientBlinds, Particles, Plasma, Aurora, PixelBlast, LightRays,
  Silk, DarkVeil, Prism, LiquidEther,
} as Record<string, React.ComponentType<any>>;

export default function TracksCarousel({
  tracks,
  title = "Рекомендации",
  autoplay = true,
  autoplayDelay = 3500,
  loop = true,
}: Props) {
  const { ref: viewportRef, className: viewportClassName, isVisible } = useViewportPresence<HTMLDivElement>({
    amount: 0.25,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState<number>(760);
  const [idx, setIdx] = useState(0);
  const x = useMotionValue(0);

  const currentId = usePlayerStore(selectCurrentTrackId);
  const isPaused = usePlayerStore(selectIsPaused);

  const handleToggle = useCallback(
    (index: number) => {
      const target = tracks[index];
      toggleTrackController(tracks, index, target?.id);
    },
    [tracks]
  );

  // включение/выключение автоплей
  const [autoPlayEnabled, setAutoPlayEnabled] = useState<boolean>(autoplay);
  useEffect(() => setAutoPlayEnabled(autoplay), [autoplay]);
  const reenableTimerRef = useRef<number | null>(null);

  const pauseAutoplayTemporarily = useCallback(() => {
    setAutoPlayEnabled(false);
    if (reenableTimerRef.current) window.clearTimeout(reenableTimerRef.current);
    reenableTimerRef.current = window.setTimeout(() => {
      setAutoPlayEnabled(true);
    }, autoplayDelay);
  }, [autoplayDelay]);

  useEffect(() => () => {
    if (reenableTimerRef.current) window.clearTimeout(reenableTimerRef.current);
  }, []);

  // ширина карточки
  const cardW = useMemo(() => {
    const w = Math.max(320, Math.min(380, containerW - 2 * 24));
    return w;
  }, [containerW]);
  const trackOffset = cardW + GAP;

  // для центрирования активной карточки
  const centerOffset = useMemo(() => Math.max(0, (containerW - cardW) / 2), [containerW, cardW]);

  // слежение за шириной контейнера
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // автопрокрутка
  useEffect(() => {
    if (!autoPlayEnabled || tracks.length <= 1 || !isVisible) return;
    const t = setInterval(() => {
      setIdx((prev) => (prev >= tracks.length - 1 ? (loop ? 0 : prev) : prev + 1));
    }, autoplayDelay);
    return () => clearInterval(t);
  }, [autoPlayEnabled, autoplayDelay, loop, tracks.length, isVisible]);

  // drag-навигация
  const handleDragEnd = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const off = info.offset.x;
    const vel = info.velocity.x;
    if (off < -DRAG_BUFFER || vel < -VELOCITY_THRESHOLD) {
      setIdx((p) => Math.min(p + 1, tracks.length - 1));
    } else if (off > DRAG_BUFFER || vel > VELOCITY_THRESHOLD) {
      setIdx((p) => Math.max(p - 1, 0));
    }
    // автоплей не включаем здесь — его вернёт таймер pauseAutoplayTemporarily
  };

  const go = (i: number) => {
    pauseAutoplayTemporarily();
    setIdx(Math.max(0, Math.min(i, tracks.length - 1)));
  };
  const prev = () => go(idx - 1);
  const next = () => go(idx + 1);

  // фон
  const [bgVersion, setBgVersion] = useState(0);
  useEffect(() => {
    const onTheme = () => setBgVersion((v) => v + 1);
    window.addEventListener("ogma:theme-changed", onTheme as any);
    return () => window.removeEventListener("ogma:theme-changed", onTheme as any);
  }, []);

  const pickBackground = useCallback((trackId: string) => {
    const idStr = String(trackId);
    let hash = 0;
    for (let i = 0; i < idStr.length; i++) hash = ((hash * 31) + idStr.charCodeAt(i)) >>> 0;
    const pickRandomById = () => BG_LIST[hash % BG_LIST.length] || Waves;
    const mode = (localStorage.getItem("ogma_track_bg_mode") as "random" | "fixed" | null) ?? "random";
    if (mode === "fixed") {
      const k = localStorage.getItem("ogma_track_bg_key") || "";
      if (k && BG_BY_KEY[k]) return BG_BY_KEY[k];
      return pickRandomById();
    }
    return pickRandomById();
  }, []);

  // блок вертикальных жестов
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  return (
    <section
      ref={viewportRef}
      className={`${viewportClassName} relative rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3 overflow-hidden shadow`}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="text-sm text-zinc-500">{title}</div>

        <div className="hidden sm:flex gap-2">
          <button
            onClick={prev}
            className="h-8 w-8 grid place-items-center rounded-lg bg-zinc-200/80 dark:bg-zinc-800/80 hover:opacity-90 active:opacity-80"
            aria-label="Назад"
            title="Назад"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={next}
            className="h-8 w-8 grid place-items-center rounded-lg bg-zinc-200/80 dark:bg-zinc-800/80 hover:opacity-90 active:opacity-80"
            aria-label="Вперёд"
            title="Вперёд"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative overflow-hidden touch-pan-x overscroll-contain select-none"
        style={{ touchAction: "pan-x", overscrollBehavior: "contain" }}
        onWheel={(e) => {
          // блокируем вертикальную прокрутку колесом/тачпадом
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.preventDefault();
        }}
        onTouchStart={(e) => {
          const t = e.touches?.[0];
          if (t) touchStart.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchMove={(e) => {
          const t = e.touches?.[0];
          const s = touchStart.current;
          if (!t || !s) return;
          const dx = Math.abs(t.clientX - s.x);
          const dy = Math.abs(t.clientY - s.y);
          if (dy > dx) e.preventDefault(); // гасим вертикальные жесты
        }}
      >
        <motion.div
          className="flex"
          drag="x"
          onPointerDown={pauseAutoplayTemporarily}
          onDragStart={pauseAutoplayTemporarily}
          onDragEnd={handleDragEnd}
          style={{ x, gap: `${GAP}px` }}
          animate={{ x: centerOffset - idx * trackOffset }}
          transition={SPRING}
          dragConstraints={{
            left: centerOffset - trackOffset * (tracks.length - 1),
            right: centerOffset,
          }}
        >
          {tracks.map((t, i) => {
            const range = [
              centerOffset - (i + 1) * trackOffset,
              centerOffset - i * trackOffset,
              centerOffset - (i - 1) * trackOffset,
            ];
            const rotateY = useTransform(x, range, [90, 0, -90], { clamp: false });

            const active = currentId != null && String(t.id) === currentId;
            const Bg = pickBackground(t.id);

            const HEAVY_BG = new Set<React.ComponentType<any>>([Hyperspeed, Galaxy, LiquidEther]);
            const isHeavy = HEAVY_BG.has(Bg);
            const shouldRenderBg = Math.abs(i - idx) <= (isHeavy ? 0 : 1);

            const bgExtra =
              Bg === (LetterGlitch as unknown as React.ComponentType<any>)
                ? {
                  glitchColors: ["#67d4d9", "#5b95f7", "#66daea"],
                  glitchSpeed: 0.75,
                  centerVignette: false,
                  outerVignette: false,
                  smooth: true,
                  characters: (t.title || "OGMA").slice(0, 18),
                }
                : {};

            return (
              <motion.button
                key={t.id || i}
                onClick={() => {
                  handleToggle(i);
                  pauseAutoplayTemporarily();
                }}
                className={[
                  "relative shrink-0 text-left cursor-pointer active:cursor-grabbing outline-none",
                  "rounded-xl border overflow-hidden bg-transparent",
                  // гарантируем достаточную площадь под фон
                  "min-h-[200px]",
                  active ? "ring-2 ring-blue-500/40 dark:ring-blue-400/40" : "",
                ].join(" ")}
                style={{ width: cardW, rotateY, transformStyle: "preserve-3d", backgroundColor: "transparent" }}
              >
                <div className="absolute inset-0 pointer-events-none z-0">
                  {isVisible && shouldRenderBg ? (
                    // фон явно занимает всю карточку
                    <Bg className="absolute inset-0 w-full h-full" {...bgExtra} />
                  ) : (
                    <div className="absolute inset-0 w-full h-full bg-[radial-gradient(120%_75%_at_50%_0%,rgba(255,255,255,.04)_0%,rgba(255,255,255,0)_60%)]" />
                  )}
                  <div
                    className="absolute inset-0 w-full h-full"
                    style={{ background: "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)" }}
                  />
                </div>

                <div className="relative z-10 p-4">
                  <div className="text-sm mb-1 text-zinc-300">
                    {t.artists?.join(", ") || "Неизвестный исполнитель"}
                  </div>
                  <div className="text-lg font-semibold line-clamp-2 text-white">
                    {t.title || "Без названия"}
                  </div>
                  {!!t.hashtags?.length && (
                    <div className="mt-2 text-xs text-zinc-300/80 line-clamp-1">
                      {t.hashtags.join(" · ")}
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <span
                      className={[
                        "inline-flex items-center justify-center h-8 px-3 rounded-lg text-sm font-medium",
                        active && !isPaused
                          ? "bg-blue-600 text-white"
                          : "bg-zinc-200/80 dark:bg-zinc-800/80 text-zinc-900 dark:text-zinc-50",
                      ].join(" ")}
                    >
                      {active ? (isPaused ? "Продолжить" : "Играет") : "Слушать"}
                    </span>
                    <span className="text-xs text-zinc-300/90">
                      {t.duration ? formatDuration(t.duration) : ""}
                    </span>
                  </div>
                </div>
              </motion.button>
            );
          })}
        </motion.div>
      </div>

      {/* Индикаторы */}
      <div className="mt-3 flex w-full justify-center">
        <div className="flex gap-2">
          {tracks.map((_, i) => (
            <button
              key={i}
              aria-label={`К слайду ${i + 1}`}
              onClick={() => go(i)}
              className={[
                "h-2 w-2 rounded-full transition",
                idx === i ? "bg-zinc-700 dark:bg-zinc-300 scale-110" : "bg-zinc-300/70 dark:bg-zinc-700/70",
              ].join(" ")}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function formatDuration(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}