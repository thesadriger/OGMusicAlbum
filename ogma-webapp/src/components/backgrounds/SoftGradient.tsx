import type { FC, HTMLAttributes } from "react";

const SoftGradient: FC<HTMLAttributes<HTMLDivElement>> = ({ className = "", style, ...props }) => {
  const combinedClassName = [
    "absolute inset-0",
    "overflow-hidden",
    "pointer-events-none",
    "bg-[radial-gradient(circle_at_top,#1e3a8a_0%,#111827_45%,#020617_100%)]",
    "before:content-[''] before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_top,#38bdf8_0%,transparent_60%)] before:opacity-40",
    "after:content-[''] after:absolute after:inset-0 after:bg-[radial-gradient(circle_at_bottom,#22d3ee_0%,transparent_55%)] after:opacity-30",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={combinedClassName}
      style={{
        ...style,
        animation: "soft-gradient-fade 16s ease-in-out infinite alternate",
        willChange: "transform, filter",
      }}
      {...props}
    />
  );
};

export default SoftGradient;
