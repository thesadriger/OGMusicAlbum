import React from "react";
import { useSmoothPalette, type Palette4 } from "@/lib/gradients";

type Props = {
  progress: number;              // 0..1
  colors?: Palette4;
  active?: boolean;
  radius?: number;
};

const DEF_COLORS: Palette4 = ["#67d4d9", "#5b95f7", "#66daea", "#5db5f7"];

export default function GradientBackdropFill({ progress, colors = DEF_COLORS, active = true, radius = 16 }: Props) {
  const pct = Math.max(0, Math.min(1, progress));
  const rotated = useSmoothPalette(colors, active, 0.35);

  return (
  <div
    className="absolute inset-0 pointer-events-none"
    style={{ isolation: "isolate", borderRadius: radius, overflow: "hidden", contain: "paint" }}
  >
    <div
      className="absolute inset-y-0 left-0 origin-left will-change-transform"
      style={{
        right: 0,
        background: `linear-gradient(90deg, ${rotated[0]}, ${rotated[1]}, ${rotated[2]}, ${rotated[3]})`,
        transform: `scaleX(${pct}) translateZ(0)`,
        transition: active ? "transform 140ms linear" : "none",
        // убираем возможные артефакты на нуле
        display: pct <= 0 ? "none" : "block",
      }}
    />
  </div>
);
}