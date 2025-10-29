import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MutableRefObject, RefObject } from "react";

type ViewportPresenceOptions = {
  /**
   * Intersection threshold (see motion's useInView amount prop)
   */
  amount?: number | "some" | "all";
  /**
   * Root margin passed to the observer
   */
  margin?: string;
  /**
   * Whether to trigger only once
   */
  once?: boolean;
  /**
   * Keep `shouldRender` true once the element entered viewport at least once
   */
  freezeOnceVisible?: boolean;
  /**
   * Callback fired when visibility state changes.
   */
  onVisibilityChange?: (state: { isVisible: boolean; hasEntered: boolean }) => void;
};

type PresenceClassNames = {
  base: string;
  entered: string;
  visible: string;
  hidden: string;
};

type RectLike = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

type ViewportMetrics = {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
};

const CLASSNAMES: PresenceClassNames = {
  base: "viewport-reveal",
  entered: "viewport-reveal--entered",
  visible: "viewport-reveal--visible",
  hidden: "viewport-reveal--hidden",
};

export function useViewportPresence<T extends HTMLElement = HTMLElement>(
  options: ViewportPresenceOptions = {}
) {
  const {
    amount = 0.3,
    margin = "-10% 0px",
    once = false,
    freezeOnceVisible = false,
    onVisibilityChange,
  } = options;

  const assignedNodeRef = useRef<T | null>(null);
  const externalRef = useRef<MutableRefObject<T | null> | null>(null);
  const [observedNode, setObservedNode] = useState<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [hasEntered, setHasEntered] = useState(false);
  const hasEnteredRef = useRef(false);
  const lastNotifiedRef = useRef<{ isVisible: boolean; hasEntered: boolean } | null>(null);
  const lastCallbackRef = useRef<typeof onVisibilityChange>(undefined);

  useEffect(() => {
    if (!onVisibilityChange) {
      lastNotifiedRef.current = null;
      lastCallbackRef.current = undefined;
      return;
    }

    const last = lastNotifiedRef.current;
    const callbackChanged = lastCallbackRef.current !== onVisibilityChange;
    if (!callbackChanged && last && last.isVisible === isVisible && last.hasEntered === hasEntered) {
      return;
    }

    const snapshot = { isVisible, hasEntered } as const;
    lastNotifiedRef.current = snapshot;
    lastCallbackRef.current = onVisibilityChange;
    onVisibilityChange(snapshot);
  }, [hasEntered, isVisible, onVisibilityChange]);

  const setNode = useCallback((node: T | null) => {
    if (assignedNodeRef.current === node) return;
    assignedNodeRef.current = node;
    setObservedNode(node);
  }, []);

  if (!externalRef.current) {
    externalRef.current = createMutableRef(assignedNodeRef, setNode);
  }
  const ref = externalRef.current!;

  const targetRatio = normalizeAmount(amount);
  const thresholds = useMemo(() => createThresholdList(targetRatio), [targetRatio]);

  useEffect(() => {
    const element = observedNode;
    const persistOnEnter = once || freezeOnceVisible;

    if (!element) {
      setIsVisible(false);
      if (!persistOnEnter) {
        hasEnteredRef.current = false;
        setHasEntered(false);
      }
      return;
    }

    if (persistOnEnter && hasEnteredRef.current) {
      setHasEntered(true);
      setIsVisible(true);
      return;
    }

    let disposed = false;

    const markVisible = (visible: boolean) => {
      if (disposed) return;

      const shouldStayVisible = persistOnEnter && hasEnteredRef.current;
      const nextVisible = visible || shouldStayVisible;

      setIsVisible((prev) => (prev === nextVisible ? prev : nextVisible));

      if (visible && !hasEnteredRef.current) {
        hasEnteredRef.current = true;
        setHasEntered(true);
      }
    };

    if (!supportsIntersectionObserver()) {
      markVisible(true);
      return;
    }

    if (isElementInViewport(element, targetRatio, margin)) {
      markVisible(true);
      if (persistOnEnter) {
        return;
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target !== element) continue;

          const visible = isEntryVisible(entry, targetRatio, margin);
          markVisible(visible);

          if (visible && persistOnEnter) {
            observer.unobserve(entry.target);
          }
        }
      },
      {
        root: null,
        rootMargin: margin,
        threshold: thresholds,
      }
    );

    observer.observe(element);

    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [freezeOnceVisible, margin, observedNode, once, targetRatio, thresholds]);

  const className = useMemo(
    () =>
      [
        CLASSNAMES.base,
        hasEntered ? CLASSNAMES.entered : "",
        isVisible ? CLASSNAMES.visible : CLASSNAMES.hidden,
      ]
        .filter(Boolean)
        .join(" "),
    [hasEntered, isVisible]
  );

  const shouldRender = freezeOnceVisible ? hasEntered : isVisible || hasEntered;

  return {
    ref,
    isVisible,
    hasEntered,
    className,
    shouldRender,
  } as const;
}

