import { useEffect, useMemo, useState } from "react";
import type { Track } from "@/types/types";
import { TrackCard } from "@/components/TrackCard";
import { getPublicPlaylistByHandle, getPublicPlaylistItemsByHandle } from "@/lib/playlists";
import { removeItemFromPublicPlaylistByHandle } from "@/lib/playlists";

export default function PublicPlaylistPage({
  handle,
  onBack,
  nowId,
  paused,
  onToggleTrack,
}: {
  handle: string;
  onBack: () => void;
  nowId: string | null;
  paused: boolean;
  onToggleTrack: (list: Track[], startIndex: number) => void;
}) {
  const [info, setInfo] = useState<any | null>(null);
  const [items, setItems] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        setLoading(true);
        const [p, li] = await Promise.all([
          getPublicPlaylistByHandle(handle),
          getPublicPlaylistItemsByHandle(handle, 200, 0),
        ]);
        if (!dead) {
          setInfo(p || null);
          setItems((li?.items as any[]) || []);
        }
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => { dead = true; };
  }, [handle]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return (items || []).filter(t => {
      const hay = (t.title || "") + " " + (t.artists?.join(" ") || "") + " " + ((t as any).hashtags?.join(" ") || "");
      return hay.toLowerCase().includes(s);
    });
  }, [q, items]);

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="px-3 py-1 rounded-lg text-xs bg-zinc-200 dark:bg-zinc-800 hover:opacity-90">
          ← Назад
        </button>
        <div className="text-base font-semibold truncate">
          {info?.title || `@${handle}`}
          {(() => {
            const c = typeof info?.item_count === "number" ? info.item_count : items.length;
            return c > 0 ? <span className="ml-2 text-sm text-zinc-500">· {c}</span> : null;
          })()}
        </div>
        <div className="w-16" />
      </div>

      <div className="px-1">
        <form className="relative" onSubmit={(e) => e.preventDefault()}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }}
            placeholder="Поиск в этом плейлисте"
            className="w-full rounded-xl px-4 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 pr-11"
          />
          {q.trim().length > 0 && (
            <button
              type="button"
              onClick={() => setQ("")}
              aria-label="Очистить"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 h-7 w-7 flex items-center justify-center rounded-full bg-transparent text-zinc-400 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              ×
            </button>
          )}
        </form>
      </div>

      {loading && <div className="text-sm text-zinc-500">Загружаем…</div>}
      {!loading && filtered.length === 0 && <div className="text-sm text-zinc-500">Пусто.</div>}

      {!loading && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((t, i) => (
            <TrackCard
              key={t.id}
              t={t}
              isActive={nowId === t.id}
              isPaused={paused}
              onToggle={() => onToggleTrack(filtered, i)}
              mode="playlist"
              onRemoveFromPublic={async (track) => {
                await removeItemFromPublicPlaylistByHandle(handle, track);
                setItems(prev => prev.filter(x => x.id !== track.id && (x as any).msgId !== (track as any).msgId));
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}