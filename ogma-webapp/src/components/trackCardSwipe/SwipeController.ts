import type { ImpactKind } from "./types";

// TRIGGER_COMMIT — «жёсткий» порог. Дотянули сюда → считаем, что пользователь точно хотел действие.
export const TRIGGER_COMMIT = 84;
// MAX_SWIPE ограничивает сдвиг, чтобы карта не улетала дальше кнопок.
export const MAX_SWIPE = 160;
// LEFT_REVEAL — позиция полуоткрытого состояния (скачать/удалить как в iOS Mail).
export const LEFT_REVEAL = 96;
// LEFT_MIN_OPEN — минимальный порог, после которого показываем левую кнопку.
export const LEFT_MIN_OPEN = 28;
// DEAD_ZONE_PX — горизонтальная зона без движения, защищает от случайных свайпов.
export const DEAD_ZONE_PX = 9;
// SCROLL_CANCEL_PX — вертикальный порог. Если уходим по Y дальше — трактуем как скролл и отменяем свайп.
export const SCROLL_CANCEL_PX = 8;
// FULL_PULL_PCT — какая доля ширины карточки считается «полным натяжением» для haptic tick.
export const FULL_PULL_PCT = 0.3;
// Интервалы для hapticTick: чем дальше тянем — тем реже тик, имитируем сопротивление.
export const BUZZ_MIN_MS = 18;
export const BUZZ_MAX_MS = 220;

export type SwipeMachineState = "idle" | "dragging" | "settling" | "frozen";

export type SwipeReleaseOutcome =
  | "tap"
  | "leftPeekTap"
  | "commitRight"
  | "commitLeft"
  | "openLeftPeek"
  | "close"
  | "cancelledByScroll";

export type SwipeReleaseDecision = {
  /** финальный логический исход жеста */
  outcome: SwipeReleaseOutcome;
  /** куда должна приехать карточка после жеста */
  targetDx: number;
  /** карточка остаётся ли в левом полу-открытом состоянии */
  leftOpen: boolean;
  /** какую анимацию просим применить (snap/remove/none) */
  anim: "snap" | "remove" | "none";
};

export type SwipeCallbacks = {
  /**
   * Сообщаем React-обёртке, что пользователь начал горизонтальный drag.
   * Нужен для выставления pivotY, отключения transition и т.п.
   */
  onDragStart: (info: { pivotY: number; fullPullPx: number }) => void;
  /**
   * Каждый кадр отдаём новый dx. Внешний компонент сам обновляет состояние/стили.
   */
  onDragMove: (dx: number) => void;
  /**
   * Когда drag завершён (tap/commit/отмена) — сигнализируем об окончании.
   */
  onDragEnd: () => void;
  /**
   * Отчёт о финальном решении жеста. TrackCard через settleState() выполняет анимацию.
   */
  onRelease: (decision: SwipeReleaseDecision) => void;
  /**
   * Имитация лёгкого "натяжения" во время движения.
   */
  onHapticTick: () => void;
  /**
   * Ударная отдача при входе в порог действия/открытия.
   */
  onHapticImpact: (kind: ImpactKind) => void;
};

export type SwipePointerDownPayload = {
  x: number;
  y: number;
  rect: DOMRect;
  leftOpen: boolean;
};

export type SwipePointerMovePayload = {
  x: number;
  y: number;
};

export type SwipePointerUpPayload = {
  /** Были ли мы в левом полу-открытом состоянии до жеста */
  leftOpen: boolean;
};

/**
 * Контроллер свайпа. Он концентрирует всю механику iOS Mail:
 * dead-zone, отмену по вертикальному скроллу, хаптики и финальные решения.
 * TrackCard лишь прокидывает pointer-события и выполняет возвращённые решения.
 */