function normalizeAmount(amount: ViewportPresenceOptions["amount"]): number {
  if (amount === "all") return 1;
  if (amount === "some" || amount === undefined || amount === null) return 0;
  const clamped = Math.max(0, Math.min(1, Number(amount)));
  return Number.isFinite(clamped) ? clamped : 0;
}

function supportsIntersectionObserver(): boolean {
  return typeof window !== "undefined" && "IntersectionObserver" in window;
}

function createMutableRef<T extends HTMLElement>(
  source: RefObject<T>,
  assign: (node: T | null) => void
): MutableRefObject<T | null> {
  const refObject = { current: source.current } as MutableRefObject<T | null>;

  Object.defineProperty(refObject, "current", {
    configurable: false,
    enumerable: true,
    get: () => source.current ?? null,
    set: (node: T | null) => assign(node),
  });

  return refObject;
}

function createThresholdList(ratio: number): number[] {
  const values = new Set([0, ratio, 1]);
  return Array.from(values).sort((a, b) => a - b);
}

function isElementInViewport(element: Element, ratio: number, margin: string): boolean {
  if (typeof window === "undefined") return true;

  const rect = element.getBoundingClientRect();
  const viewport = getViewportMetrics();

  if (viewport.height === 0 || viewport.width === 0) return true;

  const [marginTop, marginRight, marginBottom, marginLeft] = parseRootMargin(
    margin,
    viewport.width,
    viewport.height
  );

  const viewportRect = createViewportRect(
    viewport.width,
    viewport.height,
    marginTop,
    marginRight,
    marginBottom,
    marginLeft,
    viewport.offsetTop,
    viewport.offsetLeft
  );

  return isVisibleByRectangles(domRectToRectLike(rect), viewportRect, ratio);
}

function isEntryVisible(entry: IntersectionObserverEntry, ratio: number, margin: string): boolean {
  const viewport = getViewportMetrics();
  const [marginTop, marginRight, marginBottom, marginLeft] = parseRootMargin(
    margin,
    viewport.width,
    viewport.height
  );

  const viewportRect = createViewportRect(
    viewport.width,
    viewport.height,
    marginTop,
    marginRight,
    marginBottom,
    marginLeft,
    viewport.offsetTop,
    viewport.offsetLeft
  );

  return isVisibleByRectangles(domRectToRectLike(entry.boundingClientRect), viewportRect, ratio);
}

function getViewportMetrics(): ViewportMetrics {
  if (typeof window === "undefined") {
    return { width: 1, height: 1, offsetTop: 0, offsetLeft: 0 };
  }

  const visual = window.visualViewport;
  if (visual) {
    const width = visual.width || window.innerWidth || document.documentElement.clientWidth || 0;
    const height = visual.height || window.innerHeight || document.documentElement.clientHeight || 0;
    return {
      width,
      height,
      offsetTop: visual.offsetTop || 0,
      offsetLeft: visual.offsetLeft || 0,
    };
  }

  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  const height = window.innerHeight || document.documentElement.clientHeight || 0;

  return { width, height, offsetTop: 0, offsetLeft: 0 };
}

function parseRootMargin(
  margin: string,
  viewportWidth: number,
  viewportHeight: number
): [number, number, number, number] {
  const tokens = margin
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return [0, 0, 0, 0];
  }

  const normalizedTokens = normalizeMarginTokens(tokens);

  const values = normalizedTokens.map((token, index) => {
    const size = index % 2 === 0 ? viewportHeight : viewportWidth;
    return parseMarginValue(token, size);
  }) as [number, number, number, number];

  return values;
}

