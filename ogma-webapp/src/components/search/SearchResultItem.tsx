// src/components/search/SearchResultItem.tsx
import { memo } from "react";
import type { Track } from "@/types/types";

type PlaylistLite = {
  id: string;
  title: string;
  handle: string | null;
  is_public?: boolean;
  isPrivate?: boolean; // на случай, если бэкенд отдаёт это поле
  coverUrl?: string | null;
  tracksCount?: number | null;
};

type Props =
  | {
      kind: "track";
      data: Track;
      isActive: boolean;
      isPaused: boolean;
      onToggle: () => void;
    }
  | {
      kind: "playlist";
      data: PlaylistLite;
      onOpen: (handle: string) => void;
    };

function PlayIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4 fill-current"
      aria-hidden="true"
    >
      <path d="M4 3.5v13l12-6.5-12-6.5z" />
    </svg>
  );
}

function PlaylistIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 fill-current"
      aria-hidden="true"
    >
      <path d="M3 6h14v2H3V6zm0 5h14v2H3v-2zm0 5h10v2H3v-2zm16-7h2v10h-2V9zm-3 3h2v7h-2v-7z" />
    </svg>
  );
}

export default memo(function SearchResultItem(props: Props) {
  if (props.kind === "track") {
    const t = props.data;
    return (
      <div
        className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3"
        role="button"
        tabIndex={0}
        onClick={props.onToggle}
        onKeyDown={(e) => e.key === "Enter" && props.onToggle()}
      >
        <div className="flex items-center gap-3">
          <button
            aria-label="Play / Pause"
            className="h-8 w-8 rounded-full bg-zinc-200/80 dark:bg-zinc-800/80 flex items-center justify-center"
          >
            <PlayIcon />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{t.title}</div>
            <div className="text-xs text-zinc-500 truncate">
              {(t.artists || []).join(", ")}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // playlist
  const p = props.data;
  const closed = p.isPrivate === true || p.is_public === false;

  return (
    <div
      className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3"
    >
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-md bg-zinc-200/80 dark:bg-zinc-800/80 flex items-center justify-center">
          <PlaylistIcon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{p.title || "Без названия"}</div>
          <div className="text-xs text-zinc-500 truncate">{p.handle ? `@${p.handle.replace(/^@/, "")}` : "—"}</div>
        </div>
        <div className="flex items-center gap-2">
          {closed ? (
            <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-md bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200">
              закрыт
            </span>
          ) : (
            <button
              onClick={() => p.handle && props.onOpen(p.handle.replace(/^@/, ""))}
              className="text-xs px-3 py-1 rounded-md bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 hover:opacity-90"
            >
              Открыть
            </button>
          )}
        </div>
      </div>
    </div>
  );
});