export class SwipeController {
  private callbacks: SwipeCallbacks;
  private state: SwipeMachineState = "idle"; // Текущее состояние машины жеста.
  private startPoint: { x: number; y: number } | null = null; // Где пользователь приложил палец.
  private startLeftOpen = false; // Была ли карта в полуоткрытом состоянии в момент старта.
  private pending: SwipePointerMovePayload | null = null; // Последняя точка движения, ждёт обработки в rAF.
  private raf: number | null = null; // Текущий requestAnimationFrame, чтобы отменять при pointerUp.
  private dxCurrent = 0; // Текущий сдвиг карточки в пикселях.
  private deadZonePassed = false; // Превышена ли горизонтальная dead-zone.
  private cancelledByScroll = false; // Флаг отмены свайпа из-за вертикального скролла.
  private lastBuzzAt = 0; // Время последнего hapticTick.
  private crossed = { left: false, right: false, reveal: false }; // Какие пороги уже пройдены, чтобы не спамить haptics.
  private fullPullPx = 120; // Сколько пикселей считаем «полным» натяжением.
  private pivotY = 50; // Ось наклона карточки (процент по высоте).

  constructor(callbacks: SwipeCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Начинаем жест. До выхода из dead-zone карточка визуально стоит на месте.
   */
  pointerDown(payload: SwipePointerDownPayload) {
    if (this.state === "frozen") return;
    this.state = "dragging";
    this.startPoint = { x: payload.x, y: payload.y };
    this.startLeftOpen = payload.leftOpen;
    this.deadZonePassed = false;
    this.cancelledByScroll = false;
    this.dxCurrent = this.startLeftOpen ? -LEFT_REVEAL : 0;
    this.lastBuzzAt = now();
    this.crossed = { left: false, right: false, reveal: payload.leftOpen };
    this.fullPullPx = Math.max(40, payload.rect.width * FULL_PULL_PCT);
    this.pivotY = clamp(
      ((payload.y - payload.rect.top) / Math.max(1, payload.rect.height)) * 100,
      0,
      100
    );
    this.callbacks.onDragStart({ pivotY: this.pivotY, fullPullPx: this.fullPullPx });
    this.callbacks.onDragMove(this.dxCurrent);
  }

  /**
   * Накапливаем координаты и обновляем dx в rAF, чтобы не дёргать React по каждой точке.
   */
  pointerMove(payload: SwipePointerMovePayload) {
    if (this.state !== "dragging" || !this.startPoint) return;
    this.pending = payload;
    if (this.raf == null) {
      this.raf = requestAnimationFrame(() => this.pump());
    }
  }

  /**
   * Завершение жеста. Решение принимается один раз и отдаётся наружу.
   */
  pointerUp(payload: SwipePointerUpPayload) {
    if (this.state !== "dragging") return;
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.state = "idle";
    this.callbacks.onDragEnd();

    if (!this.deadZonePassed && !this.cancelledByScroll) {
      // Тап без сдвига
      const outcome = payload.leftOpen ? "leftPeekTap" : "tap";
      this.callbacks.onRelease(
        this.buildDecision(outcome, payload.leftOpen ? -LEFT_REVEAL : 0, payload.leftOpen)
      );
      return;
    }

    if (this.cancelledByScroll) {
      this.callbacks.onRelease(
        this.buildDecision(
          "cancelledByScroll",
          payload.leftOpen ? -LEFT_REVEAL : 0,
          payload.leftOpen
        )
      );
      return;
    }

    const dx = this.dxCurrent;
    if (dx >= TRIGGER_COMMIT) {
      this.callbacks.onRelease(this.buildDecision("commitRight", 0, false));
      return;
    }
    if (dx <= -TRIGGER_COMMIT) {
      this.callbacks.onRelease(this.buildDecision("commitLeft", 0, false));
      return;
    }
    if (dx < 0 && Math.abs(dx) >= LEFT_MIN_OPEN) {
      this.callbacks.onRelease(this.buildDecision("openLeftPeek", -LEFT_REVEAL, true));
      return;
    }
    this.callbacks.onRelease(this.buildDecision("close", 0, false));
  }

  /**
   * Принудительно отменяем жест (pointercancel/scroll). Карточка возвращается в исходное положение.
   */
  cancel(payload: SwipePointerUpPayload) {
    if (this.state === "idle") {
      this.callbacks.onRelease(
        this.buildDecision("close", payload.leftOpen ? -LEFT_REVEAL : 0, payload.leftOpen)
      );
      return;
    }
    this.cancelledByScroll = true;
    this.pointerUp(payload);
  }

  /**
   * Внешний freeze (поповер, скраб). В этом режиме pointerDown игнорируется.
   */
  freeze() {
    this.state = "frozen";
  }

  /**
   * Снимаем freeze и возвращаемся в стабильное состояние.
   */
  unfreeze() {
    if (this.state === "frozen") {
      this.state = "idle";
    }
  }

  dispose() {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  /** Обрабатываем накопленный pointerMove одним кадром. */
  private pump() {
    this.raf = null;
    if (!this.pending || !this.startPoint) return;
    const { x, y } = this.pending;
    const deltaX = x - this.startPoint.x;
    const deltaY = y - this.startPoint.y;

    if (!this.deadZonePassed) {
      if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > SCROLL_CANCEL_PX) {
        this.cancelledByScroll = true;
        this.pointerUp({ leftOpen: this.startLeftOpen });
        return;
      }
      if (Math.abs(deltaX) >= DEAD_ZONE_PX) {
        this.deadZonePassed = true;
      }
    } else if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > SCROLL_CANCEL_PX) {
      this.cancelledByScroll = true;
      this.pointerUp({ leftOpen: this.startLeftOpen });
      return;
    }

    const base = this.startLeftOpen ? -LEFT_REVEAL : 0;
    if (!this.deadZonePassed) {
      this.dxCurrent = base;
      this.callbacks.onDragMove(this.dxCurrent);
      return;
    }

    let nextDx = base + deltaX;
    if (nextDx > MAX_SWIPE) nextDx = MAX_SWIPE;
    if (nextDx < -MAX_SWIPE) nextDx = -MAX_SWIPE;

    this.dxCurrent = nextDx;
    this.callbacks.onDragMove(this.dxCurrent);
    this.handleHaptics(nextDx, base);
  }

