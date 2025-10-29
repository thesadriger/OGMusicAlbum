//home/ogma/ogma/ogma-webapp/src/pages/ArtistPage.tsx

import { useEffect, useState, useMemo } from "react";
import type { Track } from "@/types/types";
import { fetchArtistTracks } from "@/lib/api";
import { TrackCard } from "@/components/TrackCard";
import AnimatedList from "@/components/AnimatedList";
import { useContentFilter, filterTracksUniqueByTitle } from "@/hooks/useContentFilter";
import { goArtist } from "@/lib/router";
import {
  usePlayerStore,
  selectCurrentTrackId,
  selectIsPaused,
  selectExpandedTrackId,
} from "@/store/playerStore";
import { toggleTrack as toggleTrackController } from "@/lib/playerController";

type Props = {
  artist: string;
  onBack: () => void;
  onRequestExpand?: (track: Track, rect: DOMRect) => void;
  onCardElementChange?: (trackId: string, el: HTMLDivElement | null) => void;
};

export default function ArtistPage({ artist, onBack, onRequestExpand, onCardElementChange }: Props) {
  const nowId = usePlayerStore(selectCurrentTrackId);
  const paused = usePlayerStore(selectIsPaused);
  const expandedTrackId = usePlayerStore(selectExpandedTrackId);
  const [loading, setLoading] = useState(false);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [enter, setEnter] = useState(false);
  // «соседние» артисты, пришедшие из плеера (кроме текущего artist)
  const [peers, setPeers] = useState<string[]>([]);
  const [contentFilterOn] = useContentFilter();
  const shown = useMemo(
    () => (contentFilterOn ? filterTracksUniqueByTitle(tracks) : tracks),
    [tracks, contentFilterOn]
  );

  useEffect(() => {
    // читаем список артистов текущего трека, который передали из плеера
    const arr = ((window as any).__ogmaArtistPeers || []) as string[];
    if (Array.isArray(arr) && arr.includes(artist)) {
      setPeers(arr.filter(a => a && a !== artist));
    } else {
      setPeers([]);
    }
  }, [artist]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    const t = setTimeout(() => setEnter(true), 0);
    return () => { clearTimeout(t); setEnter(false); };
  }, [artist]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchArtistTracks(artist, "OGMA_archive")
      .then((r) => !cancelled && setTracks(r.items ?? []))
      .catch(() => !cancelled && setTracks([]))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [artist]);

  return (
    <section
      className={
        "rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3 space-y-3 " +
        "transition-all duration-200 " +
        (enter ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1")
      }
    >
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="px-3 py-1 rounded-lg text-xs bg-zinc-200 dark:bg-zinc-800 hover:opacity-90"
        >
          ← Назад
        </button>
        <div className="text-base font-semibold truncate">
          {artist}
          {shown.length > 0 && (
            <span className="ml-2 text-sm text-zinc-500">· {shown.length}</span>
          )}
        </div>
        <div className="w-16" />
      </div>

      {/* Чипы остальных артистов, если пришли из плеера */}
      {peers.length > 0 && (
        <div className="mt-2 mb-5 flex flex-wrap gap-2">
          {peers.map((name) => (
            <button
              key={name}
              onClick={() => goArtist(name)}
              className="px-3 py-1 rounded-xl bg-zinc-100/80 dark:bg-zinc-800/60
                   border border-zinc-200 dark:border-zinc-800 text-sm
                   hover:opacity-95 active:opacity-90"
              title={`Открыть артиста ${name}`}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {loading && <div className="text-sm text-zinc-500">Загружаем треки…</div>}

      {!loading && tracks.length === 0 && (
        <div className="text-sm text-zinc-500">Треков не найдено</div>
      )}

      {!loading && shown.length > 0 && (
        <AnimatedList
          items={shown.map((t, i) => ({
            key: t.id,
            content: (
              <TrackCard
                t={t}
                isActive={nowId === t.id}
                isPaused={paused}
                onToggle={() => toggleTrackController(shown, i, t.id)}
                onRequestExpand={onRequestExpand}
                hideDuringExpand={expandedTrackId === t.id}
                onCardElementChange={onCardElementChange}
              />
            ),
          }))}
          listClassName="space-y-3"
          scrollable={false}
          showGradients={false}
        />
      )}
    </section>
  );
}