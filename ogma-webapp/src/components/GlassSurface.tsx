//home/ogma/ogma/ogma-webapp/src/components/GlassSurface.tsx
import React, { useEffect, useState } from "react";

export interface GlassSurfaceProps {
  children?: React.ReactNode;
  width?: number | string;
  height?: number | string;            // можно не задавать — тогда высоту возьмёт родитель
  borderRadius?: number;
  backgroundOpacity?: number;          // 0..1 — «молочность» стекла
  saturation?: number;                 // множитель насыщенности
  blur?: number;                       // px размытия
  className?: string;
  style?: React.CSSProperties;
  noBorder?: boolean;                  // выключить тонкую рамку
  noShadow?: boolean;                  // выключить тени
  tone?: "auto" | "light" | "dark";    // форсировать светлую/тёмную подложку
}

/** Надёжное определение dark-режима:
 *  1) сначала смотрим на класс .dark на html (Tailwind class strategy),
 *  2) реагируем на кастомное событие `ogma:theme-changed`,
 *  3) фолбэк — prefers-color-scheme.
 */
const useDarkMode = () => {
  const compute = () => {
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      if (root.classList.contains("dark") || root.getAttribute("data-theme") === "dark") {
        return true;
      }
    }
    if (typeof window !== "undefined" && "matchMedia" in window) {
      try {
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
      } catch { /* noop */ }
    }
    return false;
  };

  const [isDark, setIsDark] = useState<boolean>(compute);

  useEffect(() => {
    const onThemeChanged = () => setIsDark(compute());

    // наш глобальный эвент (его ты уже диспатчишь в проекте)
    window.addEventListener("ogma:theme-changed", onThemeChanged as any);

    // системная смена темы — как фолбэк (вне Telegram)
    let mq: MediaQueryList | null = null;
    const onMq = (e: MediaQueryListEvent) => setIsDark(e.matches);
    try {
      mq = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
      if (mq) {
        // поддержка обеих сигнатур (старые вебвью)
        // @ts-ignore
        mq.addEventListener?.("change", onMq) || mq.addListener?.(onMq);
      }
    } catch { /* noop */ }

    return () => {
      window.removeEventListener("ogma:theme-changed", onThemeChanged as any);
      if (mq) {
        // @ts-ignore
        mq.removeEventListener?.("change", onMq) || mq.removeListener?.(onMq);
      }
    };
  }, []);

  return isDark;
};

const GlassSurface: React.FC<GlassSurfaceProps> = ({
  children,
  width = "100%",
  height,                          // ВАЖНО: нет значения по умолчанию, чтобы <div class="h-full"> работал
  borderRadius = 20,
  backgroundOpacity = 0.2,
  saturation = 1.8,
  blur = 12,
  className = "",
  style = {},
  noBorder = false,
  noShadow = false,
  tone = "auto",
}) => {
  const isDarkEnv = useDarkMode();
  const dark = tone === "dark" ? true : tone === "light" ? false : isDarkEnv;

  const supportsBackdrop =
    typeof CSS !== "undefined" &&
    (CSS.supports("backdrop-filter", "blur(10px)") ||
      CSS.supports("-webkit-backdrop-filter", "blur(10px)"));

  const op = Math.max(0, Math.min(1, backgroundOpacity));
  // ТОЛЬКО backgroundColor (без shorthand "background") — убирает warning React
  const bgColor = dark
    ? `rgba(16,16,18,${op})`
    : `rgba(255,255,255,${Math.min(0.95, Math.max(0.05, op))})`;

  const resolvedWidth  = typeof width  === "number" ? `${width}px`  : width;
  const resolvedHeight = typeof height === "number" ? `${height}px` : height;

  const containerStyle: React.CSSProperties = {
    ...style,
    width: resolvedWidth,
    // высоту задаём ТОЛЬКО если её явно передали и это не "auto"
    ...(resolvedHeight && resolvedHeight !== "auto" ? { height: resolvedHeight } : {}),
    borderRadius,
    backgroundColor: bgColor,
    backgroundClip: "padding-box",
    backdropFilter: supportsBackdrop ? `blur(${blur}px) saturate(${saturation})` : undefined,
    WebkitBackdropFilter: supportsBackdrop ? `blur(${blur}px) saturate(${saturation})` : undefined,
    border: noBorder
      ? "none"
      : (dark ? "1px solid rgba(255,255,255,.16)" : "1px solid rgba(255,255,255,.36)"),
    boxShadow: noShadow
      ? "none"
      : (dark
          ? "0 8px 20px rgba(0,0,0,.25), inset 0 1px 0 rgba(255,255,255,.12)"
          : "0 8px 20px rgba(0,0,0,.12), inset 0 1px 0 rgba(255,255,255,.6)"),
    isolation: "isolate",
    transform: "translateZ(0)", // фикс артефактов в некоторых webview
  };

  return (
    <div className={`relative overflow-hidden ${className}`} style={containerStyle}>
      <div className="w-full h-full rounded-[inherit]">{children}</div>
    </div>
  );
};

export default GlassSurface;