  /** Управляем haptic tick/impact по мере прохождения порогов. */
  private handleHaptics(nextDx: number, base: number) {
    const pull = clamp(Math.abs(nextDx - base) / Math.max(1, this.fullPullPx), 0, 1);
    if (pull < 1) {
      const interval = lerp(BUZZ_MIN_MS, BUZZ_MAX_MS, pull);
      if (now() - this.lastBuzzAt >= interval) {
        this.callbacks.onHapticTick();
        this.lastBuzzAt = now();
      }
    }

    if (nextDx >= TRIGGER_COMMIT && !this.crossed.right) {
      this.callbacks.onHapticImpact("medium");
      this.crossed.right = true;
    } else if (nextDx < TRIGGER_COMMIT && this.crossed.right) {
      this.crossed.right = false;
    }

    if (nextDx <= -TRIGGER_COMMIT && !this.crossed.left) {
      this.callbacks.onHapticImpact("medium");
      this.crossed.left = true;
    } else if (nextDx > -TRIGGER_COMMIT && this.crossed.left) {
      this.crossed.left = false;
    }

    if (nextDx <= -LEFT_MIN_OPEN && !this.crossed.reveal) {
      this.callbacks.onHapticImpact("light");
      this.crossed.reveal = true;
    } else if (nextDx > -LEFT_MIN_OPEN && this.crossed.reveal) {
      this.crossed.reveal = false;
    }
  }

  /** Финализируем исход жеста в удобном для React виде. */
  private buildDecision(
    outcome: SwipeReleaseOutcome,
    targetDx: number,
    leftOpen: boolean
  ): SwipeReleaseDecision {
    return {
      outcome,
      targetDx,
      leftOpen,
      anim: outcome === "cancelledByScroll" ? "snap" : "snap",
    };
  }
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function now() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
