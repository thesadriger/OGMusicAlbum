import React from "react";

export type BackgroundProps = { className?: string };

export const BaseBackground: React.FC<BackgroundProps> = ({ className }) => (
  <div className={`absolute inset-0 pointer-events-none ${className ?? ""}`} />
);

export function makeBg(displayName: string) {
  const C: React.FC<BackgroundProps> = ({ className }) => (
    <BaseBackground className={className} />
  );
  C.displayName = displayName;
  return C;
}
