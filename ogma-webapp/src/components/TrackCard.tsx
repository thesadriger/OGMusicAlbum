// /home/ogma/ogma/ogma-webapp/src/components/TrackCard.tsx
import { useEffect, useMemo, useRef, useState, useCallback, type ComponentType, type MutableRefObject } from "react";
import Counter from "@/components/Counter";
import type { Track } from "@/types/types";
import { sendTrackToMe } from "@/lib/api";
import { emitPlayTrack } from "@/hooks/usePlayerBus";
import GradientRing from "@/components/GradientRing";
import { addToPlaylist, inPlaylist, removeFromPlaylist, addItemToPlaylist, listMyPlaylists } from "@/lib/playlists";
import AddToPlaylistPopover from "@/components/AddToPlaylistPopover";

// Новые импорты фоновых компонентов React Bits
import LiquidChrome from "@/components/backgrounds/LiquidChrome";
import Squares from "@/components/backgrounds/Squares";
import LetterGlitch from "@/components/backgrounds/LetterGlitch";
import Orb from "@/components/backgrounds/Orb";
import Ballpit from "@/components/backgrounds/Ballpit";
import Waves from "@/components/backgrounds/Waves";
import Iridescence from "@/components/backgrounds/Iridescence";
import Hyperspeed from "@/components/backgrounds/Hyperspeed";
import Threads from "@/components/backgrounds/Threads";
import DotGrid from "@/components/backgrounds/DotGrid";
import RippleGrid from "@/components/backgrounds/RippleGrid";
import FaultyTerminal from "@/components/backgrounds/FaultyTerminal";
import Dither from "@/components/backgrounds/Dither";
import Galaxy from "@/components/backgrounds/Galaxy";
import PrismaticBurst from "@/components/backgrounds/PrismaticBurst";
import Lightning from "@/components/backgrounds/Lightning";
import Beams from "@/components/backgrounds/Beams";
import GradientBlinds from "@/components/backgrounds/GradientBlinds";
import Particles from "@/components/backgrounds/Particles";
import Plasma from "@/components/backgrounds/Plasma";
import Aurora from "@/components/backgrounds/Aurora";
import PixelBlast from "@/components/backgrounds/PixelBlast";
import LightRays from "@/components/backgrounds/LightRays";
import Silk from "@/components/backgrounds/Silk";
import DarkVeil from "@/components/backgrounds/DarkVeil";
import Prism from "@/components/backgrounds/Prism";
import LiquidEther from "@/components/backgrounds/LiquidEther";
import GlassSurface from "@/components/GlassSurface";
import {
  SwipeController,
  TRIGGER_COMMIT,
  LEFT_REVEAL,
  LEFT_MIN_OPEN,
} from "@/components/trackCardSwipe/SwipeController";
import { ScrubController } from "@/components/trackCardSwipe/ScrubController";
import type { SwipeReleaseDecision } from "@/components/trackCardSwipe/SwipeController";

type Props = {
  t: Track;
  isActive?: boolean;
  isPaused?: boolean;
  onToggle: () => void;
  mode?: "default" | "playlist";
  onRemoveFromPublic?: (track: Track) => Promise<void> | void;

  /** форсируем режим/ключ фона (нужно для предпросмотров в настройках) */
  forceBgMode?: "random" | "fixed";
  forceBgKey?: string;
};


const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

type MyPlaylist = { id: string; title: string; is_public: boolean; handle?: string | null };

