// /src/pages/PlaylistPage.tsx
import { useEffect, useMemo, useState, useCallback } from "react";
import type { Track } from "@/types/types";
import { TrackCard } from "@/components/TrackCard";
import AnimatedList from "@/components/AnimatedList";
import { getPlaylist } from "@/lib/playlists";
import { useContentFilter, filterTracksUniqueByTitle } from "@/hooks/useContentFilter";
import {
  usePlayerStore,
  selectCurrentTrackId,
  selectIsPaused,
  selectExpandedTrackId,
} from "@/store/playerStore";
import { toggleTrack as toggleTrackController } from "@/lib/playerController";

export default function PlaylistPage({
  onBack,
  embedded = false,
  q = "",
  onRequestExpand,
  onCardElementChange,
}: {
  onBack: () => void;
  embedded?: boolean;
  q?: string;
  onRequestExpand?: (track: Track, rect: DOMRect) => void;
  onCardElementChange?: (trackId: string, el: HTMLDivElement | null) => void;
}) {
  const nowId = usePlayerStore(selectCurrentTrackId);
  const paused = usePlayerStore(selectIsPaused);
  const expandedTrackId = usePlayerStore(selectExpandedTrackId);
  const [list, setList] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  // выбранный артист (внутренняя «страница» в секции)
  const [pickedArtist, setPickedArtist] = useState<string | null>(null);

  const toggleFromList = useCallback((tracks: Track[], index: number) => {
    toggleTrackController(tracks, index, tracks[index]?.id);
  }, []);

  const refresh = () => {
    setLoading(true);
    try {
      setList(getPlaylist());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("ogma:playlist-change" as any, handler as any);
    return () => window.removeEventListener("ogma:playlist-change" as any, handler as any);
  }, []);

  const [contentFilterOn] = useContentFilter();

  // список для отображения (поиск + фильтр дублей)
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = !s
      ? list
      : list.filter((t) => {
          const hay =
            (t.title || "") +
            " " +
            (t.artists?.join(" ") || "") +
            " " +
            ((t as any).hashtags?.join(" ") || "");
          return hay.toLowerCase().includes(s);
        });
    return contentFilterOn ? filterTracksUniqueByTitle(base) : base;
  }, [list, q, contentFilterOn]);

  // артисты, присутствующие в плейлисте (по всему плейлисту, не по поиску)
  const artistsInPlaylist = useMemo(() => {
    const set = new Set<string>();
    for (const t of list) for (const a of t.artists ?? []) set.add(a);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [list]);

  // треки конкретного артиста из плейлиста (уважаем поиск/дедуп)
  const tracksOfPicked = useMemo(() => {
    if (!pickedArtist) return [];
    return filtered.filter((t) => (t.artists ?? []).includes(pickedArtist));
  }, [filtered, pickedArtist]);

  // Карточка-контейнер показываем только НЕ в embedded
  const containerClass = embedded
    ? "space-y-0"
    : "rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3 space-y-3";

  const listClass = embedded ? "flex flex-col gap-2" : "space-y-3";

  // ====== РЕНДЕР ======
  return (
    <section className={containerClass}>
      {!embedded && (
        <div className="flex items-center justify-between">
          <button
            onClick={onBack}
            className="px-3 py-1 rounded-lg text-xs bg-zinc-200 dark:bg-zinc-800 hover:opacity-90"
          >
            ← Назад
          </button>
          <div className="text-base font-semibold truncate">
            Мой плейлист
            {list.length > 0 && (
              <span className="ml-2 text-sm text-zinc-500">· {list.length}</span>
            )}
          </div>
          <div className="w-16" />
        </div>
      )}

      {loading && <div className="text-sm text-zinc-500">Загружаем…</div>}

      {!loading && list.length === 0 && (
        <div className="text-sm text-zinc-500">Плейлист пока пуст.</div>
      )}

      {!loading && list.length > 0 && filtered.length === 0 && q.trim() && (
        <div className="text-sm text-zinc-500">Ничего не найдено.</div>
      )}

      {/* ===== ВСТАВКИ ДЛЯ EMBEDDED: счётчик + артисты ===== */}
      {embedded && list.length > 0 && (
        <div className="mb-3 px-1">
          <div className="text-xs text-zinc-500">
            Всего треков: <span className="font-medium text-zinc-400">{list.length}</span>
            {q.trim() && (
              <span className="ml-2 text-zinc-500">
                (показано: {filtered.length})
              </span>
            )}
          </div>

          {/* Чипы артистов */}
          {artistsInPlaylist.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {artistsInPlaylist.map((name) => (
                <button
                  key={name}
                  onClick={() => setPickedArtist(name)}
                  className="px-3 py-1 rounded-xl bg-zinc-100/80 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-800 text-sm hover:opacity-95 active:opacity-90"
                  title={`Открыть треки ${name} из плейлиста`}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== ВНУТРЕННЯЯ «СТРАНИЦА» АРТИСТА (ТОЛЬКО ТРЕКИ ИЗ ПЛЕЙЛИСТА) ===== */}
      {embedded && pickedArtist && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setPickedArtist(null)}
              className="px-3 py-1 rounded-lg text-xs bg-zinc-200 dark:bg-zinc-800 hover:opacity-90"
            >
              ← Назад
            </button>
            <div className="text-base font-semibold truncate">
              {pickedArtist}
              {tracksOfPicked.length > 0 && (
                <span className="ml-2 text-sm text-zinc-500">· {tracksOfPicked.length}</span>
              )}
            </div>
            <div className="w-16" />
          </div>

          {tracksOfPicked.length === 0 && (
            <div className="text-sm text-zinc-500">Треков не найдено</div>
          )}

          {tracksOfPicked.length > 0 && (
            <AnimatedList
              items={tracksOfPicked.map((t, i) => ({
                key: t.id,
                content: (
                  <TrackCard
                    t={t}
                    isActive={nowId === t.id}
                    isPaused={paused}
                    onToggle={() => toggleFromList(tracksOfPicked, i)}
                    mode="playlist"
                    onRequestExpand={onRequestExpand}
                    hideDuringExpand={expandedTrackId === t.id}
                    onCardElementChange={onCardElementChange}
                  />
                ),
              }))}
              listClassName={listClass}
              scrollable={false}
              showGradients={false}
            />
          )}
        </div>
      )}

      {/* ===== ОБЫЧНЫЙ СПИСОК ТРЕКОВ ПЛЕЙЛИСТА ===== */}
      {!pickedArtist && !loading && filtered.length > 0 && (
        <AnimatedList
          items={filtered.map((t, i) => ({
            key: t.id,
            content: (
              <TrackCard
                t={t}
                isActive={nowId === t.id}
                isPaused={paused}
                onToggle={() => toggleFromList(filtered, i)}
                mode="playlist"
                onRequestExpand={onRequestExpand}
                hideDuringExpand={expandedTrackId === t.id}
                onCardElementChange={onCardElementChange}
              />
            ),
          }))}
          listClassName={listClass}
          scrollable={false}
          showGradients={false}
        />
      )}
    </section>
  );
}