// src/components/RoundGlassButton.tsx
import React from "react";
import GlassSurface from "@/components/GlassSurface";

function usePrefersReducedMotion() {
  const [prefers, setPrefers] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => setPrefers(e.matches);
    setPrefers(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return prefers;
}

export interface RoundGlassButtonProps {
  id?: string;
  size?: number;
  disabled?: boolean;
  ariaLabel: string;
  title?: string;
  onClick?: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}

/** Кнопка с мягкой «стеклянной» интеракцией */
const RoundGlassButton: React.FC<RoundGlassButtonProps> = ({
  id,
  size = 48,
  disabled,
  ariaLabel,
  title,
  onClick,
  onPointerDown,
  children,
}) => {
  const reduced = usePrefersReducedMotion();
  const btnRef = React.useRef<HTMLButtonElement>(null);

  const pressIn = React.useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    if (reduced || !el.animate) {
      el.style.transition = "transform 120ms cubic-bezier(.2,.8,.2,1)";
      el.style.transform = "scale(0.96)";
      return;
    }
    el.animate(
      [{ transform: "scale(1)" }, { transform: "scale(0.96)" }],
      { duration: 130, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }
    );
  }, [reduced]);

  const release = React.useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    if (reduced || !el.animate) {
      el.style.transform = "scale(1)";
      return;
    }
    el.animate(
      [
        { transform: "scale(0.96)" },
        { transform: "scale(1.06)" },
        { transform: "scale(1)" },
      ],
      { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }
    );
  }, [reduced]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") pressIn();
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") release();
  };

  return (
    <GlassSurface
      width={size}
      height={size}
      borderRadius={9999}
      backgroundOpacity={0.22}
      saturation={1.8}
      className="shrink-0"
    >
      <button
        id={id}
        ref={btnRef}
        type="button"
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={onClick}
        onPointerDown={(e) => {
          pressIn();
          onPointerDown?.(e);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerLeave={release}
        onBlur={release}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        className="w-full h-full grid place-items-center rounded-full
                   text-white/90 hover:text-white
                   disabled:opacity-40 disabled:pointer-events-none
                   outline-none focus-visible:ring-2 focus-visible:ring-white/40
                   will-change-transform select-none bg-transparent"
        style={{
          transition: reduced
            ? undefined
            : "transform 180ms cubic-bezier(.2,.8,.2,1)",
        }}
      >
        {children}
      </button>
    </GlassSurface>
  );
};

export default RoundGlassButton;