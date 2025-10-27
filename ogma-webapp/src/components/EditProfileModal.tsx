// /home/ogma/ogma/ogma-webapp/src/components/EditProfileModal.tsx
import React, { useEffect, useState, ComponentType, useRef } from "react";
import { createPortal } from "react-dom";

import { TrackCard } from "@/components/TrackCard";

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

type Props = { open: boolean; onClose: () => void };

const backgrounds = {
  LiquidChrome, Squares, LetterGlitch, Orb, Ballpit, Waves, Iridescence, Hyperspeed,
  Threads, DotGrid, RippleGrid, FaultyTerminal, Dither, Galaxy, PrismaticBurst,
  Lightning, Beams, GradientBlinds, Particles, Plasma, Aurora, PixelBlast, LightRays,
  Silk, DarkVeil, Prism, LiquidEther,
} as Record<string, ComponentType<any>>;

const BG_KEYS = Object.keys(backgrounds);

/* =================== App BG apply =================== */
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

/* ====== Серверные UI-настройки: загрузка/сохранение с fallback путями ====== */
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
      if (e?.status && e.status !== 404) { /* можно залогировать */ }
    }
  }
  return null;
}

async function saveUiPrefsToServer(prefs: UiPrefs): Promise<boolean> {
  const bodies = [
    JSON.stringify({ ui_prefs: prefs }),
    JSON.stringify(prefs),
  ];
  const paths = [
    { url: "/me/ui-prefs", method: "PUT" },
    { url: "/api/me/ui-prefs", method: "PUT" },
    { url: "/me/prefs/ui", method: "PUT" },
    { url: "/api/me/prefs/ui", method: "PUT" },
    { url: "/me/prefs", method: "PUT" },
    { url: "/api/me/prefs", method: "PUT" },
    { url: "/me/ui-prefs", method: "POST" },
    { url: "/api/me/ui-prefs", method: "POST" },
  ] as const;

  for (const p of paths) {
    for (const body of bodies) {
      try {
        const res = await fetch(p.url, {
          method: p.method,
          credentials: "include",
          headers: { "content-type": "application/json" },
          body,
        });
        if (res.ok) return true;
      } catch { }
    }
  }
  return false;
}

/* =================== Safe preview helpers =================== */
const UNSAFE_WEBGL = new Set<string>([""]); // замечены падения/потеря контекста

function RealBg({
  bgKey,
  live = false,
  className = "",
}: {
  bgKey: string;
  live?: boolean;
  className?: string;
}) {
  const Bg = backgrounds[bgKey];
  const useLive = live && !!Bg && !UNSAFE_WEBGL.has(bgKey);

  return (
    <>
      {useLive &&
        React.createElement(Bg, {
          className: `absolute inset-0 pointer-events-none ${className}`,
        })}
      {!useLive && (
        <div
          className="absolute inset-0 opacity-30 pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px)",
            backgroundSize: "36px 36px",
          }}
        />
      )}
      {useLive && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(120% 75% at 50% 0%, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 55%, rgba(0,0,0,.35) 100%)",
          }}
        />
      )}
    </>
  );
}

function PreviewArea({ bgKey }: { bgKey: string }) {
  return (
    <div className="relative h-40 sm:h-44 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
      <RealBg bgKey={bgKey || "preview"} live />
      <div className="absolute bottom-2 left-3 text-xs text-white/90 drop-shadow">
        Предпросмотр: {bgKey || "—"}
      </div>
    </div>
  );
}

