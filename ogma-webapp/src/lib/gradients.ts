// src/lib/gradients.ts
import { useEffect, useMemo, useState } from "react";

export type Palette4 = [string, string, string, string];

type RGBA = { r: number; g: number; b: number; a: number };

const toRGBA = (hex: string): RGBA => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const lerpColor = (c1: string, c2: string, t: number) => {
  const A = toRGBA(c1), B = toRGBA(c2);
  return `rgb(${Math.round(lerp(A.r, B.r, t))}, ${Math.round(lerp(A.g, B.g, t))}, ${Math.round(lerp(A.b, B.b, t))})`;
};

/** Фракционная «ротация» палитры из 4 цветов, shift ∈ [0..4) */
export const rotatedPalette = (colors: string[], shift: number): Palette4 => {
  const n = colors.length, out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = (i + shift) % n;
    const i0 = Math.floor(idx), i1 = (i0 + 1) % n, t = idx - i0;
    out.push(lerpColor(colors[i0], colors[i1], t));
  }
  return out as Palette4;
};

/** Плавно вращает палитру с помощью requestAnimationFrame */
export function useSmoothPalette(colors: Palette4, active: boolean, speed = 0.35) {
  const [phase, setPhase] = useState(0); // 0..4
  useEffect(() => {
    if (!active) return;                    // при неактивном — вообще не запускаем rAF
    let raf = 0, last = performance.now();

    const loop = () => {
      const now = performance.now();
      const dt = (now - last) / 1000; last = now;

      // обновляем фазу только когда активно
      setPhase((p) => (p + dt * speed) % 4);

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [active, speed]);

  return useMemo(() => rotatedPalette(colors, phase), [colors, phase]);
}