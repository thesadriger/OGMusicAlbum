// /src/pages/Profile.tsx
import * as React from "react";
import type { ComponentType } from "react";
import PlaylistPage from "@/pages/PlaylistPage";
import type { Track } from "@/types/types";
import { goHome, goPlaylistHandle } from "@/lib/router";
import CreatePlaylistModal from "@/components/CreatePlaylistModal";
import EditPlaylistModal from "@/components/EditPlaylistModal";
import { listMyPlaylists, deletePlaylist, getPlaylist } from "@/lib/playlists";
import { ensureTelegramAuth, getTelegramDeeplink } from "@/lib/api";
import SwipePlaylistRow from "@/components/SwipePlaylistRow";

// модалка-редактор профиля
import EditProfileModal from "@/components/EditProfileModal";

// модалка-настройки
import SettingsModal from "@/components/SettingsModal";

// хуки
import { useMe } from "@/hooks/useMe";
import { useContentFilter, normalizeTitle } from "@/hooks/useContentFilter";
import { usePlaylistListeningTotal } from "@/hooks/usePlaylistListeningTotal";
import { formatSecondsToHMS } from "@/lib/time";
import { useViewportPresence } from "@/hooks/useViewportPresence";

// фоны

function initials(name?: string | null, username?: string | null) {
  const src = (name || username || "").trim();
  if (!src) return "U";
  const parts = src.split(/\s+/).filter(Boolean);
  const a = (parts[0]?.[0] || username?.[0] || "U").toUpperCase();
  const b = (parts[1]?.[0] || "").toUpperCase();
  return (a + b).slice(0, 2);
}

const pickEmojiFromName = (s?: string | null) => {
  if (!s) return "";
  const m = [...s.matchAll(/\p{Extended_Pictographic}/gu)];
  return m.length ? m[m.length - 1][0] : "";
};

/* ====== Глобальные UI-настройки: загрузка с сервера и применение ====== */

type UiPrefs = {
  headerBgKey?: string;
  trackBgMode?: "random" | "fixed";
  trackBgKey?: string;
  appBg?: { type?: "color" | "image"; color?: string };
};

async function tryFetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { credentials: "include", cache: "no-store", ...init });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error("not json");
  return res.json();
}

async function loadUiPrefsFromServer(): Promise<UiPrefs | null> {
  const paths = ["/me/ui-prefs", "/api/me/ui-prefs", "/me/prefs/ui", "/api/me/prefs/ui", "/me/prefs", "/api/me/prefs"];
  for (const url of paths) {
    try {
      const j = await tryFetchJson(url);
      const prefs = (j?.ui_prefs ?? j?.uiPrefs ?? j) as UiPrefs;
      if (prefs && typeof prefs === "object") return prefs;
    } catch (e: any) {
      if (e?.status && e.status !== 404) {
        /* можно залогировать */
      }
    }
  }
  return null;
}

function applyAppBackgroundFromStorage() {
  try {
    const type = localStorage.getItem("ogma_app_bg_type") || "color";
    if (type === "image") {
      const data = localStorage.getItem("ogma_app_bg_image");
      if (data) {
        document.body.style.backgroundImage = `url(${data})`;
        document.body.style.backgroundSize = "cover";
        document.body.style.backgroundPosition = "center";
        document.body.style.backgroundAttachment = "fixed";
        document.body.style.backgroundColor = "";
      }
    } else {
      const color = localStorage.getItem("ogma_app_bg_color") || "#0b1020";
      document.body.style.backgroundImage = "";
      document.body.style.backgroundColor = color;
    }
  } catch { }
  window.dispatchEvent(new Event("ogma:theme-changed"));
}

type BackgroundLoader = () => Promise<{ default: ComponentType<any> }>;

