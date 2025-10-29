/**
 * Типы, которые разделяют контроллеры свайпа/скраба.
 */
export type ImpactKind = "light" | "medium" | "heavy" | "soft" | "rigid";

export type ScrubCallbacks = {
  onScrubStart: (payload: { pct: number; x: number; width: number }) => void;
  onScrubProgress: (pct: number) => void;
  onScrubEnd: () => void;
  onHapticImpact: (kind: ImpactKind) => void;
  shouldSuppressHold?: () => boolean;
};
