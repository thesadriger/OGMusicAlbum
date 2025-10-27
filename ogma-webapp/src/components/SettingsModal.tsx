// /home/ogma/ogma/ogma-webapp/src/components/SettingsModal.tsx
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

type Props = {
  open: boolean;
  onClose: () => void;
  onEditProfile: () => void;
  contentFilterOn: boolean;
  setContentFilterOn: (v: boolean) => void;
  visibleTracksCount: number;
  visibleTracksCountFiltered: number;
};

export default function SettingsModal({
  open,
  onClose,
  onEditProfile,
  contentFilterOn,
  setContentFilterOn,
  visibleTracksCount,
  visibleTracksCountFiltered,
}: Props) {
  const scrollWrapRef = useRef<HTMLDivElement>(null);

  // При открытии — скролл к началу
  useEffect(() => {
    if (!open) return;
    scrollWrapRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [open]);

  // Лочим скролл body + компенсация скроллбара
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

  // Закрытие по Esc
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

  const modal = (
    <div className="fixed inset-0 z-[9999]">
      {/* overlay */}
      <button
        onClick={onClose}
        aria-label="Закрыть"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />

      {/* центрирующий слой — как в EditProfileModal */}
      <div
        ref={scrollWrapRef}
        className="relative z-10 flex items-center justify-center min-h-screen min-h-[100svh] min-h-[100dvh] overflow-y-auto overscroll-contain p-4 sm:p-6"
        style={{
          paddingTop: "max(16px, env(safe-area-inset-top))",
          // учитываем нижнюю safe-area и высоту плеера (CSS-переменная)
          paddingBottom:
            "max(16px, calc(env(safe-area-inset-bottom) + var(--ogma-player-h, 0px)))",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 p-5 shadow-xl max-h-[90dvh] flex flex-col pointer-events-auto">
          {/* header */}
          <div className="flex items-center justify-between">
            <div id="settings-title" className="text-lg font-semibold text-white">
              Настройки
            </div>
            <button
              onClick={onClose}
              className="inline-flex text-white items-center justify-center w-8 h-8 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800"
              aria-label="Закрыть"
              title="Закрыть"
            >
              ×
            </button>
          </div>

          {/* content */}
          <div className="mt-3 space-y-2">
            {/* Редактировать профиль */}
            <button
              className="w-full flex items-center gap-3 rounded-xl p-4 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 text-left"
              onClick={() => {
                onClose();
                onEditProfile();
              }}
            >
              <span className="inline-flex text-white items-center justify-center w-9 h-9 rounded-full bg-zinc-200 dark:bg-zinc-800">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Z" stroke="currentColor" strokeWidth="1.6" />
                  <path d="m14.06 6.19 2.12-2.12a1.5 1.5 0 0 1 2.12 0l1.65 1.65a1.5 1.5 0 0 1 0 2.12L17.81 9.94" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              <div>
                <div className="font-medium text-white">Редактировать профиль</div>
                <div className="text-xs text-zinc-500">Имя, аватар, статус</div>
              </div>
            </button>

            {/* Переключатель фильтра контента */}
            <div
              className="rounded-xl p-4 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40 cursor-pointer transition"
              role="button"
              tabIndex={0}
              aria-pressed={contentFilterOn}
              aria-label="Фильтр контента"
              onClick={() => setContentFilterOn(!contentFilterOn)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setContentFilterOn(!contentFilterOn);
                }
              }}
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex text-white items-center justify-center w-9 h-9 rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <path d="M3 6h18M6 12h12M10 18h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </span>

                <div className="flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium text-white">Фильтр контента</div>
                    <button
                      role="switch"
                      aria-checked={contentFilterOn}
                      onClick={(e) => { e.stopPropagation(); setContentFilterOn(!contentFilterOn); }}
                      className={`relative w-12 h-7 rounded-full transition ${contentFilterOn ? "bg-blue-600" : "bg-zinc-600/70"}`}
                      title={contentFilterOn ? "Выключить" : "Включить"}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${contentFilterOn ? "translate-x-5" : ""}`} />
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Всего треков: {contentFilterOn ? visibleTracksCountFiltered : visibleTracksCount}
                  </div>
                </div>
              </div>
            </div>

            {/* FAQ */}
            <button
              className="w-full flex items-center gap-3 rounded-xl p-4 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 text-left"
              onClick={() => { alert("FAQ OGMusicAlbum (скоро)"); }}
            >
              <span className="inline-flex text-white items-center justify-center w-9 h-9 rounded-full bg-zinc-200 dark:bg-zinc-800">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <circle cx="12" cy="16.5" r="1" fill="currentColor" />
                </svg>
              </span>
              <div>
                <div className="font-medium text-white">Вопросы об OGMusicAlbum</div>
                <div className="text-xs text-zinc-500">Частые вопросы и ответы</div>
              </div>
            </button>

            {/* Возможности */}
            <button
              className="w-full flex items-center gap-3 rounded-xl p-4 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 text-left"
              onClick={() => { alert("Возможности OGMusicAlbum (скоро)"); }}
            >
              <span className="inline-flex text-white items-center justify-center w-9 h-9 rounded-full bg-zinc-200 dark:bg-zinc-800">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M9 18h6M10 21h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <path d="M17 10a5 5 0 1 0-10 0c0 2.4 1.6 3.6 2.5 4.5.7.7 1 1.1 1 1.5h3c0-.4.3-.8 1-1.5.9-.9 2.5-2.1 2.5-4.5Z" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              <div>
                <div className="font-medium text-white">Возможности OGMusicAlbum</div>
                <div className="text-xs text-zinc-500">Что уже умеет приложение</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // Рендер в <body>, чтобы трансформации родителей не ломали позиционирование
  return typeof window !== "undefined" ? createPortal(modal, document.body) : null;
}