/** Плитка выбора */
function BgTile({
  bgKey,
  isPendingSelected,
  isCurrentSelected,
  dimmed,
  onSelect,
  onConfirm,
  confirmed = false,
  installed = false,
}: {
  bgKey: string;
  isPendingSelected: boolean;
  isCurrentSelected: boolean;
  dimmed: boolean;
  onSelect: () => void;
  onConfirm?: () => void;
  confirmed?: boolean;
  installed?: boolean;
}) {
  const selectedForConfirm = isPendingSelected;
  const showOverlay = selectedForConfirm || installed;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      title={bgKey}
      className={`relative h-24 sm:h-28 rounded-xl border overflow-hidden transition cursor-pointer ${isPendingSelected || isCurrentSelected
        ? "ring-2 ring-blue-500 border-blue-500"
        : "border-zinc-200 dark:border-zinc-800 hover:scale-[1.01]"
        }`}
    >
      <RealBg bgKey={bgKey} live={selectedForConfirm || installed} />
      <div className="absolute bottom-1 left-1 right-1 text-[10px] text-white/90 drop-shadow text-center">
        {bgKey}
      </div>

      {dimmed && <div className="absolute inset-0 bg-black/50 pointer-events-none" />}

      {showOverlay && (
        <div className="absolute inset-0 grid place-items-center">
          <button
            type="button"
            disabled={confirmed || installed}
            onClick={(e) => {
              e.stopPropagation();
              if (confirmed || installed) return;
              if (onConfirm) onConfirm();
            }}
            className={`px-3 py-1.5 rounded-lg text-white text-xs shadow-md ${confirmed || installed ? "bg-zinc-500/70 cursor-default" : "bg-[#5db5f7]/80 active:scale-95"
              }`}
          >
            {confirmed || installed ? "Установлено" : "Подтвердить"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function EditProfileModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<"cover" | "app" | "tracks">("cover");

  const scrollWrapRef = useRef<HTMLDivElement>(null);

  // при каждом открытии прокручиваем контейнер к началу
  useEffect(() => {
    if (!open) return;
    scrollWrapRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [open]);

  // cover
  const [coverKey, setCoverKey] = useState<string>(
    () => localStorage.getItem("ogma_profile_header_bg_key") || ""
  );
  const [pendingCoverKey, setPendingCoverKey] = useState<string | null>(null);
  const [justConfirmedCoverKey, setJustConfirmedCoverKey] = useState<string | null>(null);

  // app bg
  const [appType, setAppType] = useState<"color" | "image">(
    () => (localStorage.getItem("ogma_app_bg_type") as any) || "color"
  );
  const [appColor, setAppColor] = useState<string>(
    () => localStorage.getItem("ogma_app_bg_color") || "#0b1020"
  );
  const [appImage, setAppImage] = useState<string>(
    () => localStorage.getItem("ogma_app_bg_image") || ""
  );

  // tracks bg
  const [trackMode, setTrackMode] = useState<"random" | "fixed">(
    () => (localStorage.getItem("ogma_track_bg_mode") as any) || "random"
  );
  const [trackKey, setTrackKey] = useState<string>(
    () => localStorage.getItem("ogma_track_bg_key") || ""
  );
  const [pendingTrackKey, setPendingTrackKey] = useState<string | null>(null);
  const [justConfirmedTrackKey, setJustConfirmedTrackKey] = useState<string | null>(null);

  // Дебаунс-таймер для сохранения настроек.
  const saveTimer = useRef<number | null>(null);

  // (не обязательно, но аккуратно) чистим таймер при размонтаже
  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  /* ====== загрузка prefs при открытии модалки (из сервера, слияние в LS) ====== */
  useEffect(() => {
    if (!open) return;
    let dead = false;
    (async () => {
      try {
        const prefs = await loadUiPrefsFromServer();
        if (dead || !prefs) return;
        if (prefs.headerBgKey != null) {
          try { localStorage.setItem("ogma_profile_header_bg_key", prefs.headerBgKey || ""); } catch { }
          setCoverKey(prefs.headerBgKey || "");
        }
        if (prefs.trackBgMode) {
          try { localStorage.setItem("ogma_track_bg_mode", prefs.trackBgMode); } catch { }
          setTrackMode(prefs.trackBgMode);
        }
        if (prefs.trackBgKey != null) {
          try { localStorage.setItem("ogma_track_bg_key", prefs.trackBgKey || ""); } catch { }
          setTrackKey(prefs.trackBgKey || "");
        }
        if (prefs.appBg?.type) {
          try {
            localStorage.setItem("ogma_app_bg_type", prefs.appBg.type);
            if (prefs.appBg.type === "color" && prefs.appBg.color) {
              localStorage.setItem("ogma_app_bg_color", prefs.appBg.color);
              setAppColor(prefs.appBg.color);
            }
            setAppType(prefs.appBg.type);
          } catch { }
          applyAppBackgroundFromStorage();
        }
      } catch { }
    })();
    return () => { dead = true; };
  }, [open]);

  // сброс локальных pending-состояний при открытии
  useEffect(() => {
    if (open) {
      setTab("cover");
      setPendingCoverKey(null);
      setPendingTrackKey(null);
      setJustConfirmedCoverKey(null);
      setJustConfirmedTrackKey(null);
      setCoverKey(localStorage.getItem("ogma_profile_header_bg_key") || "");
    }
  }, [open]);

  // 🔒 Лочим скролл фона на время показа модалки (и компенсируем ширину скроллбара)
  useEffect(() => {
    if (!open) return;
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPr = body.style.paddingRight;
    const scrollBarWidth = window.innerWidth - documentElement.clientWidth;

    body.style.overflow = "hidden";
    if (scrollBarWidth > 0) body.style.paddingRight = `${scrollBarWidth}px`;

    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPr;
    };
  }, [open]);

  // ⎋ Закрытие по Esc
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  /* ====== дебаунс-сохранение настроек на сервер ====== */
  const scheduleSavePrefs = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const payload: UiPrefs = {
      headerBgKey: localStorage.getItem("ogma_profile_header_bg_key") || "",
      trackBgMode: (localStorage.getItem("ogma_track_bg_mode") as any) || "random",
      trackBgKey: localStorage.getItem("ogma_track_bg_key") || "",
      appBg: {
        type: (localStorage.getItem("ogma_app_bg_type") as any) || "color",
        color: localStorage.getItem("ogma_app_bg_color") || "#0b1020",
      },
    };
    saveTimer.current = window.setTimeout(async () => {
      try { await saveUiPrefsToServer(payload); } catch { }
      window.dispatchEvent(new Event("ogma:theme-changed"));
    }, 350) as any;
  };

  const saveCover = (key: string) => {
    setCoverKey(key);
    try { localStorage.setItem("ogma_profile_header_bg_key", key); } catch { }
    window.dispatchEvent(new Event("ogma:theme-changed"));
    scheduleSavePrefs();
  };

  const saveAppColor = (color: string) => {
    setAppType("color");
    setAppColor(color);
    try {
      localStorage.setItem("ogma_app_bg_type", "color");
      localStorage.setItem("ogma_app_bg_color", color);
    } catch { }
    applyAppBackgroundFromStorage();
    scheduleSavePrefs();
  };

  const saveAppImage = (data: string) => {
    setAppType("image");
    setAppImage(data);
    try {
      localStorage.setItem("ogma_app_bg_type", "image");
      localStorage.setItem("ogma_app_bg_image", data);
    } catch { }
    applyAppBackgroundFromStorage();
    // image не шлём на сервер
  };

  const clearAppImage = () => {
    setAppImage("");
    setAppType("color");
    try {
      localStorage.removeItem("ogma_app_bg_image");
      localStorage.setItem("ogma_app_bg_type", "color");
    } catch { }
    applyAppBackgroundFromStorage();
    scheduleSavePrefs();
  };

  const saveTrackMode = (mode: "random" | "fixed") => {
    setTrackMode(mode);
    try { localStorage.setItem("ogma_track_bg_mode", mode); } catch { }
    window.dispatchEvent(new Event("ogma:theme-changed"));
    scheduleSavePrefs();
  };
  const saveTrackKey = (key: string) => {
    setTrackKey(key);
    try { localStorage.setItem("ogma_track_bg_key", key); } catch { }
    window.dispatchEvent(new Event("ogma:theme-changed"));
    scheduleSavePrefs();
  };

  /** подтвердить выбор обложки */
  const confirmPendingCover = () => {
    if (!pendingCoverKey) return;
    saveCover(pendingCoverKey);
    setJustConfirmedCoverKey(pendingCoverKey);
  };

  /** подтвердить выбор фона треков */
  const confirmPendingTrack = () => {
    if (!pendingTrackKey) return;
    saveTrackKey(pendingTrackKey);
    setJustConfirmedTrackKey(pendingTrackKey);
  };

  const previewKey = pendingCoverKey ?? coverKey;
  const previewTrackKey = pendingTrackKey ?? trackKey;

  const modal = (
    <div className="fixed inset-0 z-[9999]"> {/* было z-[200] */}
      {/* overlay */}
      <button
        onClick={onClose}
        aria-label="Закрыть"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />

      {/* центрирующий слой */}
      <div
        ref={scrollWrapRef}  // ← ВАЖНО
        className="relative z-10 flex items-center justify-center min-h-screen min-h-[100svh] min-h-[100dvh] overflow-y-auto overscroll-contain p-4 sm:p-6"
        style={{
          paddingTop: "max(16px, env(safe-area-inset-top))",
          paddingBottom: "max(16px, calc(env(safe-area-inset-bottom) + var(--ogma-player-h, 0px)))",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-profile-title"
      >
        {/* modal */}
        <div className="w-full max-w-2xl rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 shadow-xl max-h-[90dvh] flex flex-col pointer-events-auto">
          {/* header */}
          <div className="px-5 pt-5 pb-3 flex items-center justify-between shrink-0">
            <div id="edit-profile-title" className="text-lg font-semibold text-white">
              Редактировать профиль
            </div>
            <button
              className="w-8 h-8 text-white rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onClick={onClose}
            >
              ×
            </button>
          </div>

          {/* tabs */}
          <div className="px-5 text-white pb-4 shrink-0 flex gap-2">
            {[
              { id: "cover", label: "Обложка профиля" },
              { id: "app", label: "Фон приложения" },
              { id: "tracks", label: "Фон активных треков" },
            ].map((x) => (
              <button
                key={x.id}
                onClick={() => setTab(x.id as any)}
                className={`px-3 text-white py-2 rounded-xl text-sm border transition ${tab === x.id
                  ? "bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700"
                  : "border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40"
                  }`}
              >
                {x.label}
              </button>
            ))}
          </div>

          {/* предпросмотр — cover */}
          {tab === "cover" && (
            <div className="px-5 pb-3 shrink-0">
              <PreviewArea bgKey={previewKey || "—"} />
            </div>
          )}

          {/* предпросмотр — карточка трека */}
          {tab === "tracks" && (
            <div className="px-5 pb-3 shrink-0">
              <TracksPreviewArea
                trackMode={trackMode}
                trackKey={previewTrackKey}
                pendingTrackKey={pendingTrackKey}
              />
            </div>
          )}

          {/* scrollable content */}
          <div className="px-5 pb-5 overflow-y-auto">
            {tab === "cover" && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-[52vh] overflow-auto pr-1 pt-2">
                {BG_KEYS.map((key) => {
                  const isPendingSelected = pendingCoverKey === key;
                  const isCurrentSelected = !pendingCoverKey && coverKey === key;
                  const dimOthers = pendingCoverKey != null && !isPendingSelected;
                  return (
                    <BgTile
                      key={key}
                      bgKey={key}
                      isPendingSelected={!!isPendingSelected}
                      isCurrentSelected={!!isCurrentSelected}
                      dimmed={dimOthers}
                      confirmed={isPendingSelected && justConfirmedCoverKey === key}
                      installed={coverKey === key && (pendingCoverKey == null || pendingCoverKey === key)}
                      onSelect={() => {
                        setPendingCoverKey(key);
                        setJustConfirmedCoverKey(null);
                      }}
                      onConfirm={isPendingSelected ? confirmPendingCover : undefined}
                    />
                  );
                })}
              </div>
            )}

            {tab === "app" && (
              <AppBackgroundTab
                appType={appType}
                setAppType={setAppType}
                appColor={appColor}
                setAppColor={saveAppColor}
                appImage={appImage}
                saveAppImage={saveAppImage}
                clearAppImage={clearAppImage}
              />
            )}

            {tab === "tracks" && (
              <TracksBackgroundTab
                trackMode={trackMode}
                setTrackMode={(m) => {
                  setPendingTrackKey(null);
                  setJustConfirmedTrackKey(null);
                  saveTrackMode(m);
                }}
                trackKey={trackKey}
                setTrackKey={saveTrackKey}
                pendingTrackKey={pendingTrackKey}
                setPendingTrackKey={(k) => {
                  setPendingTrackKey(k);
                  setJustConfirmedTrackKey(null);
                }}
                confirmPendingTrack={confirmPendingTrack}
                justConfirmedTrackKey={justConfirmedTrackKey}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // Рендерим В ТЕЛО ДОКУМЕНТА, чтобы не влияли transform/overflow родителей
  return typeof window !== "undefined" ? createPortal(modal, document.body) : null;
}

/* ===== остальные вкладки ===== */

const PRESET_COLORS = [
  "#0b1020", "#0f172a", "#111827", "#1f2937", "#0a0a0a", "#101010",
  "#111111", "#171717", "#000000", "#1b2333", "#13122b", "#222222",
];

function AppBackgroundTab({
  appType,
  setAppType,
  appColor,
  setAppColor,
  appImage,
  saveAppImage,
  clearAppImage,
}: {
  appType: "color" | "image";
  setAppType: (t: "color" | "image") => void;
  appColor: string;
  setAppColor: (c: string) => void;
  appImage: string;
  saveAppImage: (data: string) => void;
  clearAppImage: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="font-medium text-white">Тип фона:</span>
        <button
          className={`px-3 py-1.5 rounded-lg border ${appType === "color"
            ? "bg-zinc-100 text-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700"
            : "border-zinc-200 dark:border-zinc-800"
            }`}
          onClick={() => {
            setAppType("color");
            localStorage.setItem("ogma_app_bg_type", "color");
            applyAppBackgroundFromStorage();
          }}
        >
          Цвет
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg border ${appType === "image"
            ? "bg-zinc-100 text-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700"
            : "border-zinc-200 dark:border-zinc-800"
            }`}
          onClick={() => {
            setAppType("image");
            localStorage.setItem("ogma_app_bg_type", "image");
            applyAppBackgroundFromStorage();
          }}
        >
          Картинка
        </button>
      </div>

      {appType === "color" && (
        <>
          <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                className={`h-10 rounded-lg border ${appColor === c ? "ring-2 ring-blue-500 border-blue-500" : "border-zinc-300 dark:border-zinc-700"
                  }`}
                style={{ background: c }}
                onClick={() => setAppColor(c)}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={appColor}
              onChange={(e) => setAppColor(e.target.value)}
            />
            <span className="text-xs text-zinc-500 text-white">Своя HEX</span>
          </div>
        </>
      )}

      {appType === "image" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === "string") saveAppImage(reader.result);
                };
                reader.readAsDataURL(f);
              }}
            />
            {appImage && (
              <button
                className="text-sm text-white px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                onClick={clearAppImage}
              >
                Удалить картинку
              </button>
            )}
          </div>
          {appImage && (
            <div className="rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
              <img src={appImage} alt="prev" className="w-full max-h-56 object-cover" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TracksPreviewArea({
  trackMode,
  trackKey,
  pendingTrackKey,
}: {
  trackMode: "random" | "fixed";
  trackKey: string;
  pendingTrackKey: string | null;
}) {
  const effectiveKey = pendingTrackKey ?? trackKey;

  const demoTrack: any = {
    id: `preview-${trackMode}-${effectiveKey || "rand"}`,
    title: "Чумбулум",
    artists: ["Пумпум"],
    hashtags: ["#preview", "#OGMusicAlbum"],
  };

  return (
    <div className="relative">
      <div className="pointer-events-none">
        <TrackCard
          t={demoTrack}
          isActive
          onToggle={() => { }}
          forceBgMode={trackMode}
          forceBgKey={effectiveKey}
        />
      </div>
    </div>
  );
}

function TracksBackgroundTab({
  trackMode,
  setTrackMode,
  trackKey,
  setTrackKey,
  pendingTrackKey,
  setPendingTrackKey,
  confirmPendingTrack,
  justConfirmedTrackKey,
}: {
  trackMode: "random" | "fixed";
  setTrackMode: (m: "random" | "fixed") => void;
  trackKey: string;
  setTrackKey: (k: string) => void;

  pendingTrackKey: string | null;
  setPendingTrackKey: (k: string | null) => void;
  confirmPendingTrack: () => void;
  justConfirmedTrackKey: string | null;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-medium text-white">Режим:</span>
        <button
          className={`px-3 py-1.5 rounded-lg border ${trackMode === "random"
            ? "bg-zinc-100 text-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700"
            : "border-zinc-200 dark:border-zinc-800"
            }`}
          onClick={() => {
            setPendingTrackKey(null);
            setTrackMode("random");
          }}
        >
          Рандом
        </button>
        <button
          className={`px-3 py-1.5 rounded-lg border ${trackMode === "fixed"
            ? "bg-zinc-100 text-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700"
            : "border-zinc-200 dark:border-zinc-800"
            }`}
          onClick={() => setTrackMode("fixed")}
        >
          Один фон
        </button>
      </div>

      {trackMode === "fixed" && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-[52vh] overflow-auto pr-1 pt-2">
          {BG_KEYS.map((key) => {
            const isPendingSelected = pendingTrackKey === key;
            const isCurrentSelected = !pendingTrackKey && trackKey === key;
            const dimOthers = pendingTrackKey != null && !isPendingSelected;

            return (
              <BgTile
                key={key}
                bgKey={key}
                isPendingSelected={!!isPendingSelected}
                isCurrentSelected={!!isCurrentSelected}
                dimmed={dimOthers}
                confirmed={isPendingSelected && justConfirmedTrackKey === key}
                installed={trackKey === key && (pendingTrackKey == null || pendingTrackKey === key)}
                onSelect={() => setPendingTrackKey(key)}
                onConfirm={isPendingSelected ? confirmPendingTrack : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}