const backgroundLoaders: Record<string, BackgroundLoader> = {
  LiquidChrome: () => import("@/components/backgrounds/LiquidChrome"),
  Squares: () => import("@/components/backgrounds/Squares"),
  LetterGlitch: () => import("@/components/backgrounds/LetterGlitch"),
  Orb: () => import("@/components/backgrounds/Orb"),
  Ballpit: () => import("@/components/backgrounds/Ballpit"),
  Waves: () => import("@/components/backgrounds/Waves"),
  Iridescence: () => import("@/components/backgrounds/Iridescence"),
  Hyperspeed: () => import("@/components/backgrounds/Hyperspeed"),
  Threads: () => import("@/components/backgrounds/Threads"),
  DotGrid: () => import("@/components/backgrounds/DotGrid"),
  RippleGrid: () => import("@/components/backgrounds/RippleGrid"),
  FaultyTerminal: () => import("@/components/backgrounds/FaultyTerminal"),
  Dither: () => import("@/components/backgrounds/Dither"),
  Galaxy: () => import("@/components/backgrounds/Galaxy"),
  PrismaticBurst: () => import("@/components/backgrounds/PrismaticBurst"),
  Lightning: () => import("@/components/backgrounds/Lightning"),
  Beams: () => import("@/components/backgrounds/Beams"),
  GradientBlinds: () => import("@/components/backgrounds/GradientBlinds"),
  Particles: () => import("@/components/backgrounds/Particles"),
  Plasma: () => import("@/components/backgrounds/Plasma"),
  Aurora: () => import("@/components/backgrounds/Aurora"),
  PixelBlast: () => import("@/components/backgrounds/PixelBlast"),
  LightRays: () => import("@/components/backgrounds/LightRays"),
  Silk: () => import("@/components/backgrounds/Silk"),
  DarkVeil: () => import("@/components/backgrounds/DarkVeil"),
  Prism: () => import("@/components/backgrounds/Prism"),
  LiquidEther: () => import("@/components/backgrounds/LiquidEther"),
};

type ProfileProps = {
  embedded?: boolean;
  onRequestExpand?: (track: Track, rect: DOMRect) => void;
  onCardElementChange?: (trackId: string, el: HTMLDivElement | null) => void;
};

