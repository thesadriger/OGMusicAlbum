import { useEffect, useMemo, useRef, useState } from "react";
import { useInView } from "motion/react";

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

  const observerOptions = useMemo(() => ({ amount, margin, once }), [amount, margin, once]);
  const inView = useInView(ref, observerOptions);
  const [hasEntered, setHasEntered] = useState(false);

  useEffect(() => {
    if (inView) {
      setHasEntered(true);
    }
  }, [inView]);

  const className = [
    CLASSNAMES.base,
    hasEntered ? CLASSNAMES.entered : "",
    inView ? CLASSNAMES.visible : CLASSNAMES.hidden,
  ]
    .filter(Boolean)
    .join(" ");

  const shouldRender = freezeOnceVisible ? hasEntered : inView || hasEntered;

  return {
    ref,
    isVisible: inView,
    hasEntered,
    className,
    shouldRender,
  };
}
