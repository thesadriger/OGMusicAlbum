import { useEffect, useRef } from "react";

/**
 * Хук для анимации градиента без React-состояния.
 * Меняем CSS-переменную на DOM-элементе; ререндеров нет.
 */
export function useAnimatedGradient(enabled = true, fps = 30) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    let rafId: number | null = null;
    let last = 0;
    const step = (t: number) => {
      // троттлим до fps
      if (t - last >= 1000 / fps) {
        const angle = (t / 50) % 360; // скорость вращения
        el.style.setProperty("--grad-angle", `${angle}deg`);
        last = t;
      }
      rafId = window.requestAnimationFrame(step);
    };

    rafId = window.requestAnimationFrame(step);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [enabled, fps]);

  return ref;
}

/* Пример CSS:
.myGradientBox {
  /* начальное значение переменной */
  --grad-angle: 0deg;
  background: conic-gradient(from var(--grad-angle),
    #ff6b6b, #feca57, #48dbfb, #5f27cd, #ff6b6b);
  will-change: background; /* даём браузеру подсказку */
}
*/
