import { useEffect, useMemo, useRef, useState } from "react";

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
};

type PresenceClassNames = {
  base: string;
  entered: string;
  visible: string;
  hidden: string;
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
  const { amount = 0.3, margin = "-10% 0px", once = false, freezeOnceVisible = false } = options;
  const ref = useRef<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [hasEntered, setHasEntered] = useState(false);

  const targetRatio = normalizeAmount(amount);
  const thresholds = useMemo(() => {
    const base = [0, targetRatio].filter((value, index, array) => array.indexOf(value) === index);
    return base.sort((a, b) => a - b);
  }, [targetRatio]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let disposed = false;

    const markVisible = (visible: boolean) => {
      if (disposed) return;
      setIsVisible(visible);
      if (visible) {
        setHasEntered(true);
      }
    };

    // Fallback — если IntersectionObserver недоступен или элемент уже в области видимости
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      markVisible(true);
      return;
    }

    if (isElementInViewport(element, targetRatio)) {
      markVisible(true);
      if (once) {
        return;
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const visible = entry.isIntersecting && entry.intersectionRatio >= targetRatio;
          markVisible(visible);
          if (visible && once) {
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
  }, [margin, once, targetRatio, thresholds]);

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
  };
}

function normalizeAmount(amount: ViewportPresenceOptions["amount"]): number {
  if (amount === "all") return 1;
  if (amount === "some" || amount === undefined || amount === null) return 0;
  const clamped = Math.max(0, Math.min(1, Number(amount)));
  return Number.isFinite(clamped) ? clamped : 0;
}

function isElementInViewport(element: Element, ratio: number) {
  if (typeof window === "undefined") return true;

  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;

  if (viewportHeight === 0 || viewportWidth === 0) return true;

  const visibleHeight = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
  const visibleWidth = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);

  if (visibleHeight <= 0 || visibleWidth <= 0) return false;

  const heightRatio = visibleHeight / (rect.height || 1);
  const widthRatio = visibleWidth / (rect.width || 1);

  const intersectionRatio = Math.max(0, Math.min(heightRatio, widthRatio));

  return intersectionRatio >= ratio;
}
