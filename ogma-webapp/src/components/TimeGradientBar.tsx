import React from "react";
import { useSmoothPalette, type Palette4 } from "@/lib/gradients";

type Props = {
  /** 0..1 прогресс */
  progress: number;
  /** 4-точечный градиент */
  colors?: Palette4;
  /** крутить точки (по секундам) */
  active?: boolean;

  /** скраббинг */
  onScrubStart?: () => void;
  onScrub?: (pct: number) => void;
  onScrubEnd?: (pct: number) => void;

  /** высота полосы */
  height?: number;

  /** компактный режим для плеера: заголовок/артисты над полосой */
  collapsed?: boolean;
  title?: string;
  artists?: string[];

  /** опциональные кнопки переключения треков */
  onPrev?: () => void;
  onNext?: () => void;

  /** показывать ли круглый бегунок (по умолчанию выключен) */
  showKnob?: boolean;
};

const DEF_COLORS: Palette4 = ["#67d4d9", "#5b95f7", "#66daea", "#5db5f7"];

export default function TimeGradientBar({
  progress,
  colors = DEF_COLORS,
  active = true,
  onScrubStart,
  onScrub,
  onScrubEnd,
  height = 6,
  collapsed = false,
  title,
  artists,
  onPrev,
  onNext,
  showKnob = false, // <= по умолчанию бегунок скрыт
}: Props) {
  const barRef = React.useRef<HTMLDivElement | null>(null);
  const draggingRef = React.useRef(false);
  const [isDragging, setIsDragging] = React.useState(false);

  const rotated = useSmoothPalette(colors, active, 0.35);
  const pct = Math.max(0, Math.min(1, progress));
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

  const getPctFromEvent = (clientX: number) => {
    const el = barRef.current;
    if (!el) return pct;
    const r = el.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!barRef.current) return;
    draggingRef.current = true;
    setIsDragging(true);
    barRef.current.setPointerCapture?.(e.pointerId);
    onScrubStart?.();
    onScrub?.(getPctFromEvent(e.clientX));
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    onScrub?.(getPctFromEvent(e.clientX));
  };
  const finish = (clientX?: number) => {
    if (!draggingRef.current) return;
    const p = clientX == null ? pct : getPctFromEvent(clientX);
    draggingRef.current = false;
    setIsDragging(false);
    onScrubEnd?.(p);
  };
  const onPointerUp = (e: React.PointerEvent) => finish(e.clientX);
  const onPointerCancel = () => finish();

  // размеры бегунка (если он включен)
  const knobBase = 12, knobActive = 18;
  const knob = isDragging ? knobActive : knobBase;

  return (
    <div className="w-full">
      {collapsed && (title || artists?.length) && (
        <div className="mb-1 text-[13px] leading-tight text-white truncate">
          <span className="font-medium">{title}</span>
          {artists?.length ? <span className="opacity-80"> — {artists.join(", ")}</span> : null}
        </div>
      )}

      <div className="flex items-center gap-2">
        {onPrev && (
          <button
            onPointerDown={(e) => { e.preventDefault(); onPrev?.(); }}
            className="shrink-0 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white"
            aria-label="Предыдущий"
            title="Предыдущий"
          >
            ⏮
          </button>
        )}

        {/* интерактивная полоса — весь скраббинг здесь */}
        <div
          ref={barRef}
          className="flex-1 overflow-hidden relative select-none touch-none cursor-pointer"
          style={{
            height,
            borderRadius: height / 2,
            background: "rgba(63,63,70,.25)",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          {/* твёрдая заливка */}
          <div
            className="h-full"
            style={{
              width: `${pct * 100}%`,
              transition: isDragging ? "none" : "width 120ms linear",
              background: `linear-gradient(90deg, ${rotated[0]}, ${rotated[1]}, ${rotated[2]}, ${rotated[3]})`,
            }}
          />
          {/* мягкий хвост */}
          <div
            className="absolute inset-y-0 left-0 pointer-events-none"
            style={{
              width: `calc(${pct * 100}% + 28px)`,
              background: `linear-gradient(90deg, ${rotated[0]}, ${rotated[1]}, ${rotated[2]}, ${rotated[3]})`,
              filter: "blur(14px)",
              opacity: 0.55,
              transition: isDragging ? "none" : "width 120ms linear",
            }}
          />
          {showKnob && (
            <div
              className="absolute top-1/2 -translate-y-1/2"
              style={{
                left: `calc(${pct * 100}% - ${knob / 2}px)`,
                width: knob,
                height: knob,
                borderRadius: 999,
                background: "#fff",
                opacity: 0.95,
                boxShadow: "0 0 0 2px rgba(0,0,0,.15)",
                transition: isDragging
                  ? "left 80ms linear"
                  : "left 80ms linear, width 120ms ease, height 120ms ease",
              }}
            />
          )}
        </div>

        {onNext && (
          <button
            onPointerDown={(e) => { e.preventDefault(); onNext?.();}}
            className="shrink-0 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white"
            aria-label="Следующий"
            title="Следующий"
          >
            ⏭
          </button>
        )}
      </div>
    </div>
  );
}