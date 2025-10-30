// src/components/GlobalSearch.tsx
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { apiGet, ApiError } from "@/lib/api";
import type { Track } from "@/types/types";
import SearchResultItem from "@/components/search/SearchResultItem";
import { TrackCard } from "@/components/TrackCard";
import AnimatedList from "@/components/AnimatedList";
import { useContentFilter, filterTracksUniqueByTitle } from "@/hooks/useContentFilter";
import { goPlaylistHandle } from "@/lib/router";
import {
  usePlayerStore,
  selectCurrentTrackId,
  selectIsPaused,
  selectExpandedTrackId,
} from "@/store/playerStore";
import { toggleTrack as toggleTrackController } from "@/lib/playerController";
import { setLastSearchQuery } from "@/store/searchStore";

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
  onRequestExpand,
  onCardElementChange,
  standalone = true,
  initialQuery = "",
  onQueryChange,
  onNavigateToSearch,
  autoFocus = false,
}: {
  onRequestExpand?: (track: Track, rect: DOMRect) => void;
  onCardElementChange?: (trackId: string, el: HTMLDivElement | null) => void;
  standalone?: boolean;
  initialQuery?: string;
  onQueryChange?: (value: string) => void;
  onNavigateToSearch?: (query: string) => void;
  autoFocus?: boolean;
}) {
  const nowId = usePlayerStore(selectCurrentTrackId);
  const paused = usePlayerStore(selectIsPaused);
  const expandedTrackId = usePlayerStore(selectExpandedTrackId);
  const [q, setQ] = useState(initialQuery);
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
    setQ(initialQuery);
    setLastSearchQuery(initialQuery);
  }, [initialQuery]);

  const updateQuery = useCallback(
    (value: string) => {
      setQ(value);
      setLastSearchQuery(value);
      onQueryChange?.(value);
    },
    [onQueryChange]
  );

  useEffect(() => {
    if (!autoFocus) return;
    if (typeof window === "undefined") return;
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      const caretPos = input.value.length;
      try {
        input.setSelectionRange(caretPos, caretPos);
      } catch {
        // ignore selection errors on unsupported inputs
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  useEffect(() => {
    const s = q.trim();
    if (!s) {
      setTracks([]);
      setTotalTracks(null);
      setPlaylists([]);
      setLoading(false);
      return;
    }

    if (!standalone) {
      setTracks([]);
      setTotalTracks(null);
      setPlaylists([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        setLoading(true);

        const PAGE = 50;
        const MAX_PAGES = 20;
        const UNIVERSAL_LIMIT = 16;

        const normalizePlaylist = (p: any): PlaylistLite | null => {
          if (!p) return null;
          const id = p.id ?? p.playlist_id ?? p.playlistId ?? p.uuid ?? null;
          const handle = p.handle ?? p.slug ?? null;
          const title = p.title ?? p.name ?? "";
          if (!title) return null;
          const normalized: PlaylistLite = {
            id: id != null ? String(id) : "",
            title,
            handle: handle ? String(handle).replace(/^@/, "") : null,
            is_public:
              p.is_public ??
              p.isPublic ??
              p.public ??
              (p.isPrivate === true ? false : undefined),
            isPrivate: p.isPrivate ?? (p.is_public === false),
            coverUrl: p.coverUrl ?? p.cover_url ?? null,
            tracksCount:
              p.tracksCount ??
              p.tracks_count ??
              p.itemsCount ??
              p.item_count ??
              p.count ??
              null,
          };
          return normalized.id || normalized.handle ? normalized : null;
        };

        let universalPlaylists: PlaylistLite[] | null = null;
        let fallbackPlaylists: PlaylistLite[] | null = null;
        let tracksAcc: Track[] = [];
        let totalValue: number | null = null;

        const fetchUniversal = async () => {
          try {
            const params = new URLSearchParams({
              q: s,
              limit: String(UNIVERSAL_LIMIT),
            });
            const data: any = await apiGet<any>(`/search/universal?${params.toString()}`, {
              timeoutMs: 15000,
            });
            if (cancelled) return;

            const rawSection: any = data?.playlists ?? [];
            const rawList: any[] = Array.isArray(rawSection)
              ? rawSection
              : Array.isArray(rawSection?.items)
                ? rawSection.items
                : Array.isArray(rawSection?.hits)
                  ? rawSection.hits
                  : [];

            const collected: PlaylistLite[] = [];
            const push = (candidate: any) => {
              const pl = normalizePlaylist(candidate);
              if (pl) collected.push(pl);
            };

            if (data?.primary?.kind === "playlist") {
              push(data.primary.data);
            }
            rawList.forEach(push);

            const dedup: PlaylistLite[] = [];
            const seen = new Set<string>();
            for (const item of collected) {
              const key = `${item.id}::${item.handle ?? ""}`.toLowerCase();
              if (seen.has(key)) continue;
              seen.add(key);
              dedup.push(item);
              if (dedup.length >= UNIVERSAL_LIMIT) break;
            }
            universalPlaylists = dedup;
          } catch (err) {
            if (err instanceof ApiError && [404, 405, 410].includes(err.status)) {
              universalPlaylists = null;
              return;
            }
            console.warn("[search] universal search failed", err);
            universalPlaylists = null;
          }
        };

        const fetchTracks = async () => {
          try {
            let offset = 0;
            const acc: Track[] = [];
            let total: number | null = null;
            let fallback: PlaylistLite[] | null = null;

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

              const pageHits: Track[] = Array.isArray((resp as SearchResp)?.hits)
                ? (resp as SearchResp).hits
                : Array.isArray((resp as UniversalSearchResp)?.tracks)
                  ? (resp as UniversalSearchResp).tracks!
                  : Array.isArray((resp as MaybeCatalogResp)?.items)
                    ? (resp as MaybeCatalogResp).items!
                    : [];

              acc.push(...pageHits);

              if (i === 0) {
                const section: any =
                  (resp as UniversalSearchResp)?.playlists ?? (resp as any)?.playlists;
                const rawList: any[] = Array.isArray(section)
                  ? section
                  : Array.isArray(section?.hits)
                    ? section.hits
                    : Array.isArray(section?.items)
                      ? section.items
                      : [];
                const mapped = rawList
                  .map(normalizePlaylist)
                  .filter(Boolean) as PlaylistLite[];
                fallback = mapped;
              }

              if (typeof (resp as any)?.total === "number") {
                total = (resp as any).total;
              } else if (typeof (resp as any)?.estimatedTotalHits === "number") {
                total = (resp as any).estimatedTotalHits;
              }

              offset += PAGE;

              if (pageHits.length < PAGE) break;
              if (total != null && acc.length >= total) break;
            }

            tracksAcc = acc;
            totalValue = total ?? acc.length;
            fallbackPlaylists = fallback;
          } catch (err) {
            console.warn("[search] track search failed", err);
            tracksAcc = [];
            totalValue = 0;
            fallbackPlaylists = null;
          }
        };

        await Promise.allSettled([fetchUniversal(), fetchTracks()]);

        if (cancelled) return;

        setTracks(tracksAcc);
        setTotalTracks(totalValue ?? tracksAcc.length);

        const finalPlaylists: PlaylistLite[] = [];
        const seen = new Set<string>();
        const pushList = (list?: PlaylistLite[] | null) => {
          if (!Array.isArray(list)) return;
          for (const pl of list) {
            if (!pl) continue;
            const key = `${pl.id}::${pl.handle ?? ""}`.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            finalPlaylists.push(pl);
          }
        };

        pushList(universalPlaylists);
        pushList(fallbackPlaylists);

        setPlaylists(finalPlaylists);
      })()
        .catch((err) => {
          if (!cancelled) {
            console.warn("[search] query failed", err);
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
  }, [q, standalone]);

  useEffect(() => {
    if (standalone) return;
    const trimmed = q.trim();
    if (!trimmed) return;
    onNavigateToSearch?.(trimmed);
  }, [standalone, q, onNavigateToSearch]);

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
          if (!s) {
            updateQuery("");
            return;
          }
          onNavigateToSearch?.(s);
        }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => updateQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && updateQuery("")}
          placeholder="Поиск по названию, артистам, @handle…"
          className={
            "w-full rounded-xl px-4 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 " +
            (q.trim().length > 0 ? "pr-11" : "pr-4")
          }
        />
        {q.trim().length > 0 && (
          <button
            type="button"
            onClick={() => updateQuery("")}
            aria-label="Очистить поиск"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 h-7 w-7 flex items-center justify-center rounded-full bg-transparent text-zinc-400 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ×
          </button>
        )}
      </form>

      {standalone && (
        <div className="text-sm text-zinc-500">
          {loading
            ? "Загружаем…"
            : s
              ? `Найдено треков: ${contentFilterOn ? tracksShown.length : totalTracks ?? tracks.length} • Плейлисты: ${playlists.length}`
              : null}
        </div>
      )}

      {standalone && s && (
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

      {standalone && s && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-zinc-500 pl-1">
            Треки
          </div>
          {tracksShown.length > 0 ? (
            <AnimatedList
              items={tracksShown.map((t, i) => ({
                key: t.id,
                content: (
                  <TrackCard
                    t={t}
                    isActive={nowId === t.id}
                    isPaused={paused}
                    onToggle={() => toggleTrackController(tracksShown, i)}
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
          ) : (
            <div className="text-sm text-zinc-500 pl-1">Ничего не найдено.</div>
          )}
        </div>
      )}
    </div>
  );
}