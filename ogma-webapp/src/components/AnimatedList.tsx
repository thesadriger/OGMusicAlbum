import React, {
  ReactNode,
  MouseEventHandler,
  useEffect,
  useRef,
  useState,
} from "react";
import { motion, useInView } from "motion/react";

export type AnimatedListItem = {
  key: string | number;
  content: ReactNode;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onClick?: MouseEventHandler<HTMLDivElement>;
  className?: string;
};

interface AnimatedItemProps {
  children: ReactNode;
  delay: number;
  index: number;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onClick?: MouseEventHandler<HTMLDivElement>;
  className?: string;
}

const AnimatedItem: React.FC<AnimatedItemProps> = ({
  children,
  delay,
  index,
  onMouseEnter,
  onClick,
  className = "",
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.5, once: false });

  return (
    <motion.div
      ref={ref}
      data-index={index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      initial={{ scale: 0.7, opacity: 0 }}
      animate={inView ? { scale: 1, opacity: 1 } : { scale: 0.7, opacity: 0 }}
      transition={{ duration: 0.2, delay }}
      className={`w-full ${className}`}
    >
      {children}
    </motion.div>
  );
};

interface AnimatedListProps {
  items: AnimatedListItem[];
  className?: string;
  listClassName?: string;
  itemClassName?: string;
  selectedItemClassName?: string;
  baseDelay?: number;
  scrollable?: boolean;
  showGradients?: boolean;
  enableArrowNavigation?: boolean;
  displayScrollbar?: boolean;
  initialSelectedIndex?: number;
  onItemSelect?: (item: AnimatedListItem, index: number) => void;
}

const DEFAULT_DELAY = 0.05;
const MAX_ANIMATION_DELAY = 0.6;

const AnimatedList: React.FC<AnimatedListProps> = ({
  items,
  className = "",
  listClassName = "space-y-3",
  itemClassName = "",
  selectedItemClassName = "",
  baseDelay = DEFAULT_DELAY,
  scrollable = false,
  showGradients = scrollable,
  enableArrowNavigation = false,
  displayScrollbar = true,
  initialSelectedIndex = -1,
  onItemSelect,
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(initialSelectedIndex);
  const [keyboardNav, setKeyboardNav] = useState<boolean>(false);
  const [topGradientOpacity, setTopGradientOpacity] = useState<number>(0);
  const [bottomGradientOpacity, setBottomGradientOpacity] = useState<number>(0);

  useEffect(() => {
    if (!scrollable) return;
    const container = listRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    setTopGradientOpacity(Math.min(scrollTop / 50, 1));
    const bottomDistance = scrollHeight - (scrollTop + clientHeight);
    setBottomGradientOpacity(scrollHeight <= clientHeight ? 0 : Math.min(bottomDistance / 50, 1));
  }, [scrollable, items.length]);

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    if (!scrollable) return;
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    setTopGradientOpacity(Math.min(scrollTop / 50, 1));
    const bottomDistance = scrollHeight - (scrollTop + clientHeight);
    setBottomGradientOpacity(scrollHeight <= clientHeight ? 0 : Math.min(bottomDistance / 50, 1));
  };

  useEffect(() => {
    if (!enableArrowNavigation) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (items.length === 0) return;

      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        setKeyboardNav(true);
        setSelectedIndex((prev) => Math.min((prev < 0 ? -1 : prev) + 1, items.length - 1));
      } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        setKeyboardNav(true);
        setSelectedIndex((prev) => {
          if (prev < 0) return items.length - 1;
          return Math.max(prev - 1, 0);
        });
      } else if (e.key === "Enter") {
        if (selectedIndex >= 0 && selectedIndex < items.length) {
          e.preventDefault();
          const item = items[selectedIndex];
          if (!item) return;
          onItemSelect?.(item, selectedIndex);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [items, selectedIndex, enableArrowNavigation, onItemSelect]);

  useEffect(() => {
    if (!scrollable) return;
    if (!keyboardNav || selectedIndex < 0 || !listRef.current) return;

    const container = listRef.current;
    const selectedItem = container.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement | null;
    if (selectedItem) {
      const extraMargin = 50;
      const containerScrollTop = container.scrollTop;
      const containerHeight = container.clientHeight;
      const itemTop = selectedItem.offsetTop;
      const itemBottom = itemTop + selectedItem.offsetHeight;
      if (itemTop < containerScrollTop + extraMargin) {
        container.scrollTo({ top: itemTop - extraMargin, behavior: "smooth" });
      } else if (itemBottom > containerScrollTop + containerHeight - extraMargin) {
        container.scrollTo({
          top: itemBottom - containerHeight + extraMargin,
          behavior: "smooth",
        });
      }
    }
    setKeyboardNav(false);
  }, [selectedIndex, keyboardNav, scrollable]);

  return (
    <div className={`relative w-full ${className}`}>
      <div
        ref={listRef}
        className={`${scrollable ? "max-h-[400px] overflow-y-auto" : ""} ${listClassName}`.trim()}
        onScroll={handleScroll}
        style={
          scrollable
            ? {
                scrollbarWidth: displayScrollbar ? "thin" : "none",
                scrollbarColor: "#222 #060010",
              }
            : undefined
        }
      >
        {items.map((item, index) => {
          const delay = Math.min(baseDelay * index, MAX_ANIMATION_DELAY);
          return (
            <AnimatedItem
              key={item.key}
              delay={delay}
              index={index}
              onMouseEnter={(event) => {
                setSelectedIndex(index);
                item.onMouseEnter?.(event);
              }}
              onClick={(event) => {
                setSelectedIndex(index);
                onItemSelect?.(item, index);
                item.onClick?.(event);
              }}
              className={`${itemClassName} ${index === selectedIndex ? selectedItemClassName : ""} ${item.className ?? ""}`.trim()}
              >
                {item.content}
              </AnimatedItem>
            );
          })}
      </div>
      {scrollable && showGradients && (
        <>
          <div
            className="pointer-events-none absolute top-0 left-0 right-0 h-[50px] bg-gradient-to-b from-[#060010] to-transparent transition-opacity duration-300 ease"
            style={{ opacity: topGradientOpacity }}
          />
          <div
            className="pointer-events-none absolute bottom-0 left-0 right-0 h-[100px] bg-gradient-to-t from-[#060010] to-transparent transition-opacity duration-300 ease"
            style={{ opacity: bottomGradientOpacity }}
          />
        </>
      )}
    </div>
  );
};

export default AnimatedList;
