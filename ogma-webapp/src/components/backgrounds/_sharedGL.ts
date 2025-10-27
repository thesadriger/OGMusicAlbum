import { Renderer } from "ogl";

type TickerCb = (dt: number, now: number) => void;

let subs = new Set<TickerCb>();
let rafId = 0;
let last = performance.now();
let running = false;

// целевая кадровая и адаптивный лимитер
let targetFPS = 60;
let minFrameTime = 1000 / targetFPS;
let acc = 0;
let lastRafTs = performance.now();

/** === ДОБАВЛЕНО: адаптация под вкладку/фон ===
 * При скрытии вкладки чуть снижаем требования (rAF и так дросселится),
 * но мы дополнительно повышаем minFrameTime, чтобы меньше тратить CPU.
 * Защищаемся от SSR/Node — проверяем существование document.
 */
let visibilityListenerAttached = false;
let cleanupVisibilityListener = () => {};
if (typeof document !== "undefined" && !visibilityListenerAttached) {
  const onVis = () => {
    if (document.hidden) {
      // 30 fps минимум при скрытой вкладке
      minFrameTime = Math.max(minFrameTime, 1000 / 30);
    } else {
      // вернуться к целевым 60 fps (или текущему targetFPS)
      minFrameTime = 1000 / targetFPS;
    }
  };
  document.addEventListener("visibilitychange", onVis, { passive: true });
  visibilityListenerAttached = true;
  cleanupVisibilityListener = () => {
    document.removeEventListener("visibilitychange", onVis);
    visibilityListenerAttached = false;
  };
  // инициализируем состояние сразу
  onVis();
}

function loop(rafTs: number) {
  rafId = requestAnimationFrame(loop);

  // фактическое время от предыдущего кадра rAF
  const dtMs = rafTs - lastRafTs;
  lastRafTs = rafTs;

  // накапливаем и даём "целевой" кадр
  acc += dtMs;
  if (acc + 0.01 < minFrameTime) return;

  const usedMsStart = performance.now();     // начало полезной работы
  const tickDtMs = acc;                      // всё накопленное время
  acc = 0;

  // «пружина»: плавная адаптация под загрузку main-thread
  const workCost = performance.now() - usedMsStart; // стоимость прошлого кадра (в след. тике)
  if (workCost > 8) {
    minFrameTime = Math.min(1000 / 25, minFrameTime + 1.25);  // мягче: до 25 fps
  } else {
    minFrameTime = Math.max(1000 / 60, minFrameTime - 0.5);    // стремимся к 60 fps
  }

  const dt  = tickDtMs * 0.001;     // секунды
  const now = rafTs    * 0.001;     // секунды, как «монотонное» время

  subs.forEach(cb => { try { cb(dt, now); } catch {} });
}

export function subscribeTicker(cb: TickerCb) {
  subs.add(cb);
  if (!running) {
    running = true;
    last = performance.now();
    rafId = requestAnimationFrame(loop);
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && running) {
      running = false;
      cancelAnimationFrame(rafId);
      // аккуратно снимаем обработчик при полном стопе тикера
      if (visibilityListenerAttached) cleanupVisibilityListener();
    }
  };
}

/** Создание лёгкого Renderer с оптимизацией под 60 fps */
export function createRenderer(
  container: HTMLElement,
  opts?: { transparent?: boolean; dprCap?: number }
) {
  const renderer = new Renderer({
    dpr: Math.min(window.devicePixelRatio || 1, opts?.dprCap ?? 2),
    alpha: !!opts?.transparent,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });

  const gl = renderer.gl;
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0, 0, 0, opts?.transparent ? 0 : 1);

  const canvas = gl.canvas as HTMLCanvasElement;
  Object.assign(canvas.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    transform: "translateZ(0)",
    contain: "layout paint size style",
  } as CSSStyleDeclaration);

  (container.style as any).isolation = "isolate";
  container.appendChild(canvas);

  const applySize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
  };

  const ro = new ResizeObserver(() => requestAnimationFrame(applySize));
  ro.observe(container);
  applySize();

  return {
    renderer,
    gl,
    cleanup: () => {
      ro.disconnect();
      try { container.removeChild(canvas); } catch {}
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}