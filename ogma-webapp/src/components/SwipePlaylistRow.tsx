// /home/ogma/ogma/ogma-webapp/src/components/SwipePlaylistRow.tsx
import { useRef, useState, useEffect } from "react";

type Playlist = {
  id: string;
  title: string;
  is_public: boolean;
  handle?: string | null;
  item_count?: number | null;
};

type Props = {
  p: Playlist;
  onOpen?: () => void;          // тап по карточке
  onDelete: () => Promise<void> | void; // подтверждённое удаление
};

const TRIGGER_COMMIT = 84;
const MAX_SWIPE = 160;
const LEFT_REVEAL = 96;
const LEFT_MIN_OPEN = 28;
const FULL_PULL_PCT = 0.30;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export default function SwipePlaylistRow({ p, onOpen, onDelete }: Props) {
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const cancelledByScroll = useRef(false);

  const [dx, setDx] = useState(0);
  const [drag, setDrag] = useState(false);
  const [anim, setAnim] = useState<"none" | "snap" | "remove">("none");
  const [leftOpen, setLeftOpen] = useState(false);
  const fullPullPxRef = useRef(120);
  const pivotYRef = useRef(50);
  const crossedRef = useRef({ left: false, reveal: false });
  const lastBuzzAtRef = useRef(0);

  // хаптики (Telegram WebApp → вибрация)
  const hapticImpact = (kind: "light" | "medium" | "heavy" = "light") => {
    try {
      const tg = (window as any)?.Telegram?.WebApp?.HapticFeedback;
      if (tg?.impactOccurred) { tg.impactOccurred(kind); return; }
    } catch { }
    try { navigator.vibrate?.(kind === "heavy" ? 30 : kind === "medium" ? 20 : 12); } catch { }
  };
  const hapticTick = () => {
    try {
      const tg = (window as any)?.Telegram?.WebApp?.HapticFeedback;
      if (tg?.selectionChanged) { tg.selectionChanged(); return; }
    } catch { }
    try { navigator.vibrate?.(6); } catch { }
  };

  // визуальная «натянутость»
  const pullPct = clamp(Math.abs(leftOpen ? dx + LEFT_REVEAL : dx) / Math.max(1, fullPullPxRef.current), 0, 1);
  const tiltDeg = clamp((dx / Math.max(1, fullPullPxRef.current)) * 3.2, -4, 4);
  const scaleK = 1 + 0.012 * pullPct;

  const style: React.CSSProperties = {
    transform:
      anim === "remove"
        ? "translate3d(-110%,0,0)"
        : `translate3d(${dx}px,0,0) rotate(${tiltDeg}deg) scale(${scaleK})`,
    transition:
      anim === "snap"
        ? "transform 180ms cubic-bezier(.2,.8,.2,1), opacity 180ms"
        : anim === "remove"
          ? "transform 200ms ease, opacity 200ms ease"
          : "none",
    opacity: anim === "remove" ? 0 : 1,
    touchAction: "pan-y",
    willChange: "transform, opacity",
    backfaceVisibility: "hidden",
    transformOrigin: `50% ${pivotYRef.current}%`,
  };

  useEffect(() => {
    return () => { /* clean */ };
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    startX.current = e.clientX;
    startY.current = e.clientY;
    cancelledByScroll.current = false;
    setDrag(true);
    setAnim("none");

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    fullPullPxRef.current = Math.max(40, rect.width * FULL_PULL_PCT);
    pivotYRef.current = clamp(((e.clientY - rect.top) / Math.max(1, rect.height)) * 100, 0, 100);
    lastBuzzAtRef.current = performance.now();
    crossedRef.current = { left: false, reveal: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || startX.current == null || startY.current == null) return;

    const deltaX = e.clientX - startX.current;
    const deltaY = e.clientY - startY.current;

    if (Math.abs(deltaY) > 8 && Math.abs(deltaY) > Math.abs(deltaX)) {
      cancelledByScroll.current = true;
    }

    let delta = deltaX;
    if (leftOpen) delta -= -LEFT_REVEAL;
    const limited = delta > 0 ? Math.min(MAX_SWIPE, delta) : Math.max(-MAX_SWIPE, delta);
    const nextDx = leftOpen ? -LEFT_REVEAL + limited : limited;
    setDx(nextDx);

    // adaptive buzz
    const pull = clamp(Math.abs(nextDx + (leftOpen ? LEFT_REVEAL : 0)) / Math.max(1, fullPullPxRef.current), 0, 1);
    if (pull < 1) {
      const min = 18, max = 220;
      const interval = min + (max - min) * pull;
      const now = performance.now();
      if (now - lastBuzzAtRef.current >= interval) {
        hapticTick();
        lastBuzzAtRef.current = now;
      }
    }

    if (nextDx <= -TRIGGER_COMMIT && !crossedRef.current.left) { hapticImpact("medium"); crossedRef.current.left = true; }
    else if (nextDx > -TRIGGER_COMMIT && crossedRef.current.left) { crossedRef.current.left = false; }

    if (nextDx <= -LEFT_MIN_OPEN && !crossedRef.current.reveal) { hapticImpact("light"); crossedRef.current.reveal = true; }
    else if (nextDx > -LEFT_MIN_OPEN && crossedRef.current.reveal) { crossedRef.current.reveal = false; }
  };

  const commitRemove = async () => {
    setAnim("remove");
    hapticImpact("heavy");
    setTimeout(async () => {
      try { await onDelete(); } finally { /* row disappears optimистично */ }
    }, 180);
  };

  const onPointerUp = () => {
    if (!drag) return;
    setDrag(false);

    const abs = Math.abs(dx);
    const wasTap = abs < 6 && !cancelledByScroll.current;

    // тап по открытой «удалилке» = удаление
    if (leftOpen && wasTap) { commitRemove(); return; }

    // обычный тап → открыть (если задано)
    if (wasTap) {
      setAnim("snap"); setDx(0); setLeftOpen(false);
      onOpen?.();
      return;
    }

    if (dx <= -TRIGGER_COMMIT) { commitRemove(); return; }

    if (dx < 0 && Math.abs(dx) >= LEFT_MIN_OPEN) {
      setAnim("snap"); setDx(-LEFT_REVEAL); setLeftOpen(true);
      return;
    }

    setAnim("snap"); setDx(0); setLeftOpen(false);
  };

  const leftBgColor = `rgba(220,38,38,${0.35 + 0.65 * clamp(-dx / TRIGGER_COMMIT, 0, 1)})`;
  const showBg = drag || Math.abs(dx) > 1 || leftOpen;

  return (
    <div className="relative">
      {/* UNDERLAY: удалить */}
      {showBg && (
        <div
          className="absolute inset-0 rounded-xl overflow-hidden select-none flex items-center justify-end pr-4"
          style={{ background: leftBgColor, transition: "background 120ms linear" }}
        >
          <span className="text-white text-sm opacity-90">Удалить</span>
        </div>
      )}

      {/* CARD */}
      <div
        role="button"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { setAnim("snap"); setDx(leftOpen ? -LEFT_REVEAL : 0); setDrag(false); }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen?.(); }
          if (e.key === "Escape" && leftOpen) { setAnim("snap"); setDx(0); setLeftOpen(false); }
        }}
        style={{
          ...style,
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
        }}
        className="z-10 cursor-pointer rounded-xl px-3 py-2 bg-white/60 dark:bg-zinc-900/60
                   border border-zinc-200 dark:border-zinc-800 overflow-hidden select-none"
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="font-medium truncate">
              {p.title}
              {p.is_public && p.handle && <span className="ml-2 text-xs text-blue-600">@{p.handle}</span>}
            </div>
            <div className="text-xs text-zinc-500">{p.item_count ?? 0} трек(ов)</div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {p.is_public && p.handle ? (
              <span className="text-xs px-2 py-1 rounded-lg bg-zinc-200 dark:bg-zinc-800">
                Открыть
              </span>
            ) : (
              <span className="text-xs text-zinc-500">приватный</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}