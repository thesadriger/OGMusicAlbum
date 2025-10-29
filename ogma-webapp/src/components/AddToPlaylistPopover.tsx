import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type PlaylistLite = {
  id: string;
  title: string;
  handle?: string | null;
  is_public?: boolean;
};

type Props = {
  trackId?: string;
  open: boolean;
  anchorRef: React.RefObject<HTMLElement>;
  onClose: () => void;
  trackTitle?: string;
  trackArtists?: string[];
  playlists: PlaylistLite[];
  disabled?: boolean;
  onPickLocal: () => void;
  onPickServer: (p: PlaylistLite, trackId: string) => void | Promise<void>;
  containsServer?: Record<string, boolean>;
  intent?: "default" | "plus";
};

type Placement = "left" | "right" | "center";

const POPOVER_WIDTH = 256; // px
const MARGIN = 8;

export default function AddToPlaylistPopover({
  open,
  anchorRef,
  onClose,
  trackTitle,
  trackArtists,
  playlists,
  disabled,
  onPickLocal,
  onPickServer,
  containsServer,
  intent = "default",
  trackId,
}: Props) {
  const [coords, setCoords] = useState<{
    top: number; left: number; height: number; placement: Placement;
  }>({ top: 0, left: 0, height: 0, placement: "left" });

  const rootRef = useRef<HTMLDivElement>(null);

  // всегда портал в BODY, чтобы position:fixed был относительно вьюпорта,
  // а не трансформированного контейнера (#root с translate/scale/blur и т.п.)
  const portalHost = (typeof document !== "undefined" ? document.body : undefined) as HTMLElement;

  const computePosition = () => {
    const el = anchorRef.current;
    if (!el) return;

    const r = el.getBoundingClientRect();
    const vw = Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0);
    const vh = Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0);

    const measured = rootRef.current?.getBoundingClientRect().width || POPOVER_WIDTH;
    const widthSide = Math.min(POPOVER_WIDTH, Math.floor(vw * 0.8), measured);

    const spaceL = r.left;
    const spaceR = vw - r.right;

    // спец-режим для "+" — всегда поверх плеера и над ним
    // if (intent === "plus") {
    //   const cx = Math.floor(vw / 2);
    //   // якоримся по верхней грани кнопки в плеере
    //   const cy = Math.max(24, r.top);
    //   setCoords({ top: cy, left: cx, height: 0, placement: "center" });
    //   return;
    // }

    let placement: Placement;
    if (spaceL >= widthSide + MARGIN + 4) placement = "left";
    else if (spaceR >= widthSide + MARGIN + 4) placement = "right";
    else placement = "center";

    if (placement === "center") {
      const cx = Math.floor(vw / 2);
      const cy = Math.floor(Math.min(vh - 24, Math.max(24, r.top + r.height / 2)));
      setCoords({ top: cy, left: cx, height: 0, placement });
      return;
    }

    let left = placement === "left" ? r.left - MARGIN : r.right + MARGIN;
    if (placement === "right" && left + widthSide > vw - MARGIN) left = vw - MARGIN - widthSide;
    if (placement === "left" && left < MARGIN) left = MARGIN;

    setCoords({ top: r.top, left, height: r.height, placement });
  };

  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
    // ещё один тик — когда ref установится и ширина станет известной точно
    const id = setTimeout(() => computePosition(), 0);

    const onScroll = () => computePosition();
    const onResize = () => computePosition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(id);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // закрытие по клику-вне/тачу-вне без полноэкранного fixed-оверлея
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node | null;
      if (!rootRef.current?.contains(t as Node) && !anchorRef.current?.contains(t as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, onClose, anchorRef]);

  // Хуки — всегда до любых early-returns
  const list = useMemo(() => playlists || [], [playlists]);
  // высота одной строки публичного плейлиста для вычисления maxHeight
  const [rowH, setRowH] = useState(48);

  // когда поповер открылся / список обновился — измеряем высоту первой строки
  // (ВАЖНО: хук располагаем до любых early-return, чтобы не ломать порядок хуков)
  useLayoutEffect(() => {
    if (!open) return;
    const first = rootRef.current?.querySelector('[data-pl-item]') as HTMLElement | null;
    if (first) {
      const h = Math.ceil(first.getBoundingClientRect().height) || 48;
      setRowH(h);
    }
  }, [open, list.length]);

  // ранний выход — только после всех хуков
  if (!open) return null;

  const isIOS = typeof navigator !== "undefined" && /iP(ad|hone|od)/i.test(navigator.userAgent);
  const isTG = typeof window !== "undefined" && !!(window as any)?.Telegram?.WebApp;
  const allowBackdrop =
    !isIOS && !isTG && typeof CSS !== "undefined" && !!CSS.supports?.("backdrop-filter: blur(1px)");

  return createPortal(
    <>
      {coords.placement === "center" && (
        <div
          className={"fixed inset-0 z-[1500] " + (allowBackdrop ? "backdrop-blur-sm bg-black/30" : "bg-black/35")}
          onClick={onClose}
        />
      )}

      <div
        ref={rootRef}
        className={`fixed ${intent === "plus" ? "z-[2000]" : "z-[1800]"}`}
        style={{
          top: Math.round(coords.top),
          left: Math.round(coords.left),
          transform:
            coords.placement === "center"
              ? (intent === "plus"
                ? "translate(-50%, calc(-100% - 12px))" // выше кнопки «+»
                : "translate(-50%, -50%)")
              : (coords.placement === "left" ? "translate(-100%,0)" : "translate(0,0)"),
        }}
      >
        <div
          className={
            (coords.placement === "center"
              ? "w-[min(20rem,90vw)] max-h-[70vh]"
              : "w-64 max-w-[90vw] max-h-[60vh]") +           /* side-режим тоже ограничен по высоте */
            " rounded-2xl border border-zinc-200 dark:border-zinc-800 " +
            "bg-white/98 dark:bg-zinc-900/98 shadow-xl p-2 flex flex-col " +
            (allowBackdrop ? "backdrop-blur" : "")
          }
        >
          {/* липкая шапка */}
          <div className="sticky top-0 -m-2 mb-2 px-3 py-2 rounded-t-2xl bg-white/85 dark:bg-zinc-900/85 backdrop-blur-sm border-b border-zinc-200/70 dark:border-zinc-800/70">
            <div className="text-[11px] tracking-wide text-zinc-500">Добавить:</div>
            <div className="text-base font-semibold text-zinc-900 dark:text-white truncate">
              {trackTitle || "Трек"}
            </div>
            {Array.isArray(trackArtists) && trackArtists.length > 0 ? (
              <div className="text-xs text-zinc-500 truncate">{trackArtists.join(", ")}</div>
            ) : null}
          </div>


          <button
            disabled={disabled}
            onClick={onPickLocal}
            className={
              "w-full text-left px-2 py-2 rounded-lg text-sm mb-1 transition " +
              "border border-zinc-200 dark:border-zinc-800 " +
              (disabled ? "opacity-50 cursor-not-allowed bg-zinc-100 dark:bg-zinc-800/60"
                : "hover:bg-zinc-50 dark:hover:bg-zinc-800/40")
            }
          >
            <div className="flex items-center">
              <div className="min-w-0">
                <div className="font-medium text-blue-600 dark:text-blue-400">Локальный плейлист</div>
                <div className="text-xs text-zinc-500">Сохраняется на этом устройстве</div>
              </div>
            </div>
          </button>

          {list.length > 0 && (
            <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-zinc-400">Публичные</div>
          )}

          {/* скролл только внутри списка; показываем ~3 элемента */}
          <div
            className="flex-1 overflow-y-auto overscroll-contain pr-1 pb-1 popover-scroll"
            style={{ maxHeight: rowH * 3 + 8 }}
            role="menu"
            aria-label="Публичные плейлисты"
          >
            {list.map((p) => (
              <button
                key={p.id}
                data-pl-item=""
                disabled={disabled || !!containsServer?.[p.id]}
                onClick={() => trackId && onPickServer(p, trackId)}
                className={
                  "w-full text-left px-2 py-2 rounded-lg text-sm mb-1 transition outline-none " +
                  "border border-zinc-200 dark:border-zinc-800 " +
                  ((disabled || !!containsServer?.[p.id])
                    ? "opacity-50 cursor-not-allowed bg-zinc-100 dark:bg-zinc-800/60"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800/40 focus-visible:ring-2 ring-blue-500/60")
                }
                role="menuitem"
              >
                <div className="flex items-center justify-between gap-2" data-pl-item="">
                  {/* слева — название и подпись */}
                  <div className="min-w-0">
                    <div className="font-medium truncate text-zinc-900 dark:text-white">{p.title}</div>
                    <div className="text-xs text-zinc-500">
                      {containsServer?.[p.id] ? "Добавлено" : "Добавить в публичный"}
                    </div>
                  </div>
                  {/* справа — бейдж хэндла */}
                  <span className="shrink-0 inline-flex items-center h-5 px-2 rounded-md
                                 border border-blue-500/40 text-[11px] leading-none text-blue-600
                                 bg-blue-50/40 dark:bg-blue-400/10">
                    {"@" + ((p.handle || "").replace(/^@/, "") || "public")}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* стрелочка рисуется только в side-режиме */}
        {coords.placement !== "center" && (
          <div
            className="absolute w-3 h-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rotate-45"
            style={{
              top: "50%",
              transform: "translateY(-50%) rotate(45deg)",
              ...(coords.placement === "left" ? { right: -6 } : { left: -6 }),
            }}
          />
        )}
      </div >
    </>,
    portalHost
  );
}