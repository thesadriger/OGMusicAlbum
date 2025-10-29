import type { ScrubCallbacks } from "./types";

// SCRUB_HOLD_MS — сколько держим палец перед переходом в режим скраба.
export const SCRUB_HOLD_MS = 300;
// SCRUB_SENS — насколько быстро меняется прогресс при горизонтальном движении.
export const SCRUB_SENS = 1.5;
// SCRUB_CANCEL_PX — если палец уехал дальше этой дельты до hold, отменяем скраб.
const SCRUB_CANCEL_PX = 6;

export type ScrubPointerDownPayload = {
  x: number;
  y: number;
  rect: DOMRect;
  initialPct: number;
  isActive: boolean;
};

export type ScrubPointerMovePayload = {
  x: number;
  y: number;
};

/**
 * Контроллер долгого тап+скраб. Он не знает про React, только про проценты трека.
 */
export class ScrubController {
  private callbacks: ScrubCallbacks;
  private holdTimer: number | null = null; // Активный таймер long-press.
  private scrubbing = false; // Находимся ли в режиме скраба прямо сейчас.
  private start: { pct: number; x: number; width: number } | null = null; // Запоминаем стартовую точку и прогресс.
  private holdAnchor: { x: number; y: number } | null = null; // Координата, чтобы отменить скраб при раннем движении.

  constructor(callbacks: ScrubCallbacks) {
    this.callbacks = callbacks;
  }

  /** Запускаем ожидание долгого нажатия. */
  pointerDown(payload: ScrubPointerDownPayload) {
    this.cancelHold();
    this.holdAnchor = { x: payload.x, y: payload.y };
    if (!payload.isActive) {
      this.scrubbing = false;
      this.start = null;
      return;
    }
    this.holdTimer = window.setTimeout(() => {
      const width = Math.max(1, payload.rect.width);
      this.scrubbing = true;
      this.start = { pct: clamp(payload.initialPct, 0, 1), x: payload.x, width };
      this.callbacks.onScrubStart({ pct: this.start.pct, x: payload.x, width });
      this.callbacks.onHapticImpact("light");
    }, SCRUB_HOLD_MS);
  }

  /** Обрабатываем перемещение: либо отменяем hold, либо обновляем прогресс. */
  pointerMove(payload: ScrubPointerMovePayload) {
    if (!this.scrubbing && this.holdTimer != null && this.holdAnchor) {
      const dx = Math.abs(payload.x - this.holdAnchor.x);
      const dy = Math.abs(payload.y - this.holdAnchor.y);
      if (dx > SCRUB_CANCEL_PX || dy > SCRUB_CANCEL_PX) {
        this.cancelHold();
      }
    }
    if (!this.scrubbing || !this.start) return;
    const delta = (payload.x - this.start.x) / this.start.width;
    const next = clamp(this.start.pct + delta * SCRUB_SENS, 0, 1);
    this.callbacks.onScrubProgress(next);
  }

  /** Завершение жеста (палец отпущен). */
  pointerUp() {
    if (this.scrubbing) {
      this.scrubbing = false;
      this.callbacks.onScrubEnd();
    }
    this.cancelHold();
    this.start = null;
    this.holdAnchor = null;
  }

  /** Полная отмена (pointercancel / вертикальный скролл). */
  cancel() {
    if (this.scrubbing) {
      this.scrubbing = false;
      this.callbacks.onScrubEnd();
    }
    this.cancelHold();
    this.start = null;
    this.holdAnchor = null;
  }

  isScrubbing() {
    return this.scrubbing;
  }

  dispose() {
    this.cancelHold();
    this.holdAnchor = null;
  }

  private cancelHold() {
    if (this.holdTimer != null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}