function createViewportRect(
  viewportWidth: number,
  viewportHeight: number,
  marginTop: number,
  marginRight: number,
  marginBottom: number,
  marginLeft: number,
  offsetTop = 0,
  offsetLeft = 0
): RectLike {
  if (typeof window !== "undefined") {
    const { scrollX, scrollY } = getScrollOffsets();
    const { width: docWidth, height: docHeight } = getDocumentDimensions();

    if (marginTop < 0) {
      const availableTop = Math.max(0, scrollY + offsetTop);
      marginTop = -Math.min(-marginTop, availableTop);
    }

    if (marginBottom < 0) {
      const viewportBottom = scrollY + offsetTop + viewportHeight;
      const availableBottom = Math.max(0, docHeight - viewportBottom);
      marginBottom = -Math.min(-marginBottom, availableBottom);
    }

    if (marginLeft < 0) {
      const availableLeft = Math.max(0, scrollX + offsetLeft);
      marginLeft = -Math.min(-marginLeft, availableLeft);
    }

    if (marginRight < 0) {
      const viewportRight = scrollX + offsetLeft + viewportWidth;
      const availableRight = Math.max(0, docWidth - viewportRight);
      marginRight = -Math.min(-marginRight, availableRight);
    }
  }

  const top = offsetTop - marginTop;
  const left = offsetLeft - marginLeft;
  const right = offsetLeft + viewportWidth + marginRight;
  const bottom = offsetTop + viewportHeight + marginBottom;

  return {
    top,
    left,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function domRectToRectLike(rect: DOMRectReadOnly): RectLike {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function getGlobalViewportRect(): RectLike {
  if (typeof window === "undefined") {
    return {
      top: 0,
      right: 1,
      bottom: 1,
      left: 0,
      width: 1,
      height: 1,
    };
  }

  const viewport = getViewportMetrics();

  return {
    top: viewport.offsetTop,
    left: viewport.offsetLeft,
    right: viewport.offsetLeft + viewport.width,
    bottom: viewport.offsetTop + viewport.height,
    width: Math.max(0, viewport.width),
    height: Math.max(0, viewport.height),
  };
}

function isVisibleByRectangles(
  elementRect: RectLike,
  viewportRect: RectLike,
  ratio: number,
  intersectionOverride?: RectLike
): boolean {
  const intersection = intersectionOverride ?? intersectRects(elementRect, viewportRect);

  if (!intersection) {
    return false;
  }

  const intersectionArea = Math.max(0, intersection.width) * Math.max(0, intersection.height);
  if (intersectionArea <= 0) return false;

  if (ratio === 0) {
    return intersectionArea > 0;
  }

  const elementArea = Math.max(elementRect.width * elementRect.height, 1);
  const viewportArea = Math.max(viewportRect.width * viewportRect.height, 1);
  const effectiveArea = Math.max(1, Math.min(elementArea, viewportArea));

  const intersectionRatio = Math.max(0, Math.min(1, intersectionArea / effectiveArea));

  return intersectionRatio >= ratio;
}

function intersectRects(a: RectLike, b: RectLike): RectLike | null {
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);

  if (bottom <= top || right <= left) {
    return null;
  }

  return {
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
  };
}

function normalizeMarginTokens(tokens: string[]): [string, string, string, string] {
  if (tokens.length === 1) {
    return [tokens[0], tokens[0], tokens[0], tokens[0]];
  }
  if (tokens.length === 2) {
    return [tokens[0], tokens[1], tokens[0], tokens[1]];
  }
  if (tokens.length === 3) {
    return [tokens[0], tokens[1], tokens[2], tokens[1]];
  }
  return [tokens[0], tokens[1], tokens[2], tokens[3]];
}

function parseMarginValue(value: string, size: number): number {
  const match = value.match(/(-?\d*\.?\d+)(px|%)?/i);
  if (!match) return 0;

  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return 0;

  const unit = match[2]?.toLowerCase();
  if (unit === "%") {
    return (numeric / 100) * size;
  }

  return numeric;
}

function getScrollOffsets(): { scrollX: number; scrollY: number } {
  if (typeof window === "undefined") {
    return { scrollX: 0, scrollY: 0 };
  }

  const doc = document.documentElement;
  const body = document.body;

  const scrollX =
    window.scrollX ??
    window.pageXOffset ??
    doc?.scrollLeft ??
    body?.scrollLeft ??
    0;
  const scrollY =
    window.scrollY ??
    window.pageYOffset ??
    doc?.scrollTop ??
    body?.scrollTop ??
    0;

  return { scrollX, scrollY };
}

function getDocumentDimensions(): { width: number; height: number } {
  if (typeof document === "undefined") {
    return { width: 0, height: 0 };
  }

  const doc = document.documentElement;
  const body = document.body;

  const width = Math.max(
    doc?.scrollWidth ?? 0,
    body?.scrollWidth ?? 0,
    doc?.clientWidth ?? 0,
    body?.clientWidth ?? 0
  );

  const height = Math.max(
    doc?.scrollHeight ?? 0,
    body?.scrollHeight ?? 0,
    doc?.clientHeight ?? 0,
    body?.clientHeight ?? 0
  );

  return { width, height };
}