export function TrackCard({ t, isActive, isPaused, onToggle, mode = "default", onRemoveFromPublic, forceBgMode, forceBgKey, }: Props) {
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubPct, setScrubPct] = useState(0);
  const lastProgressRef = useRef(0);

  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [anim, setAnim] = useState<"none" | "snap" | "remove">("none");
  const [leftOpen, setLeftOpen] = useState(false);
  const [toast, setToast] = useState<null | "added" | "exists" | "removed" | "sending" | "sent" | "error">(null);
  const [addedWhere, setAddedWhere] = useState<string | null>(null);

  const swipeControllerRef = useRef<SwipeController | null>(null);
  const scrubControllerRef = useRef<ScrubController | null>(null);

  const settleState = useCallback((next: { dx: number; anim: "none" | "snap" | "remove"; leftOpen: boolean }) => {
    setAnim(next.anim);
    setDx(next.dx);
    setLeftOpen(next.leftOpen);
  }, []);

  // выбор плейлиста
  const [chooseOpen, setChooseOpen] = useState(false);
  const [publicPls, setPublicPls] = useState<MyPlaylist[]>([]);
  const [addingRemote, setAddingRemote] = useState(false);
  const [serverContains, setServerContains] = useState<Record<string, boolean>>({});
  const lastServerEventToken = useRef<string | null>(null);
  const trackMsgId = (t as any)?.msgId ?? (t as any)?.msgID ?? null;
  const trackChatRaw =
    (t as any)?.chat ?? (t as any)?.chat_username ?? (t as any)?.chatUsername ?? null;
  const normalizedTrackChat = trackChatRaw
    ? String(trackChatRaw).replace(/^@/, "").toLowerCase()
    : null;

  const matchesTrack = useCallback(
    (candidate: any) => {
      if (!candidate) return false;
      const candId = candidate.id ?? candidate.trackId ?? candidate.track_id ?? null;
      if (candId && String(candId) === String(t.id)) return true;

      const candMsg = candidate.msgId ?? candidate.msg_id ?? null;
      const candChatRaw =
        candidate.chat ?? candidate.chat_username ?? candidate.chatUsername ?? null;
      const candChat = candChatRaw
        ? String(candChatRaw).replace(/^@/, "").toLowerCase()
        : null;

      if (candMsg != null && trackMsgId != null) {
        const candMsgNum = Number(candMsg);
        const trackMsgNum = Number(trackMsgId);
        if (Number.isFinite(candMsgNum) && Number.isFinite(trackMsgNum)) {
          if (candMsgNum === trackMsgNum) {
            if (!normalizedTrackChat || !candChat) return true;
            return candChat === normalizedTrackChat;
          }
        }
      }

      return false;
    },
    [t.id, trackMsgId, normalizedTrackChat]
  );

  // «заморозка» свайпа пока открыт поповер
  const [frozen, setFrozen] = useState(false);
  const FROZEN_DX = TRIGGER_COMMIT + 18;

  const showBg = frozen || dragging || Math.abs(dx) > 1 || leftOpen;

  const toastBgClass =
    toast === "added" || toast === "exists" ? "bg-emerald-600/85" :
      toast === "removed" || toast === "error" ? "bg-red-600/85" :
        toast === "sending" || toast === "sent" ? "bg-blue-600/85" : "bg-black/70";

  const cardRef = useRef<HTMLDivElement | null>(null);
  const fullPullPxRef = useRef(120);
  const pivotYRef = useRef(50);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => { setToast(null); setAddedWhere(null); }, 900);
    return () => clearTimeout(id);
  }, [toast]);

  // пересчитывать фон при смене настроек
  const [bgVersion, setBgVersion] = useState(0);
  useEffect(() => {
    const onTheme = () => setBgVersion(v => v + 1);
    window.addEventListener("ogma:theme-changed", onTheme as any);
    return () => window.removeEventListener("ogma:theme-changed", onTheme as any);
  }, []);

  async function hasTrackInServerPlaylist(playlistId: string, trackId: string): Promise<boolean> {
    const qs = (s: string) => encodeURIComponent(s);
    const tryPaths = [
      `/api/playlists/${qs(playlistId)}/items?track_id=${qs(trackId)}&limit=10`, // ← сначала универсальный
      `/api/playlists/${qs(playlistId)}/has?track_id=${qs(trackId)}`,
      `/api/playlists/${qs(playlistId)}/contains?track_id=${qs(trackId)}`,
    ];

    for (const url of tryPaths) {
      try {
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        if (res.status === 404 && url.includes('/items')) {
          // если даже items 404 — дальше не стреляем, чтобы не плодить 404
          break;
        }
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) continue;

        const j = await res.json();

        // прямые булевые ответы
        if (typeof j?.has === "boolean") return j.has;
        if (typeof j?.exists === "boolean") return j.exists;
        if (typeof j?.contains === "boolean") return j.contains;

        // ответ списком элементов — ищем именно наш трек
        if (Array.isArray(j?.items)) {
          const found = j.items.some((it: any) =>
            it?.track_id === trackId ||
            it?.trackId === trackId ||
            it?.track?.id === trackId ||
            it?.id === trackId
          );
          if (found) return true;
          continue;
        }
      } catch {
        // молча пробуем следующий url
      }
    }
    return false;
  }

  // Прогресс трека
  const getAudio = useCallback(() =>
    document.querySelector(`audio[data-track-id="${t.id}"]`) as HTMLAudioElement | null,
  [t.id]);
  const remoteContains = useMemo(
    () => Object.values(serverContains).some(Boolean),
    [serverContains]
  );
  const alreadyLocal = inPlaylist(t.id);
  const already = alreadyLocal || remoteContains;
  // --- выбор фоновой анимации React Bits (стабильно "случайно" по id трека) ---
  const BackgroundComp = useMemo<ComponentType<any>>(() => {
    // список без затенения верхнего объекта
    const BG_LIST: ComponentType<any>[] = [
      LiquidChrome, Squares, LetterGlitch, Orb, Ballpit, Waves, Iridescence,
      Hyperspeed, Threads, DotGrid, RippleGrid, FaultyTerminal, Dither, Galaxy, PrismaticBurst,
      Lightning, Beams, GradientBlinds, Particles, Plasma, Aurora, PixelBlast, LightRays,
      Silk, DarkVeil, Prism, LiquidEther,
    ];
    const byKey = {
      LiquidChrome, Squares, LetterGlitch, Orb, Ballpit, Waves, Iridescence,
      Hyperspeed, Threads, DotGrid, RippleGrid, FaultyTerminal, Dither, Galaxy, PrismaticBurst,
      Lightning, Beams, GradientBlinds, Particles, Plasma, Aurora, PixelBlast, LightRays,
      Silk, DarkVeil, Prism, LiquidEther,
    } as Record<string, ComponentType<any>>;

    const pickRandomById = () => {
      const idStr = String(t.id);
      let hash = 0;
      for (let i = 0; i < idStr.length; i++) {
        hash = (hash * 31 + idStr.charCodeAt(i)) >>> 0;
      }
      return (BG_LIST[hash % BG_LIST.length] || Waves) as ComponentType<any>;
    };

    // 👇 helper с guard против SSR
    const lsGet = (key: string): string | null => {
      if (typeof window === "undefined") return null;
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    };

    // 1) источник правды: принудительные пропсы из предпросмотра, иначе — localStorage
    const mode = (forceBgMode ??
      (lsGet("ogma_track_bg_mode") as "random" | "fixed" | null) ??
      "random") as "random" | "fixed";

    if (mode === "fixed") {
      const k = forceBgKey ?? lsGet("ogma_track_bg_key") ?? "";
      if (k && byKey[k]) return byKey[k];
      return pickRandomById();
    }

    // random
    return pickRandomById();
  }, [t.id, bgVersion, forceBgMode, forceBgKey]);

  // дефолтные пропсы только для LetterGlitch
  const bgExtraProps: any =
    BackgroundComp === (LetterGlitch as unknown as ComponentType<any>)
      ? {
        glitchColors: ["#67d4d9", "#5b95f7", "#66daea"],
        glitchSpeed: 0.75,
        centerVignette: false,
        outerVignette: false,
        smooth: true,
        characters: (t.title || "OGMA").slice(0, 18),
      }
      : {};

  // --- ВЫНЕСЕННЫЕ ЭФФЕКТЫ ---

   // 2) глобально блокируем touchmove только во время скраба (iOS/TG overscroll)
  useEffect(() => {
    const onTouchMove = (ev: TouchEvent) => {
      if (scrubbing) ev.preventDefault();
    };
    if (scrubbing)
      document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () =>
      document.removeEventListener("touchmove", onTouchMove as any);
  }, [scrubbing]);

  // визуальная «натянутость»
  const pullPct = clamp(Math.abs(leftOpen ? dx + LEFT_REVEAL : dx) / Math.max(1, fullPullPxRef.current), 0, 1);
  const tiltDeg = clamp((dx / Math.max(1, fullPullPxRef.current)) * 3.2, -4, 4);
  const scaleK = 1 + 0.015 * pullPct;

  const style: React.CSSProperties = {
    transform:
      scrubbing ? "translate3d(0,0,0)" :
        (anim === "remove" ? `translate3d(-110%,0,0)` : `translate3d(${(frozen ? FROZEN_DX : dx)}px,0,0) rotate(${tiltDeg}deg) scale(${scaleK})`),
    transition:
      anim === "snap"
        ? "transform 180ms cubic-bezier(.2,.8,.2,1), opacity 180ms"
        : anim === "remove"
          ? "transform 200ms ease, opacity 200ms ease"
          : "none",
    opacity: anim === "remove" ? 0 : 1,
    touchAction: (scrubbing || frozen) ? "none" : "pan-y",
    overscrollBehavior: "contain",
    overscrollBehaviorY: "contain",
    willChange: "transform, opacity",
    backfaceVisibility: "hidden",
    isolation: "isolate",
    transformOrigin: `50% ${pivotYRef.current}%`,
  };

  const tg = (typeof window !== "undefined"
    ? (window as any)?.Telegram?.WebApp
    : undefined) as any;

  const HAPTIC_OK =
    !!tg?.HapticFeedback &&
    (typeof tg?.isVersionAtLeast === "function"
      ? tg.isVersionAtLeast("6.1")
      : parseFloat(tg?.version || "0") >= 6.1);

  const canHaptic = () => HAPTIC_OK;

  const hapticImpact = (
    kind: "light" | "medium" | "heavy" | "soft" | "rigid" = "light"
  ) => {
    const wa = (typeof window !== "undefined"
      ? (window as any)?.Telegram?.WebApp
      : undefined) as any;
    if (canHaptic()) {
      try {
        wa.HapticFeedback.impactOccurred(kind);
        return;
      } catch {
        /* noop */
      }
    }
    try {
      navigator.vibrate?.(20);
    } catch {
      /* noop */
    }
  };

  const hapticTick = () => {
    const wa = (typeof window !== "undefined"
      ? (window as any)?.Telegram?.WebApp
      : undefined) as any;
    if (canHaptic()) {
      try {
        wa.HapticFeedback.selectionChanged();
        return;
      } catch {
        /* noop */
      }
    }
    try {
      navigator.vibrate?.(6);
    } catch {
      /* noop */
    }
  };

  // --- add flow: локально или показать выбор публичных ---
  const commitAddLocal = () => {
    const { added } = addToPlaylist(t);
    setAddedWhere(null);
    setToast(added ? "added" : "exists");
    hapticImpact(added ? "medium" : "light");
  };

  const commitAdd = async () => {
    try {
      const r = await listMyPlaylists();
      const publics: MyPlaylist[] = (r?.items || []).filter((p: any) => p?.is_public);
      if (Array.isArray(publics) && publics.length > 0) {
        setPublicPls(publics);
        // попытка предзапросить, где уже есть трек
        try {
          const checks = await Promise.all(
            publics.map(async (p) => {
              const ok = await hasTrackInServerPlaylist(p.id, t.id);
              return [p.id, ok] as const;
            })
          );
          const map: Record<string, boolean> = {};
          for (const [id, ok] of checks) {
            if (ok) map[String(id)] = true;
          }
          setServerContains(map);
        } catch { }
        setFrozen(true);
        settleState({ dx: FROZEN_DX, anim: "snap", leftOpen: false });
        setChooseOpen(true);
        hapticImpact("light");
        return;
      }
    } catch { }
    // fallback — локально
    commitAddLocal();
  };

  // разморозка после закрытия поповера
  useEffect(() => {
    if (!chooseOpen && frozen) {
      settleState({ dx: 0, anim: "snap", leftOpen: false });
      setFrozen(false);
    }
  }, [chooseOpen, frozen, settleState]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onAdded = (event: Event) => {
      const detail = (event as CustomEvent<any>)?.detail ?? {};
      const candidate = detail.track ?? detail;
      if (!matchesTrack(candidate)) return;

      const pidRaw = detail.playlistId ?? detail.playlist_id ?? null;
      if (pidRaw != null) {
        const pid = String(pidRaw);
        setServerContains((prev) => {
          if (prev[pid]) return prev;
          return { ...prev, [pid]: true };
        });
      }

      if (detail?.token === lastServerEventToken.current) return;

      if (!chooseOpen) {
        const badge = detail.handle
          ? `@${String(detail.handle).replace(/^@/, "")}`
          : null;
        setAddedWhere(badge);
        setToast("added");
      }
    };

    const onRemoved = (event: Event) => {
      const detail = (event as CustomEvent<any>)?.detail ?? {};
      const candidate = detail.track ?? detail;
      if (!matchesTrack(candidate)) return;

      const pidRaw = detail.playlistId ?? detail.playlist_id ?? null;
      if (pidRaw != null) {
        const pid = String(pidRaw);
        setServerContains((prev) => {
          if (!(pid in prev)) return prev;
          const next = { ...prev };
          delete next[pid];
          return next;
        });
      } else {
        setServerContains((prev) => (Object.keys(prev).length ? {} : prev));
      }

      if (detail?.token === lastServerEventToken.current) return;

      if (!chooseOpen) {
        setAddedWhere(null);
      }
    };

    window.addEventListener("ogma:public-playlist-item-added", onAdded as any);
    window.addEventListener("ogma:public-playlist-item-removed", onRemoved as any);

    return () => {
      window.removeEventListener("ogma:public-playlist-item-added", onAdded as any);
      window.removeEventListener("ogma:public-playlist-item-removed", onRemoved as any);
    };
  }, [matchesTrack, chooseOpen]);

  const commitDownload = async () => {
    setToast("sending"); hapticImpact("medium");
    try { await sendTrackToMe(t); setToast("sent"); } catch { setToast("error"); }
  };

  const performCommitRemove = useCallback(async () => {
    settleState({ dx: 0, anim: "remove", leftOpen: false });
    hapticImpact("heavy");
    try {
      if (mode === "playlist" && onRemoveFromPublic) {
        await onRemoveFromPublic(t);
      } else {
        removeFromPlaylist(t.id);
      }
      setToast("removed");
    } catch {
      setToast("error");
    } finally {
      setTimeout(() => {
        settleState({ dx: 0, anim: "snap", leftOpen: false });
      }, 200);
    }
  }, [mode, onRemoveFromPublic, t, hapticImpact, settleState]);

  const handleSwipeRelease = useCallback((decision: SwipeReleaseDecision) => {
    const finalize = (anim: "none" | "snap" | "remove" = decision.anim, left = decision.leftOpen, dxTarget = decision.targetDx) => {
      settleState({ dx: dxTarget, anim, leftOpen: left });
    };

    switch (decision.outcome) {
      case "tap": {
        finalize("snap", false, 0);
        if (isActive) {
          onToggle();
        } else {
          emitPlayTrack(t);
          onToggle();
        }
        break;
      }
      case "leftPeekTap": {
        finalize("snap", false, 0);
        if (mode === "playlist") {
          void performCommitRemove();
        } else {
          void commitDownload();
        }
        break;
      }
      case "commitRight": {
        finalize("snap", false, 0);
        if (mode === "default") {
          awaitMaybe(commitAdd)();
        } else {
          void commitDownload();
        }
        break;
      }
      case "commitLeft": {
        if (mode === "playlist") {
          void performCommitRemove();
        } else {
          void commitDownload();
          finalize("snap", false, 0);
        }
        break;
      }
      case "openLeftPeek": {
        finalize("snap", true, -LEFT_REVEAL);
        break;
      }
      case "close":
      case "cancelledByScroll": {
        finalize("snap", decision.leftOpen, decision.targetDx);
        break;
      }
      default:
        finalize("snap", false, 0);
    }
  }, [commitDownload, isActive, mode, onToggle, performCommitRemove, settleState, t]);

  const handleSwipeReleaseRef = useRef(handleSwipeRelease);
  useEffect(() => { handleSwipeReleaseRef.current = handleSwipeRelease; }, [handleSwipeRelease]);

  const hapticImpactRef = useRef(hapticImpact);
  useEffect(() => { hapticImpactRef.current = hapticImpact; }, [hapticImpact]);

  const hapticTickRef = useRef(hapticTick);
  useEffect(() => { hapticTickRef.current = hapticTick; }, [hapticTick]);

  useEffect(() => {
    const swipe = new SwipeController({
      onDragStart: ({ pivotY, fullPullPx }) => {
        pivotYRef.current = pivotY;
        fullPullPxRef.current = fullPullPx;
        setDragging(true);
        setAnim("none");
      },
      onDragMove: (nextDx) => {
        setDx(nextDx);
      },
      onDragEnd: () => {
        setDragging(false);
      },
      onRelease: (decision) => {
        handleSwipeReleaseRef.current(decision);
      },
      onHapticTick: () => {
        if (!scrubControllerRef.current?.isScrubbing()) {
          hapticTickRef.current();
        }
      },
      onHapticImpact: (kind) => {
        hapticImpactRef.current(kind);
      },
    });
    swipeControllerRef.current = swipe;
    return () => {
      swipe.dispose();
      swipeControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scrub = new ScrubController({
      onScrubStart: ({ pct }) => {
        setScrubbing(true);
        setScrubPct(pct);
        lastProgressRef.current = pct;
        swipeControllerRef.current?.freeze();
        setDragging(false);
        settleState({ dx: 0, anim: "snap", leftOpen: false });
      },
      onScrubProgress: (pct) => {
        setScrubPct(pct);
        lastProgressRef.current = pct;
        const audio = getAudio();
        if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = pct * audio.duration;
        }
      },
      onScrubEnd: () => {
        setScrubbing(false);
        swipeControllerRef.current?.unfreeze();
        settleState({ dx: 0, anim: "snap", leftOpen: false });
      },
      onHapticImpact: (kind) => hapticImpactRef.current(kind),
    });
    scrubControllerRef.current = scrub;
    return () => {
      scrub.dispose();
      scrubControllerRef.current = null;
    };
  }, [getAudio, settleState]);

  useEffect(() => {
    const swipe = swipeControllerRef.current;
    if (!swipe) return;
    if (frozen || chooseOpen) swipe.freeze();
    else swipe.unfreeze();
  }, [chooseOpen, frozen]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (frozen || chooseOpen) return;
    const swipe = swipeControllerRef.current;
    const scrub = scrubControllerRef.current;
    if (!swipe || !scrub) return;

    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();

    swipe.pointerDown({ x: e.clientX, y: e.clientY, rect, leftOpen });
    const basePct = clamp(Number.isFinite(lastProgressRef.current) ? lastProgressRef.current : 0, 0, 1);
    scrub.pointerDown({
      x: e.clientX,
      y: e.clientY,
      rect,
      initialPct: basePct,
      isActive: !!isActive,
    });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (frozen || chooseOpen) return;
    const swipe = swipeControllerRef.current;
    const scrub = scrubControllerRef.current;
    if (!swipe || !scrub) return;

    scrub.pointerMove({ x: e.clientX, y: e.clientY });
    if (!scrub.isScrubbing()) {
      swipe.pointerMove({ x: e.clientX, y: e.clientY });
    }
  };

  const onPointerUp = () => {
    if (frozen || chooseOpen) return;
    const swipe = swipeControllerRef.current;
    const scrub = scrubControllerRef.current;
    if (!swipe || !scrub) return;

    const wasScrubbing = scrub.isScrubbing();
    scrub.pointerUp();
    if (wasScrubbing) {
      return;
    }
    swipe.pointerUp({ leftOpen });
  };

  const onPointerCancel = () => {
    const swipe = swipeControllerRef.current;
    const scrub = scrubControllerRef.current;
    if (!swipe || !scrub) return;

    const wasScrubbing = scrub.isScrubbing();
    scrub.cancel();
    swipe.cancel({ leftOpen: wasScrubbing ? false : leftOpen });
  };

  const leftBgColor =
    mode === "playlist"
      ? `rgba(220,38,38,${0.35 + 0.65 * clamp(-dx / TRIGGER_COMMIT, 0, 1)})`
      : `rgba(37,99,235,${0.35 + 0.65 * clamp(-dx / TRIGGER_COMMIT, 0, 1)})`;
  const rightBgColor =
    mode === "default"
      ? `rgba(132,171,123,${0.35 + 0.65 * clamp(dx / TRIGGER_COMMIT, 0, 1)})`
      : `rgba(37,99,235,${0.35 + 0.65 * clamp(dx / TRIGGER_COMMIT, 0, 1)})`;

  return (
    <div className="relative">
      {showBg && !scrubbing && (
        <>
          {(dx < 0 || leftOpen) && (
            <div
              className="absolute inset-0 rounded-2xl overflow-hidden select-none flex items-center justify-end pr-4"
              style={{ background: leftBgColor, transition: "background 120ms linear" }}
            >
              <span className="text-white text-sm opacity-90">
                {mode === "playlist" ? "Удалить" : "Скачать"}
              </span>
            </div>
          )}

          {dx > 0 && (
            <div
              className="absolute inset-0 rounded-2xl overflow-hidden select-none flex items-center justify-start pl-4"
              style={{ background: rightBgColor, transition: "background 120ms linear" }}
            >
              <span className="text-white text-sm font-medium">
                {mode === "default"
                  ? (already ? "В плейлисте" : "В плейлист")
                  : "Скачать"}
              </span>
            </div>
          )}
        </>
      )}

      <div
        ref={cardRef}
        role="button"
        tabIndex={0}
        aria-pressed={!!isActive && !isPaused}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onTouchMoveCapture={(e) => {
          if (scrubbing) e.preventDefault();
        }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
          if (e.key === "Escape" && leftOpen) {
            settleState({ dx: 0, anim: "snap", leftOpen: false });
          }
        }}
        style={{
          ...style,
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
        }}
        className={
          "relative z-10 cursor-pointer rounded-2xl p-4 shadow bg-white dark:bg-zinc-900 " +
          "border border-zinc-200 dark:border-zinc-800 overflow-hidden select-none " +
          (isActive
            ? isPaused
              ? "opacity-95"
              : ""
            : "hover:bg-white/95 dark:hover:bg-zinc-900/95")
        }
      >
        {/* Фоновая анимация + прогресс-плёнка */}
        {isActive && (
          <div className="absolute inset-0 z-0 pointer-events-none">
            <div className="absolute inset-0 pointer-events-none opacity-70">
              <BackgroundComp
                key={`${bgVersion}:${forceBgMode ?? ""}:${forceBgKey ?? ""}`}
                {...bgExtraProps}
              />
            </div>

            <TrackProgressOverlay
              trackId={t.id}
              isActive={!!isActive}
              getAudio={getAudio}
              scrubbing={scrubbing}
              scrubPct={scrubPct}
              lastProgressRef={lastProgressRef}
            />
          </div>
        )}

        {/* Обводка активного трека */}
        {isActive && (
          <GradientRing
            className="absolute inset-0 z-10"
            radius={16}
            thickness={2}
            colors={["#67d4d9", "#5b95f7", "#66daea", "#5db5f7"]}
            speed={0.6}
            active
          />
        )}

        {/* Контент трека */}
        <div className="flex items-center gap-3 relative">
          <div className="flex-1 min-w-0 pr-20 md:pr-24 text-left">
            <div className="text-base font-semibold truncate text-white drop-shadow-[0_1px_2px_rgba(0,0,0,.35)]">
              {t.title}
            </div>
            <div className="text-sm truncate text-zinc-200 drop-shadow-[0_1px_2px_rgba(0,0,0,.35)]">
              {t.artists?.join(", ")}
            </div>
            <div className="mt-1 text-xs truncate text-zinc-300/80 drop-shadow-[0_1px_1px_rgba(0,0,0,.35)]">
              {t.hashtags?.join(" ")}
            </div>
          </div>

          <TrackTimer
            trackId={t.id}
            isActive={!!isActive}
            getAudio={getAudio}
            scrubbing={scrubbing}
            scrubPct={scrubPct}
            lastProgressRef={lastProgressRef}
          />
        </div>

        {/* Toast (поверх карточки) */}
        {toast && (
          <div
            className={`absolute top-2 right-2 z-20 text-xs rounded-md px-2 py-1 ${toastBgClass} text-white shadow-sm pointer-events-none`}
          >
            {toast === "added"
              ? addedWhere
                ? `Добавлено в ${addedWhere}`
                : "Добавлено"
              : toast === "exists"
                ? "Уже в плейлисте"
                : toast === "removed"
                  ? "Удалено"
                  : toast === "sending"
                    ? "Отправляю…"
                    : toast === "sent"
                      ? "Отправлено"
                      : toast === "error"
                        ? "Ошибка отправки"
                        : ""}
          </div>
        )}

        {/* Поповер выбора плейлиста */}
        <AddToPlaylistPopover
          open={chooseOpen}
          anchorRef={cardRef}
          onClose={() => {
            setChooseOpen(false);
            setFrozen(false);
            settleState({ dx: 0, anim: "snap", leftOpen: false });
          }}
          trackTitle={t.title}
          trackArtists={t.artists}
          playlists={publicPls}
          disabled={addingRemote}
          containsServer={serverContains}
          onPickLocal={() => {
            setChooseOpen(false);
            commitAddLocal();
          }}
          onPickServer={async (p) => {
            setAddingRemote(true);
            try {
              const playlistId = String(p.id);
              await addItemToPlaylist(playlistId, t.id);
              const clean = (p.handle || "").toString().replace(/^@/, "");
              setAddedWhere(clean ? `@${clean}` : null);
              setServerContains((m) => ({ ...m, [playlistId]: true }));
              setToast("added");
              hapticImpact("medium");

              if (typeof window !== "undefined") {
                const token =
                  typeof (globalThis as any).crypto?.randomUUID === "function"
                    ? (globalThis as any).crypto.randomUUID()
                    : `pl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                lastServerEventToken.current = token;
                let detailTrack: any;
                try {
                  if (typeof (globalThis as any).structuredClone === "function") {
                    detailTrack = (globalThis as any).structuredClone(t);
                  } else {
                    detailTrack = JSON.parse(JSON.stringify(t));
                  }
                } catch {
                  detailTrack = { ...t };
                }
                window.dispatchEvent(
                  new CustomEvent("ogma:public-playlist-item-added", {
                    detail: {
                      playlistId,
                      handle: clean || null,
                      playlistTitle: p.title ?? null,
                      track: detailTrack,
                      token,
                    },
                  })
                );
              }
            } catch {
              setToast("error");
            } finally {
              setAddingRemote(false);
              setChooseOpen(false);
            }
          }}
        />
      </div>
    </div>
  );
}

type TrackProgressOverlayProps = {
  trackId: string | number;
  isActive: boolean;
  getAudio: () => HTMLAudioElement | null;
  scrubbing: boolean;
  scrubPct: number;
  lastProgressRef: MutableRefObject<number>;
};

function TrackProgressOverlay({ trackId, isActive, getAudio, scrubbing, scrubPct, lastProgressRef }: TrackProgressOverlayProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const scrubbingRef = useRef(scrubbing);

  const setWidth = useCallback((pct: number) => {
    const node = barRef.current;
    if (!node) return;
    const clamped = clamp(pct, 0, 1);
    node.style.width = `${clamped * 100}%`;
  }, []);

  useEffect(() => {
    scrubbingRef.current = scrubbing;
  }, [scrubbing]);

  useEffect(() => {
    if (scrubbing) {
      setWidth(scrubPct);
      return;
    }
    setWidth(lastProgressRef.current);
  }, [scrubbing, scrubPct, lastProgressRef, setWidth]);

  useEffect(() => {
    let running = false;

    const stop = () => {
      running = false;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    if (!isActive) {
      stop();
      lastProgressRef.current = 0;
      if (!scrubbingRef.current) setWidth(0);
      return () => { stop(); };
    }

    const audio = getAudio();
    if (!audio) {
      lastProgressRef.current = 0;
      setWidth(0);
      return () => { stop(); };
    }

    const updateFromAudio = () => {
      const dur = audio.duration;
      if (Number.isFinite(dur) && dur > 0) {
        const pct = clamp(audio.currentTime / dur, 0, 1);
        lastProgressRef.current = pct;
        if (!scrubbingRef.current) setWidth(pct);
      }
    };

    const loop = () => {
      updateFromAudio();
      if (running) rafRef.current = requestAnimationFrame(loop);
    };

    const start = () => {
      if (running) return;
      running = true;
      rafRef.current = requestAnimationFrame(loop);
    };

    const handlePause = () => {
      updateFromAudio();
      stop();
    };

    const handleEnded = () => {
      stop();
      lastProgressRef.current = 0;
      setWidth(0);
    };

    audio.addEventListener("timeupdate", updateFromAudio);
    audio.addEventListener("durationchange", updateFromAudio);
    audio.addEventListener("play", start);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    updateFromAudio();
    if (!audio.paused) start();

    return () => {
      stop();
      audio.removeEventListener("timeupdate", updateFromAudio);
      audio.removeEventListener("durationchange", updateFromAudio);
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [trackId, isActive, getAudio, lastProgressRef, setWidth]);

  return (
    <div
      ref={barRef}
      className="absolute inset-y-0 left-0 pointer-events-none z-[1]"
      style={{ width: `${lastProgressRef.current * 100}%` }}
    >
      <GlassSurface
        borderRadius={16}
        backgroundOpacity={0.05}
        saturation={1}
        blur={25}
        noBorder
        noShadow
        tone="light"
        className="w-full h-full"
      />
    </div>
  );
}

type TrackTimerProps = {
  trackId: string | number;
  isActive: boolean;
  getAudio: () => HTMLAudioElement | null;
  scrubbing: boolean;
  scrubPct: number;
  lastProgressRef: MutableRefObject<number>;
};

function TrackTimer({ trackId, isActive, getAudio, scrubbing, scrubPct, lastProgressRef }: TrackTimerProps) {
  const [mm, setMm] = useState(0);
  const [ss, setSs] = useState(0);
  const rafRef = useRef<number | null>(null);
  const durationRef = useRef(0);
  const lastSecRef = useRef(-1);
  const scrubbingRef = useRef(scrubbing);
  const [visible, setVisible] = useState(false);

  const evaluateVisibility = useCallback((audio?: HTMLAudioElement | null) => {
    if (!isActive) {
      setVisible(false);
      return false;
    }

    const element = audio ?? getAudio();
    const hasDur = !!element && Number.isFinite(element.duration) && element.duration > 0;
    const hasProgress = !!element && element.currentTime > 0;
    const shouldShow = isActive && (hasDur || hasProgress || lastProgressRef.current > 0 || scrubbingRef.current);

    setVisible((prev) => (prev === shouldShow ? prev : shouldShow));
    return shouldShow;
  }, [getAudio, isActive, lastProgressRef]);

  useEffect(() => {
    scrubbingRef.current = scrubbing;
    evaluateVisibility();
  }, [scrubbing, evaluateVisibility]);

  useEffect(() => {
    evaluateVisibility();
  }, [evaluateVisibility, trackId, isActive]);

  useEffect(() => {
    if (!isActive) return;

    let raf: number | null = null;
    let cleanupAudio: (() => void) | null = null;
    let cancelled = false;

    const attach = (audio: HTMLAudioElement) => {
      const handle = () => evaluateVisibility(audio);
      const events: (keyof HTMLMediaElementEventMap)[] = [
        "loadedmetadata",
        "durationchange",
        "timeupdate",
        "play",
        "progress",
        "ended",
      ];
      events.forEach((evt) => audio.addEventListener(evt, handle));
      handle();

      cleanupAudio = () => {
        events.forEach((evt) => audio.removeEventListener(evt, handle));
      };
    };

    const lookup = () => {
      if (cancelled) return;
      const audio = getAudio();
      if (audio) {
        attach(audio);
      } else {
        raf = requestAnimationFrame(lookup);
      }
    };

    lookup();

    return () => {
      cancelled = true;
      if (raf != null) cancelAnimationFrame(raf);
      cleanupAudio?.();
    };
  }, [getAudio, isActive, trackId, evaluateVisibility]);

  const applySeconds = useCallback((seconds: number, force = false) => {
    const clamped = Math.max(0, Math.floor(seconds));
    if (!force && clamped === lastSecRef.current) return;
    lastSecRef.current = clamped;
    const minutes = Math.floor(clamped / 60);
    const secs = clamped % 60;
    setMm((prev) => (prev === minutes ? prev : minutes));
    setSs((prev) => (prev === secs ? prev : secs));
  }, []);

  useEffect(() => {
    let running = false;

    const stop = () => {
      running = false;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    if (!visible) {
      stop();
      return () => { stop(); };
    }

    const audio = getAudio();

    if (!audio || !isActive) {
      stop();
      if (!scrubbingRef.current) {
        lastSecRef.current = -1;
        applySeconds(lastProgressRef.current * (durationRef.current || 0), true);
      }
      return () => { stop(); };
    }

    const update = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        durationRef.current = audio.duration;
      }
      applySeconds(audio.currentTime);
      if (running) rafRef.current = requestAnimationFrame(update);
    };

    const start = () => {
      if (running) return;
      running = true;
      rafRef.current = requestAnimationFrame(update);
    };

    const handlePause = () => {
      update();
      stop();
    };

    const handleEnded = () => {
      stop();
      durationRef.current = Number.isFinite(audio.duration) ? audio.duration : durationRef.current;
      lastSecRef.current = -1;
      applySeconds(0, true);
    };

    const handleDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        durationRef.current = audio.duration;
      }
    };

    audio.addEventListener("timeupdate", update);
    audio.addEventListener("durationchange", handleDuration);
    audio.addEventListener("play", start);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);

    handleDuration();
    update();
    if (!audio.paused) start();

    return () => {
      stop();
      audio.removeEventListener("timeupdate", update);
      audio.removeEventListener("durationchange", handleDuration);
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [trackId, visible, isActive, getAudio, applySeconds, lastProgressRef]);

  useEffect(() => {
    if (!visible) return;
    if (scrubbing) {
      const audio = getAudio();
      const duration = durationRef.current || audio?.duration || 0;
      if (duration > 0) {
        applySeconds(scrubPct * duration, true);
      } else if (audio) {
        applySeconds(audio.currentTime, true);
      } else {
        applySeconds(lastProgressRef.current * durationRef.current, true);
      }
    } else if (!isActive) {
      lastSecRef.current = -1;
      applySeconds(0, true);
    }
  }, [visible, scrubbing, scrubPct, isActive, getAudio, applySeconds, lastProgressRef]);

  if (!visible) return null;

  return (
    <div
      className="absolute top-1.5 bottom-1.5 right-1.5 flex items-center rounded-md px-2 opacity-40"
    >
      <Counter
        value={mm}
        places={[10, 1]}
        fontSize={50}
        padding={0}
        gap={0}
        textColor="white"
        fontWeight={900}
        gradientHeight={0}
        digitStyle={{ width: "1ch" }}
        counterStyle={{ lineHeight: 1 }}
      />
      <span className="mx-0.5 tabular-nums">:</span>
      <Counter
        value={ss}
        places={[10, 1]}
        fontSize={50}
        padding={0}
        gap={0}
        textColor="white"
        fontWeight={900}
        gradientHeight={0}
        digitStyle={{ width: "1ch" }}
        counterStyle={{ lineHeight: 1 }}
      />
    </div>
  );
}

function awaitMaybe<T extends any[]>(fn: (...a: T) => Promise<any> | any) {
  return (...a: T) => { try { const r = fn(...a); if (r && typeof (r as any).then === "function") (r as any).catch?.(() => { }); } catch { } };
}
