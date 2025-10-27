import React from "react";
import { useMe } from "@/hooks/useMe";

export const ProfileModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onOpenPlaylist?: () => void;
  onOpenSettings?: () => void;
}> = ({ open, onClose, onOpenPlaylist, onOpenSettings }) => {
  const { me } = useMe();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* фон/оверлей */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* карточка */}
      <div className="absolute inset-x-4 top-8 bottom-8 md:inset-x-1/4 md:top-12 md:bottom-12 rounded-3xl overflow-hidden shadow-2xl ring-1 ring-black/10">
        {/* градиент шапки */}
        <div className="relative h-48 sm:h-56"
             style={{ background: "linear-gradient(160deg,#3b82f6 0%,#06b6d4 50%,#8b5cf6 100%)" }}>
          <button
            onClick={onClose}
            className="absolute right-3 top-3 px-3 py-1.5 rounded-full bg-black/20 text-white text-sm hover:bg-black/30"
          >
            Закрыть
          </button>

          {/* большая аватарка */}
          <div className="absolute left-1/2 -bottom-12 -translate-x-1/2 w-24 h-24 rounded-full ring-4 ring-zinc-900/20 overflow-hidden bg-white">
            {me?.photo_url ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <img src={me.photo_url} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xl font-bold text-zinc-600">U</div>
            )}
          </div>
        </div>

        {/* контент */}
        <div className="h-[calc(100%-12rem)] sm:h-[calc(100%-14rem)] bg-white dark:bg-zinc-950 p-5 pt-16 text-center">
          <div className="text-2xl font-bold">{me?.name || me?.username || `id${me?.telegram_id}`}</div>
          {me?.username && (
            <div className="text-zinc-500 mt-1">@{me.username}</div>
          )}

          <div className="mt-6 grid gap-3 max-w-xs mx-auto">
            <button
              className="w-full px-4 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-sm"
              onClick={() => (onOpenPlaylist ? onOpenPlaylist() : alert("Мой плейлист (скоро)"))}
            >
              Мой плейлист
            </button>
            <button
              className="w-full px-4 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-sm"
              onClick={() => (onOpenSettings ? onOpenSettings() : alert("Настройки (скоро)"))}
            >
              Настройки
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};