export default function ProfilePage({
  embedded = false,
  onRequestExpand,
  onCardElementChange,
}: ProfileProps) {
  /* ===== Hooks (всегда в одном порядке, без раннего return до них) ===== */
  const { me, loading, error, unauthorized } = useMe();
  const isGuest = unauthorized || !me;
  const listeningTotals = usePlaylistListeningTotal(!isGuest);
  const telegramLink = React.useMemo(() => getTelegramDeeplink(), []);
  const openTelegram = React.useCallback(() => {
    try {
      ensureTelegramAuth();
    } catch { window.location.href = telegramLink; }
  }, [telegramLink]);

  const [localQ, setLocalQ] = React.useState<string>("");
  const [modalOpen, setModalOpen] = React.useState(false);
  const [myPlaylists, setMyPlaylists] = React.useState<any[]>([]);
  const [editPlaylistTarget, setEditPlaylistTarget] = React.useState<any | null>(null);

  // модалка «Настройки»
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  // отдельная модалка «Редактировать профиль»
  const [editOpen, setEditOpen] = React.useState(false);

  // выбранный фон обложки профиля (ключ компонента)
  const [headerBgKey, setHeaderBgKey] = React.useState<string>(() => localStorage.getItem("ogma_profile_header_bg_key") || "RippleGrid");

  // глобальный переключатель фильтра контента
  const [contentFilterOn, setContentFilterOn] = useContentFilter();

  // локальный плейлист для подсчёта чисел в модалке
  const [profileList, setProfileList] = React.useState<Track[]>([]);
  const backgroundCacheRef = React.useRef<Record<string, ComponentType | null>>({});
  const [headerBackgroundComponent, setHeaderBackgroundComponent] = React.useState<ComponentType | null>(null);
  const [allowHeaderVisuals, setAllowHeaderVisuals] = React.useState(false);
  const handleCreatePlaylistClick = React.useCallback(() => {
    if (isGuest) {
      openTelegram();
      return;
    }
    setModalOpen(true);
  }, [isGuest, openTelegram]);
  const handleEditProfile = React.useCallback(() => {
    if (isGuest) {
      openTelegram();
      return;
    }
    setEditOpen(true);
  }, [isGuest, openTelegram]);

  React.useEffect(() => {
    if (!localStorage.getItem("ogma_profile_header_bg_key")) {
      try {
        localStorage.setItem("ogma_profile_header_bg_key", "RippleGrid");
        setHeaderBgKey("RippleGrid");
        window.dispatchEvent(new Event("ogma:theme-changed"));
      } catch { }
    }
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") {
      setAllowHeaderVisuals(true);
      return;
    }

    if (typeof window.matchMedia !== "function") {
      const id = window.requestAnimationFrame(() => setAllowHeaderVisuals(true));
      return () => window.cancelAnimationFrame(id);
    }

    const queries = [
      window.matchMedia("(prefers-reduced-motion: reduce)"),
      window.matchMedia("(prefers-reduced-data: reduce)"),
    ].filter(Boolean) as MediaQueryList[];

    let rafId: number | null = null;

    const scheduleEnable = () => {
      if (rafId != null) return;
      rafId = window.requestAnimationFrame(() => {
        setAllowHeaderVisuals(true);
        rafId = null;
      });
    };

    const cancelSchedule = () => {
      if (rafId == null) return;
      window.cancelAnimationFrame(rafId);
      rafId = null;
    };

    const shouldReduce = () => queries.some((mq) => mq.matches);

    const update = () => {
      if (shouldReduce()) {
        cancelSchedule();
        setAllowHeaderVisuals(false);
      } else {
        setAllowHeaderVisuals(false);
        scheduleEnable();
      }
    };

    update();

    for (const mq of queries) {
      mq.addEventListener?.("change", update);
    }

    return () => {
      cancelSchedule();
      for (const mq of queries) {
        mq.removeEventListener?.("change", update);
      }
    };
  }, []);

  // подгружаем список плейлиста и слушаем изменения
  React.useEffect(() => {
    try {
      setProfileList(getPlaylist());
    } catch { }
    const handler = () => {
      try {
        setProfileList(getPlaylist());
      } catch { }
    };
    window.addEventListener("ogma:playlist-change" as any, handler as any);
    return () => window.removeEventListener("ogma:playlist-change" as any, handler as any);
  }, []);

  React.useEffect(() => {
    if (myPlaylists.length === 0) return;
    const total = profileList.length;
    let changed = false;
    const updated = myPlaylists.map((pl) => {
      if (pl?.is_personal) {
        const current = typeof pl.item_count === "number" ? pl.item_count : 0;
        if (current !== total) {
          changed = true;
          return { ...pl, item_count: total };
        }
      }
      return pl;
    });
    if (changed) {
      setMyPlaylists(updated);
    }
  }, [myPlaylists, profileList.length]);

  // реагируем на локальные смены тем, чтобы обновить headerBgKey
  React.useEffect(() => {
    const onTheme = () => setHeaderBgKey(localStorage.getItem("ogma_profile_header_bg_key") || "");
    const onStorage = (e: StorageEvent) => {
      if (e.key === "ogma_profile_header_bg_key") onTheme();
    };
    window.addEventListener("ogma:theme-changed", onTheme as any);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("ogma:theme-changed", onTheme as any);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  React.useEffect(() => {
    if (!allowHeaderVisuals) {
      setHeaderBackgroundComponent(null);
      return;
    }

    if (!headerBgKey) {
      setHeaderBackgroundComponent(null);
      return;
    }

    const cache = backgroundCacheRef.current;
    const cached = cache[headerBgKey];
    if (cached !== undefined) {
      setHeaderBackgroundComponent(() => cached ?? null);
      return;
    }

    const loader = backgroundLoaders[headerBgKey];
    if (!loader) {
      cache[headerBgKey] = null;
      setHeaderBackgroundComponent(null);
      return;
    }

    let disposed = false;
    setHeaderBackgroundComponent(null);

    loader()
      .then((mod) => {
        if (disposed) return;
        cache[headerBgKey] = mod.default;
        setHeaderBackgroundComponent(() => mod.default);
      })
      .catch(() => {
        if (disposed) return;
        cache[headerBgKey] = null;
        setHeaderBackgroundComponent(null);
      });

    return () => {
      disposed = true;
    };
  }, [allowHeaderVisuals, headerBgKey]);

  // Загрузка UI-настроек пользователя с сервера (кросс-девайс)
  React.useEffect(() => {
    if (!me) return;
    let dead = false;
    (async () => {
      try {
        const prefs = await loadUiPrefsFromServer();
        if (dead || !prefs) return;

        if (prefs.headerBgKey != null) {
          const k = prefs.headerBgKey || "RippleGrid";
          try {
            localStorage.setItem("ogma_profile_header_bg_key", k);
          } catch { }
          setHeaderBgKey(k);
        }
        if (prefs.trackBgMode) {
          try {
            localStorage.setItem("ogma_track_bg_mode", prefs.trackBgMode);
          } catch { }
        }
        if (prefs.trackBgKey != null) {
          try {
            localStorage.setItem("ogma_track_bg_key", prefs.trackBgKey || "");
          } catch { }
        }
        if (prefs.appBg?.type) {
          try {
            localStorage.setItem("ogma_app_bg_type", prefs.appBg.type);
            if (prefs.appBg.type === "color" && prefs.appBg.color) {
              localStorage.setItem("ogma_app_bg_color", prefs.appBg.color);
            }
          } catch { }
        }

        // применяем фон приложения и оповещаем
        applyAppBackgroundFromStorage();
      } catch {
        // молча игнорируем — остаёмся на локальных настройках
      }
    })();
    return () => {
      dead = true;
    };
  }, [me?.telegram_id]);

  React.useEffect(() => {
    if (isGuest) {
      setMyPlaylists([]);
      return;
    }
    let dead = false;
    (async () => {
      try {
        const r = await listMyPlaylists();
        if (!dead) setMyPlaylists(r.items || []);
      } catch { }
    })();
    return () => {
      dead = true;
    };
  }, [isGuest]);

  React.useEffect(() => {
    if (isGuest) return;
    const onRefresh = async () => {
      try {
        const r = await listMyPlaylists();
        setMyPlaylists(r.items || []);
      } catch { }
    };
    window.addEventListener("ogma:myplaylists-change" as any, onRefresh as any);
    return () => window.removeEventListener("ogma:myplaylists-change" as any, onRefresh as any);
  }, [isGuest]);

  // ——— счётчики для модалки настроек ———
  const profileListFilteredByQuery = React.useMemo(() => {
    const s = localQ.trim().toLowerCase();
    if (!s) return profileList;
    return profileList.filter((t) => {
      const hay = (t.title || "") + " " + (t.artists?.join(" ") || "") + " " + ((t as any).hashtags?.join(" ") || "");
      return hay.toLowerCase().includes(s);
    });
  }, [profileList, localQ]);

  const totalVisible = profileListFilteredByQuery.length;

  const totalVisibleDedup = React.useMemo(() => {
    const seen = new Set<string>();
    let cnt = 0;
    for (const t of profileListFilteredByQuery) {
      const key = normalizeTitle(t.title);
      if (key && !seen.has(key)) {
        seen.add(key);
        cnt++;
      }
    }
    return cnt;
  }, [profileListFilteredByQuery]);

  // остальные вычисления (без хуков)
  const label = me?.name || me?.username || (isGuest ? "Гость" : "Профиль");
  const statusEmoji = pickEmojiFromName(me?.name);
  const avatarInitials = isGuest ? "OG" : initials(me?.name, me?.username);
  const listenSeconds = !isGuest ? listeningTotals.seconds ?? null : null;
  const listenSecondsDisplay = React.useMemo(() => {
    if (isGuest) return "—";
    if (listeningTotals.loading) return "…";
    if (listenSeconds == null) return "—";
    return formatSecondsToHMS(listenSeconds);
  }, [isGuest, listeningTotals.loading, listenSeconds]);
  const listenSecondsTitle = React.useMemo(() => {
    if (isGuest) return "Войдите через Telegram, чтобы увидеть статистику";
    if (listenSeconds == null) {
      return listeningTotals.error ? `Не удалось загрузить: ${listeningTotals.error.message}` : undefined;
    }
    return `${listenSeconds} сек.`;
  }, [isGuest, listenSeconds, listeningTotals.error]);

  const {
    ref: headerRef,
    className: headerRevealClass,
    shouldRender: headerShouldRender,
  } = useViewportPresence<HTMLDivElement>({ amount: 0.4, margin: "-45% 0px -25% 0px", freezeOnceVisible: true });
  const { ref: searchCardRef, className: searchRevealClass } = useViewportPresence<HTMLDivElement>({ amount: 0.3 });
  const { ref: playlistsRef, className: playlistsRevealClass } = useViewportPresence<HTMLDivElement>({ amount: 0.3 });
  const { ref: embedRef, className: embedRevealClass } = useViewportPresence<HTMLDivElement>({ amount: 0.3 });

  /* ===== Render (после всех хуков) ===== */

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="space-y-4">
          <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3 shadow">
            <div className="h-44 w-full rounded-xl bg-gradient-to-b from-sky-400/20 to-indigo-500/10 animate-pulse" />
          </div>
          <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3 shadow">
            <div className="h-6 w-48 bg-black/10 dark:bg-white/10 animate-pulse mb-2 rounded" />
            <div className="h-4 w-32 bg-black/10 dark:bg-white/10 animate-pulse rounded" />
          </div>
        </div>
      </div>
    );
  }
  if (error) return <div className="max-w-3xl mx-auto p-4 text-red-400">Ошибка загрузки профиля</div>;

  const HeaderBackground = headerBackgroundComponent;
  const headerBackgroundKey = HeaderBackground && headerBgKey ? `profile:${headerBgKey}` : "profile:fallback";

  return (
    <div className="max-w-3xl mx-auto space-y-4 player-safe">
      {/* Шапка */}
      <div
        ref={headerRef}
        className={`${headerRevealClass} relative z-[100] isolate transform-gpu h-60 overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/50 shadow`}
      >
        {/* dead-zones под кнопками */}
        {!embedded && (
          <>
            <div
              aria-hidden="true"
              className="absolute top-0 left-0 z-40 w-16 h-16 sm:w-12 sm:h-12"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
            <div
              aria-hidden="true"
              className="absolute top-0 right-0 z-40 w-16 h-16 sm:w-12 sm:h-12"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          </>
        )}

        {/* Назад */}
        {!embedded && (
          <button
            onClick={goHome}
            aria-label="На главную"
            title="На главную"
            className="absolute left-3 top-3 z-50 pointer-events-auto inline-flex items-center justify-center w-9 h-9 rounded-full
               bg-black/30 text-white ring-1 ring-white/25 backdrop-blur hover:bg-black/40 active:scale-95 transition"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}

        {/* Настройки */}
        {!embedded && (
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Настройки"
            title="Настройки"
            className="absolute right-3 top-3 z-50 pointer-events-auto inline-flex items-center justify-center w-9 h-9 rounded-full
               bg-black/30 text-white ring-1 ring-white/25 backdrop-blur hover:bg-black/40 active:scale-95 transition"
          >
            <svg width="20" height="20" viewBox="0 0 1024 1024" aria-hidden="true" fill="currentColor">
              <path d="M600.704 64a32 32 0 0130.464 22.208l35.2 109.376c14.784 7.232 28.928 15.36 42.432 24.512l112.384-24.192a32 32 0 0134.432 15.36L944.32 364.8a32 32 0 01-4.032 37.504l-77.12 85.12a357.12 357.12 0 010 49.024l77.12 85.248a32 32 0 014.032 37.504l-88.704 153.6a32 32 0 01-34.432 15.296L708.8 803.904c-13.44 9.088-27.648 17.28-42.368 24.512l-35.264 109.376A32 32 0 01600.704 960H423.296a32 32 0 01-30.464-22.208L357.696 828.48a351.616 351.616 0 01-42.56-24.64l-112.32 24.256a32 32 0 01-34.432-15.36L79.68 659.2a32 32 0 014.032-37.504l77.12-85.248a357.12 357.12 0 010-48.896l-77.12-85.248A32 32 0 0179.68 364.8l88.704-153.6a32 32 0 0134.432-15.296l112.32 24.256c13.568-9.152 27.776-17.408 42.56-24.64l35.2-109.312A32 32 0 01423.232 64H600.64zm-23.424 64H446.72l-36.352 113.088-24.512 11.968a294.113 294.113 0 00-34.816 20.096l-22.656 15.36-116.224-25.088-65.28 113.152 79.68 88.192-1.92 27.136a293.12 293.12 0 000 40.192l1.92 27.136-79.808 88.192 65.344 113.152 116.224-25.024 22.656 15.296a294.113 294.113 0 0034.816 20.096l24.512 11.968L446.72 896h130.688l36.48-113.152 24.448-11.904a288.282 288.282 0 0034.752-20.096l22.592-15.296 116.288 25.024 65.28-113.152-79.744-88.192 1.92-27.136a293.12 293.12 0 000-40.256l-1.92-27.136 79.808-88.128-65.344-113.152-116.288 24.96-22.592-15.232a287.616 287.616 0 00-34.752-20.096l-24.448-11.904L577.344 128zM512 320a192 192 0 110 384 192 192 0 010-384zm0 64a128 128 0 100 256 128 128 0 000-256z" />
            </svg>
          </button>
        )}

        {/* Анимированный фон */}
        <div className="absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
          {allowHeaderVisuals && headerShouldRender && HeaderBackground ? (
            <>
              <div className="absolute inset-0" key={headerBackgroundKey}>
                <HeaderBackground />
              </div>
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background:
                    "radial-gradient(120% 75% at 50% 0%, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 55%, rgba(0,0,0,.35) 100%)",
                }}
              />
            </>
          ) : (
            <>
              <div
                className="absolute -inset-24 rounded-[9999px] animate-spin [animation-duration:26s]"
                style={{
                  background: "conic-gradient(#67d4d9, #5b95f7, #66daea, #5db5f7, #67d4d9)",
                  filter: "blur(30px)",
                  opacity: 0.55,
                }}
              />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background:
                    "radial-gradient(120% 75% at 50% 0%, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 55%, rgba(0,0,0,.35) 100%)",
                }}
              />
            </>
          )}
        </div>

        {/* Аватар */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-[55%]">
          <div className="p-[2px] rounded-full animate-spin [animation-duration:18s]" style={{ background: "conic-gradient(#67d4d9, #5b95f7, #66daea, #5db5f7, #67d4d9)" }}>
            <div className="size-28 rounded-full overflow-hidden bg-black/10 grid place-items-center text-3xl font-semibold text-white/90 ring-2 ring-white/20">
              {me?.photo_url ? (
                <img src={me.photo_url} alt="Аватар" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <span>{avatarInitials}</span>
              )}
            </div>
          </div>
        </div>

        {/* Имя (время — только вне embedded) */}
        <div className="absolute bottom-4 w-full px-4 text-center">
          <div className="text-xl font-semibold tracking-wide">
            {label} {statusEmoji && <span className="align-middle">{statusEmoji}</span>}
          </div>
          {!embedded && (
            <div className="mt-1 text-sm text-zinc-300" title={listenSecondsTitle}>
              {isGuest ? (
                <span>Войдите через Telegram, чтобы синхронизировать статистику.</span>
              ) : (
                <>
                  Общее прослушанное время плейлистов:{" "}
                  <span className="font-mono">{listenSecondsDisplay}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Поиск по плейлисту — карточка */}
      <div
        ref={searchCardRef}
        className={`${searchRevealClass} rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3`}
      >
        <div className="flex items-center gap-2">
          <form className="relative flex-1" onSubmit={(e) => e.preventDefault()}>
            <input
              value={localQ}
              onChange={(e) => setLocalQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setLocalQ("");
              }}
              placeholder="Поиск в плейлисте"
              className="w-full rounded-xl px-4 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 pr-11"
            />
            {localQ.trim().length > 0 && (
              <button
                type="button"
                onClick={() => setLocalQ("")}
                aria-label="Очистить поиск"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 h-7 w-7 flex items-center justify-center rounded-full bg-transparent text-zinc-400 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                ×
              </button>
            )}
          </form>

          <button
            type="button"
            onClick={handleCreatePlaylistClick}
            aria-label={isGuest ? "Открыть в Telegram" : "Создать плейлист"}
            title={isGuest ? "Открыть мини-приложение в Telegram для создания плейлистов" : "Создать новый плейлист"}
            className={`px-3 py-2 rounded-xl text-sm transition ${
              isGuest
                ? "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 hover:opacity-90"
                : "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 hover:opacity-90 active:opacity-90"
            }`}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor" aria-hidden="true">
              <path d="M12,20a1,1,0,0,1-1-1V13H5a1,1,0,0,1,0-2h6V5a1,1,0,0,1,2,0v6h6a1,1,0,0,1,0,2H13v6A1,1,0,0,1,12,20Z" />
            </svg>
          </button>
        </div>

        <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Создайте публичный плейлист и делитесь им с друзьями.</div>
      </div>

      {/* Мои плейлисты — карточка */}
      <div
        ref={playlistsRef}
        className={`${playlistsRevealClass} rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3`}
      >
        {myPlaylists.length > 0 ? (
          <div className="flex flex-col gap-2">
            {myPlaylists.map((p) => (
              <SwipePlaylistRow
                key={p.id}
                p={p}
                onOpen={p.is_public && p.handle ? () => goPlaylistHandle(p.handle) : undefined}
                onDelete={async () => {
                  setMyPlaylists((prev) => prev.filter((x) => x.id !== p.id));
                  try {
                    if (p.is_public && p.handle) {
                      await deletePlaylist({ handle: p.handle, id: p.id });
                    } else {
                      await deletePlaylist({ id: p.id });
                    }
                  } catch (e) {
                    try {
                      const r = await listMyPlaylists();
                      setMyPlaylists(r.items || []);
                    } catch { }
                  }
                }}
                onEdit={(pl) => {
                  if (isGuest) {
                    openTelegram();
                    return;
                  }
                  setEditPlaylistTarget({
                    ...pl,
                    id: String(pl.id),
                    handle: pl.handle ?? null,
                  });
                }}
              />
            ))}
          </div>
        ) : (
          <div className="text-sm text-zinc-500">
            {isGuest ? (
              <div className="space-y-3">
                <p>Авторизуйтесь через Telegram, чтобы создавать и управлять плейлистами.</p>
                <button
                  type="button"
                  onClick={openTelegram}
                  className="inline-flex items-center gap-2 rounded-xl px-3 py-2 bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 hover:opacity-90 transition"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden="true">
                    <path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3l-1.8 1.8h4.5V4.5l-1.7 1.7A9 9 0 1 0 21 12h-2.25a6.75 6.75 0 1 1-6.75-6.75V3A9 9 0 0 0 4.5 12Z" />
                  </svg>
                  <span>Открыть в Telegram</span>
                </button>
                <p className="text-xs text-zinc-400">
                  Ссылка:{' '}
                  <a href={telegramLink} className="underline" target="_blank" rel="noreferrer">
                    {telegramLink}
                  </a>
                </p>
              </div>
            ) : (
              "У вас пока нет плейлистов."
            )}
          </div>
        )}
      </div>

      {/* Встроенный плейлист — карточка с мягкими краями */}
      <div
        ref={embedRef}
        className={`${embedRevealClass} rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3`}
      >
        <PlaylistPage
          key="profile-playlist-embed"
          embedded
          onBack={() => { }}
          q={localQ}
          onRequestExpand={onRequestExpand}
          onCardElementChange={onCardElementChange}
        />
      </div>

      {/* Модалка «Настройки» */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onEditProfile={() => {
          setSettingsOpen(false);
          handleEditProfile();
        }}
        contentFilterOn={contentFilterOn}
        setContentFilterOn={setContentFilterOn}
        // новое: показываем «Всего треков …» и число зависит от переключателя
        visibleTracksCount={totalVisible}
        visibleTracksCountFiltered={totalVisibleDedup}
      />

      <EditProfileModal open={!isGuest && editOpen} onClose={() => setEditOpen(false)} />

      <CreatePlaylistModal
        open={!isGuest && modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(p) => {
          setMyPlaylists((prev) => [p, ...prev]);
          setModalOpen(false);
          (async () => {
            try {
              const r = await listMyPlaylists();
              setMyPlaylists(r.items || []);
            } catch { }
          })();
        }}
      />
      <EditPlaylistModal
        open={!isGuest && Boolean(editPlaylistTarget)}
        playlist={editPlaylistTarget}
        onClose={() => setEditPlaylistTarget(null)}
        onUpdated={(updated) => {
          setEditPlaylistTarget(null);
          setMyPlaylists((prev) =>
            prev.map((pl) =>
              String(pl.id) === String(updated.id)
                ? { ...pl, ...updated }
                : pl
            )
          );
          (async () => {
            try {
              const r = await listMyPlaylists();
              setMyPlaylists(r.items || []);
            } catch { }
          })();
        }}
      />
    </div>
  );
}