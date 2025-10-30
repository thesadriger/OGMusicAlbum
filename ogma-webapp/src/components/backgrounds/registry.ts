import { useEffect, useState } from "react";
import type { ComponentType } from "react";

type BackgroundLoader = () => Promise<{ default: ComponentType<any> } | Record<string, unknown>>;

const BACKGROUND_KEY_LIST = [
  "SoftGradient",
  "LiquidChrome",
  "Squares",
  "LetterGlitch",
  "Orb",
  "Ballpit",
  "Waves",
  "Iridescence",
  "Hyperspeed",
  "Threads",
  "DotGrid",
  "RippleGrid",
  "FaultyTerminal",
  "Dither",
  "Galaxy",
  "PrismaticBurst",
  "Lightning",
  "Beams",
  "GradientBlinds",
  "Particles",
  "Plasma",
  "Aurora",
  "PixelBlast",
  "LightRays",
  "Silk",
  "DarkVeil",
  "Prism",
  "LiquidEther",
] as const;

export type BackgroundKey = (typeof BACKGROUND_KEY_LIST)[number];

const BACKGROUND_LOADERS: Record<BackgroundKey, BackgroundLoader> = {
  SoftGradient: () => import("./SoftGradient"),
  LiquidChrome: () => import("./LiquidChrome"),
  Squares: () => import("./Squares"),
  LetterGlitch: () => import("./LetterGlitch"),
  Orb: () => import("./Orb"),
  Ballpit: () => import("./Ballpit"),
  Waves: () => import("./Waves"),
  Iridescence: () => import("./Iridescence"),
  Hyperspeed: () => import("./Hyperspeed"),
  Threads: () => import("./Threads"),
  DotGrid: () => import("./DotGrid"),
  RippleGrid: () => import("./RippleGrid"),
  FaultyTerminal: () => import("./FaultyTerminal"),
  Dither: () => import("./Dither"),
  Galaxy: () => import("./Galaxy"),
  PrismaticBurst: () => import("./PrismaticBurst"),
  Lightning: () => import("./Lightning"),
  Beams: () => import("./Beams"),
  GradientBlinds: () => import("./GradientBlinds"),
  Particles: () => import("./Particles"),
  Plasma: () => import("./Plasma"),
  Aurora: () => import("./Aurora"),
  PixelBlast: () => import("./PixelBlast"),
  LightRays: () => import("./LightRays"),
  Silk: () => import("./Silk"),
  DarkVeil: () => import("./DarkVeil"),
  Prism: () => import("./Prism"),
  LiquidEther: () => import("./LiquidEther"),
};

const BACKGROUND_CACHE = new Map<BackgroundKey, ComponentType<any>>();

export const BACKGROUND_KEYS: BackgroundKey[] = [...BACKGROUND_KEY_LIST];
export const DEFAULT_BACKGROUND_KEY: BackgroundKey = BACKGROUND_KEY_LIST[0];
const HEAVY_LOAD_DEFER_MS = 1500;
export const HEAVY_BACKGROUND_KEYS = new Set<BackgroundKey>([
  "Hyperspeed",
  "Galaxy",
  "LiquidEther",
]);
export const LETTER_GLITCH_KEY: BackgroundKey = "LetterGlitch";

function resolveModule(module: any, key: BackgroundKey): ComponentType<any> | null {
  if (!module) return null;
  const candidate = module.default ?? module[key];
  return typeof candidate === "function" ? (candidate as ComponentType<any>) : null;
}

export function isBackgroundKey(value: string | null | undefined): value is BackgroundKey {
  return !!value && value in BACKGROUND_LOADERS;
}

type UseBackgroundOptions = {
  enabled?: boolean;
  deferHeavy?: boolean;
  fallbackForHeavy?: BackgroundKey | null;
  heavyDeferMs?: number;
};

export function useBackgroundComponent(
  key: BackgroundKey | null | undefined,
  options: UseBackgroundOptions = {}
): ComponentType<any> | null {
  const {
    enabled = true,
    deferHeavy = true,
    fallbackForHeavy = DEFAULT_BACKGROUND_KEY,
    heavyDeferMs = HEAVY_LOAD_DEFER_MS,
  } = options;

  const [resolvedKey, setResolvedKey] = useState<BackgroundKey | null>(() => {
    if (!key) return null;
    if (!deferHeavy || !HEAVY_BACKGROUND_KEYS.has(key) || !fallbackForHeavy) {
      return key;
    }
    return fallbackForHeavy;
  });

  const effectiveKey: BackgroundKey | null = enabled ? resolvedKey : null;

  const [component, setComponent] = useState<ComponentType<any> | null>(() => {
    if (!effectiveKey) return null;
    return BACKGROUND_CACHE.get(effectiveKey) ?? null;
  });

  useEffect(() => {
    if (!effectiveKey) {
      setComponent(null);
      return;
    }

    const cached = BACKGROUND_CACHE.get(effectiveKey);
    if (cached) {
      setComponent(() => cached);
      return;
    }

    let cancelled = false;
    BACKGROUND_LOADERS[effectiveKey]()
      .then((module) => {
        if (cancelled) return;
        const resolved = resolveModule(module, effectiveKey);
        if (!resolved) return;
        BACKGROUND_CACHE.set(effectiveKey, resolved);
        setComponent(() => resolved);
      })
      .catch(() => {
        /* ignore */
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveKey]);

  useEffect(() => {
    if (!key) {
      setResolvedKey(null);
      return;
    }

    if (!deferHeavy || !HEAVY_BACKGROUND_KEYS.has(key) || !fallbackForHeavy) {
      setResolvedKey(key);
      return;
    }

    setResolvedKey(fallbackForHeavy);

    if (!enabled) {
      return;
    }

    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const activateHeavy = () => {
      if (cancelled) return;
      setResolvedKey(key);
    };

    if (
      typeof window !== "undefined" &&
      typeof (window as any).requestIdleCallback === "function"
    ) {
      idleHandle = (window as any).requestIdleCallback(() => activateHeavy(), {
        timeout: heavyDeferMs,
      });
    } else {
      timeoutHandle = setTimeout(activateHeavy, heavyDeferMs);
    }

    return () => {
      cancelled = true;
      if (
        idleHandle != null &&
        typeof window !== "undefined" &&
        typeof (window as any).cancelIdleCallback === "function"
      ) {
        (window as any).cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
      }
    };
  }, [deferHeavy, enabled, fallbackForHeavy, heavyDeferMs, key]);

  if (!effectiveKey) return null;
  return BACKGROUND_CACHE.get(effectiveKey) ?? component;
}

export async function preloadBackground(key: BackgroundKey): Promise<ComponentType<any> | null> {
  const cached = BACKGROUND_CACHE.get(key);
  if (cached) return cached;
  try {
    const module = await BACKGROUND_LOADERS[key]();
    const resolved = resolveModule(module, key);
    if (resolved) {
      BACKGROUND_CACHE.set(key, resolved);
      return resolved;
    }
  } catch {
    /* ignore */
  }
  return null;
}
