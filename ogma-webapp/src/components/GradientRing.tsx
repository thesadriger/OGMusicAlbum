import React from "react";
import { useSmoothPalette, type Palette4 } from "@/lib/gradients";

type Props = {
  active?: boolean;
  radius?: number;
  thickness?: number;
  colors?: Palette4;
  speed?: number;
  className?: string;
};

const DEF: Palette4 = ["#67d4d9", "#5b95f7", "#66daea", "#5db5f7"];

export default function GradientRing({
  active = true,
  radius = 16,
  thickness = 2,
  colors = DEF,
  speed = 0.5,
  className = "",
}: Props) {
  const pal = useSmoothPalette(colors, active, speed);
  const bg = `linear-gradient(90deg, ${pal[0]}, ${pal[1]}, ${pal[2]}, ${pal[3]})`;
  return (
    <div
      className={className}
      style={{
        position: "absolute",
        inset: 0,
        padding: thickness,
        borderRadius: radius,
        background: bg,
        pointerEvents: "none",
        // показываем только обводку, вычтя контент
        WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
        WebkitMaskComposite: "xor" as any,
        maskComposite: "exclude" as any,
      }}
    />
  );
}
