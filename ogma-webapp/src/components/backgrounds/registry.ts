import { useEffect, useState } from "react";
import type { ComponentType } from "react";

type BackgroundLoader = () => Promise<{ default: ComponentType<any> } | Record<string, unknown>>;

const BACKGROUND_KEY_LIST = [
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

type UseBackgroundOptions = { enabled?: boolean };

export function useBackgroundComponent(
  key: BackgroundKey | null | undefined,
  options: UseBackgroundOptions = {}
): ComponentType<any> | null {
  const { enabled = true } = options;
  const [component, setComponent] = useState<ComponentType<any> | null>(() => {
    if (!key) return null;
    return BACKGROUND_CACHE.get(key) ?? null;
  });

  useEffect(() => {
    if (!key) {
      setComponent(null);
      return;
    }

    const cached = BACKGROUND_CACHE.get(key);
    if (cached) {
      setComponent(() => cached);
      return;
    }

    if (!enabled) {
      return;
    }

    let cancelled = false;
    BACKGROUND_LOADERS[key]()
      .then((module) => {
        if (cancelled) return;
        const resolved = resolveModule(module, key);
        if (!resolved) return;
        BACKGROUND_CACHE.set(key, resolved);
        setComponent(() => resolved);
      })
      .catch(() => {
        /* ignore */
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, key]);

  if (!key) return null;
  return BACKGROUND_CACHE.get(key) ?? component;
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
