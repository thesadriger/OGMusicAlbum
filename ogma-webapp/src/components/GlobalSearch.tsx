// src/components/GlobalSearch.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, ApiError } from "@/lib/api";
import type { Track } from "@/types/types";
import SearchResultItem from "@/components/search/SearchResultItem";
import { TrackCard } from "@/components/TrackCard";
import { useContentFilter, filterTracksUniqueByTitle } from "@/hooks/useContentFilter";
import { goPlaylistHandle } from "@/lib/router";

type SearchResp = { hits: Track[]; total?: number };
type MaybeCatalogResp = { items?: Track[]; total?: number };

type UniversalSearchResp = {
  query: string;
  term: string;
  tracks?: Track[];
  users?: any[];
  playlists?: {
    id: string | number;
    title: string;
    handle?: string | null;
    is_public?: boolean;
    isPrivate?: boolean; // на случай другого имени в модели
    coverUrl?: string | null;
    tracksCount?: number | null;
  }[];
  total?: number;
};

type PlaylistLite = {
  id: string;
  title: string;
  handle: string | null;
  is_public?: boolean;
  isPrivate?: boolean;
  coverUrl?: string | null;
  tracksCount?: number | null;
};

export default function GlobalSearch({
  nowId,
  paused,
  onToggleTrack,
}: {
  nowId: string | null;
  paused: boolean;
  onToggleTrack: (list: Track[], startIndex: number) => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(false);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [totalTracks, setTotalTracks] = useState<number | null>(null);

  const [playlists, setPlaylists] = useState<PlaylistLite[]>([]);

  const [contentFilterOn] = useContentFilter();
  const tracksShown = useMemo(
    () => (contentFilterOn ? filterTracksUniqueByTitle(tracks) : tracks),
    [tracks, contentFilterOn]
  );

  useEffect(() => {
    const s = q.trim();
    if (!s) {
      setTracks([]);
      setTotalTracks(null);
      setPlaylists([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        setLoading(true);

        const PAGE = 50;
        const MAX_PAGES = 20;

        let offset = 0;
        const accTracks: Track[] = [];
        let totalValue: number | null = null;

        for (let i = 0; i < MAX_PAGES; i++) {
          const params = new URLSearchParams({
            q: s,
            limit: String(PAGE),
            offset: String(offset),
          });

          let resp: SearchResp | UniversalSearchResp | MaybeCatalogResp;

          try {
            resp = await apiGet(`/search?${params.toString()}`, {
              timeoutMs: 20000,
            });
          } catch (e) {
            if (e instanceof ApiError && [404, 405, 410].includes(e.status)) {
              resp = await apiGet(`/catalog/search?${params.toString()}`, {
                timeoutMs: 20000,
              });
            } else {
              throw e;
            }
          }

          if (cancelled) return;

          // Треки
          const pageHits: Track[] = Array.isArray((resp as SearchResp)?.hits)
            ? (resp as SearchResp).hits
            : Array.isArray((resp as UniversalSearchResp)?.tracks)
              ? (resp as UniversalSearchResp).tracks!
              : Array.isArray((resp as MaybeCatalogResp)?.items)
                ? (resp as MaybeCatalogResp).items!
                : [];

          accTracks.push(...pageHits);

          // Плейлисты — собираем из секции playlists (hits/массив)
          if (i === 0) {
            const section: any = (resp as UniversalSearchResp)?.playlists ?? (resp as any)?.playlists;
            let raw: any[] = [];
            if (Array.isArray(section)) {
              raw = section;
            } else if (section && Array.isArray(section.hits)) {
              raw = section.hits;
            }

            const pls = raw
              .filter(Boolean)
              .map((p) => {
                const id = p.id ?? p.playlist_id ?? p.playlistId ?? p.uuid ?? null;
                const handle = p.handle ?? p.slug ?? null;
                return {
                  id: id != null ? String(id) : "",
                  title: p.title || p.name || "",
                  handle: handle ? String(handle).replace(/^@/, "") : null,
                  is_public: p.is_public ?? p.isPublic ?? p.public ?? (p.isPrivate === true ? false : undefined),
                  isPrivate: p.isPrivate ?? (p.is_public === false),
                  coverUrl: p.coverUrl ?? p.cover_url ?? null,
                  tracksCount:
                    p.tracksCount ??
                    p.tracks_count ??
                    p.itemsCount ??
                    p.item_count ??
                    p.count ??
                    null,
                } as PlaylistLite;
              })
              .filter((p) => p.id && p.title);

            setPlaylists(pls);
          }

          if (typeof (resp as any)?.total === "number") {
            totalValue = (resp as any).total;
          }

          offset += PAGE;

          const got = pageHits.length;
          if (got < PAGE) break;
          if (totalValue != null && accTracks.length >= totalValue) break;
        }

        if (!cancelled) {
          setTracks(accTracks);
          setTotalTracks(totalValue ?? accTracks.length);
        }
      })()
        .catch(() => {
          if (!cancelled) {
            setTracks([]);
            setTotalTracks(0);
            setPlaylists([]);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const s = q.trim();

  const openPublicPlaylist = (handle: string) => {
    const clean = handle.replace(/^@/, "");
    if (clean) {
      goPlaylistHandle(clean);
    }
  };

  return (
    <div className="space-y-3">
      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          if (s) window.location.hash = "/";
        }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQ("")}
          placeholder="Поиск по названию, артистам, @handle…"
          className={
            "w-full rounded-xl px-4 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 " +
            (q.trim().length > 0 ? "pr-11" : "pr-4")
          }
        />
        {q.trim().length > 0 && (
          <button
            type="button"
            onClick={() => setQ("")}
            aria-label="Очистить поиск"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 h-7 w-7 flex items-center justify-center rounded-full bg-transparent text-zinc-400 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ×
          </button>
        )}
      </form>

      <div className="text-sm text-zinc-500">
        {loading
          ? "Загружаем…"
          : s
            ? `Найдено треков: ${contentFilterOn ? tracksShown.length : totalTracks ?? tracks.length} • Плейлисты: ${playlists.length}`
            : null}
      </div>

      {/* Плейлисты */}
      {s && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-zinc-500 pl-1">
            Плейлисты
          </div>
          {playlists.length > 0 ? (
            <div className="space-y-2">
              {playlists.map((p) => (
                <SearchResultItem
                  key={`pl_${p.id}`}
                  kind="playlist"
                  data={p}
                  onOpen={openPublicPlaylist}
                />
              ))}
            </div>
          ) : (
            <div className="text-sm text-zinc-500 pl-1">Ничего не найдено.</div>
          )}
        </div>
      )}

      {/* Треки */}
      {s && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-zinc-500 pl-1">
            Треки
          </div>
          {tracksShown.length > 0 ? (
            <div className="space-y-3">
              {tracksShown.map((t, i) => (
                <TrackCard
                  key={t.id}
                  t={t}
                  isActive={nowId === t.id}
                  isPaused={paused}
                  onToggle={() => onToggleTrack(tracksShown, i)}
                />
              ))}
            </div>
          ) : (
            <div className="text-sm text-zinc-500 pl-1">Ничего не найдено.</div>
          )}
        </div>
      )}
    </div>
  );
}