// /home/ogma/ogma/ogma-webapp/src/App.tsx
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { apiGet } from "@/lib/api";
import {
  listMyPlaylists,
  addItemToPlaylist,
  addToPlaylist as addToLocal,
  openMyPlaylistEventSource,
  syncPlaylistWithServer,
  addItemToMyPersonalPlaylist,
} from "@/lib/playlists";
import type { Track } from "@/types/types";
import UserAvatar from "@/components/UserAvatar";
import { AuthGate } from "@/components/AuthGate";
import ArtistPage from "@/pages/ArtistPage";
import {
  useHashRoute,
  goArtist,
  goBackSmart,
  Route,
  goPlaylist,
} from "@/lib/router";
import ArtistsListPage from "@/pages/ArtistsListPage";
import PlaylistPage from "@/pages/PlaylistPage";
import GlobalAudioPlayer from "@/components/GlobalAudioPlayer";
import ProfilePage from "@/pages/Profile";
import PublicPlaylistPage from "@/pages/PublicPlaylistPage";
import { useMe } from "@/hooks/useMe";
import TracksCarousel from "@/components/TracksCarousel";
import AddToPlaylistPopover from "@/components/AddToPlaylistPopover";
import GlobalSearch from "@/components/GlobalSearch";
import ShinyText from "@/components/ShinyText";
import ExpandedPlayerOverlay from "@/components/ExpandedPlayerOverlay";
import {
  playList as playListController,
  nextTrack,
  prevTrack,
  requestExpand as requestExpandController,
  requestOverlayClose as requestOverlayCloseController,
  markOverlayOpened,
  markOverlayClosed,
  setPaused as setPausedController,
  setShuffle as setShuffleController,
  setPauseLock as setPauseLockController,
  getAudioElement,
} from "@/lib/playerController";
import {
  usePlayerStore,
  type RectLike,
  selectExpandedState,
  selectExpandedVisibleTrack,
  selectIsPaused,
  selectExpandedTrackId,
  selectShuffle,
} from "@/store/playerStore";

type RecsResp = { items: Track[]; limit: number };

// тип для поповера плейлистов
type PlaylistLite = {
  id: string;
  title: string;
  handle?: string | null;
  is_public?: boolean;
};

export default function App() {
  const route: Route = useHashRoute();

  // имя пользователя как в профиле: берём только первое слово
  const { me } = useMe();
  const rawName = (me?.name || me?.username || "").trim();
  const ownerLabel = (rawName.split(/\s+/)[0] || "").trim();
  const playlistTitle = ownerLabel ? `${ownerLabel}'s Album` : "Album";


  const [recs, setRecs] = useState<Track[]>([]);
  const recsShuffled = useMemo(() => {
    const a = [...recs];
    // Фишер-Йетс
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }, [recs]);

  const [loading, setLoading] = useState(false);

  const cardRegistryRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const registerCardElement = useCallback((trackId: string, el: HTMLDivElement | null) => {
    const map = cardRegistryRef.current;
    if (!trackId) return;
    if (!el) map.delete(trackId);
    else map.set(trackId, el);
  }, []);

  const measureCardRect = useCallback(
    (trackId: string): RectLike | null => {
      const el = cardRegistryRef.current.get(trackId);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    },
    []
  );

  const handleRequestExpand = useCallback(
    (track: Track, rect: DOMRect) => {
      requestExpandController(track, rect);
    },
    []
  );

  const togglePlayPauseExpanded = useCallback(() => {
    const audio = getAudioElement();
    if (!audio) return;
    if (audio.paused) {
      audio
        .play()
        .then(() => {
          setPausedController(false);
          setPauseLockController(false);
        })
        .catch(() => { });
    } else {
      audio.pause();
      setPausedController(true);
      setPauseLockController(true);
    }
  }, []);
  

  // === Add-to-Playlist popover — ВНУТРИ компонента ===
  const addBtnAnchorRef = useRef<HTMLElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addTrack, setAddTrack] = useState<Track | null>(null);
  const [publicPlaylists, setPublicPlaylists] = useState<PlaylistLite[]>([]);
  const [containsMap, setContainsMap] = useState<Record<string, boolean>>({});
  const [addDisabled, setAddDisabled] = useState(false);

  const resolveAddAnchor = useCallback(() => {
    const el =
      (document.getElementById("ogma-player-add-btn-expanded") as HTMLElement | null) ||
      (document.getElementById("ogma-player-add-btn") as HTMLElement | null) ||
      (document.querySelector(
        'button[aria-label="Добавить трек в плейлист"]'
      ) as HTMLElement | null);
    if (el) addBtnAnchorRef.current = el;
  }, []);

  type AddIntent = "default" | "plus";
  const [addIntent, setAddIntent] = useState<AddIntent>("default");

  const openAddPopover = useCallback(
    async (track: Track, intent: AddIntent = "default") => {
      setAddTrack(track);
      setAddIntent(intent);
      resolveAddAnchor();
      setAddOpen(true);

      setContainsMap({}); // сброс статуса "уже добавлено"

      try {
        // Единый стабильный эндпоинт бэка: /api/playlists
        const r = await listMyPlaylists(); // { items: Playlist[] }
        const pubs = (r?.items || [])
          .filter((p) => p.is_public)
          .map((p) => ({
            id: String(p.id),
            title: p.title,
            handle: p.handle ?? null,
            is_public: !!p.is_public,
          })) as PlaylistLite[];
        setPublicPlaylists(pubs);
      } catch {
        setPublicPlaylists([]);
      }
    },
    [resolveAddAnchor]
  );

  useEffect(() => {
    resolveAddAnchor();
  }, [resolveAddAnchor]);

  useEffect(() => {
    (window as any).__ogmaPlayList = (list: Track[], startIndex: number) => {
      playListController(list, startIndex);
    };
    return () => {
      delete (window as any).__ogmaPlayList;
    };
  }, []);

  useEffect(() => {
    try {
      (window as any)?.Telegram?.WebApp?.ready?.();
      (window as any)?.Telegram?.WebApp?.expand?.();
    } catch { }
  }, []);

  // Рекомендации
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<RecsResp>("/me/recs?limit=20", { timeoutMs: 20000 })
      .then((r) => {
        if (!cancelled) setRecs(r.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setRecs([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openArtist = (name: string) => goArtist(name);

  const [enter, setEnter] = useState(false);
  const enterKey = (() => {
    switch (route.name) {
      case "artist":
        return `artist:${(route as any).artist}`;
      case "artists":
        return `artists:${(route as any).which}`;
      case "playlist":
        return "playlist";
      case "publicPlaylist":
        return `public:${(route as any).handle}`;
      default:
        return String((route as any).name || "home");
    }
  })();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    const t = setTimeout(() => setEnter(true), 0);
    return () => {
      clearTimeout(t);
      setEnter(false);
    };
  }, [enterKey]);

  useEffect(() => {
    const handler = (e: any) => {
      const tr: Track | null = e?.detail?.track || null;
      if (tr) openAddPopover(tr, "default");
    };
    window.addEventListener("ogma:add-to-playlist", handler as any);
    return () =>
      window.removeEventListener("ogma:add-to-playlist", handler as any);
  }, [openAddPopover]);

  // ===== Реалтайм синхронизация личного плейлиста (SSE) =====
  useEffect(() => {
    // запускаем только когда есть me (авторизованы)
    if (!me) return;
    let es: EventSource | null = null;

    (async () => {
      try {
        // начальный sync + миграция при первом запуске
        await syncPlaylistWithServer();
      } catch { }

      es = openMyPlaylistEventSource(async (kind) => {
        // любое событие — синхронизируем
        try {
          await syncPlaylistWithServer();
        } catch { }
      });
    })();

    return () => {
      try {
        es?.close();
      } catch { }
    };
  }, [me?.telegram_id]);

  const isProfile = route.name === "profile";

  return (
    <AuthGate>
      <div className="no-select min-h-screen pb-28 bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        <div
          className={
            "max-w-3xl mx-auto " +
            (isProfile ? "p-4" : "p-4") +
            " space-y-4 transition-all duration-200 " +
            (enter ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1")
          }
        >
          {!isProfile && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={goPlaylist}
                  className="hover:opacity-90"
                  title={`Открыть плейлист: ${playlistTitle}`}
                  aria-label={`Открыть плейлист: ${playlistTitle}`}
                >
                  <span
                    className="
                      block
                      max-w-[70vw]
                      overflow-hidden
                      whitespace-nowrap
                      text-2xl
                      font-bold
                      leading-tight
                    "
                  >
                    <ShinyText
                      text={playlistTitle}
                      className="whitespace-nowrap leading-tight"
                    />
                  </span>
                </button>
              </div>
              <UserAvatar />
            </div>
          )}

          {!isProfile && (
            <GlobalSearch
              onRequestExpand={handleRequestExpand}
              onCardElementChange={registerCardElement}
            />
          )}

          {route.name === "playlist" ? (
            <PlaylistPage
              key="playlist"
              onBack={goBackSmart}
              onRequestExpand={handleRequestExpand}
              onCardElementChange={registerCardElement}
            />
          ) : route.name === "publicPlaylist" ? (
            <PublicPlaylistPage
              key={`public:${(route as any).handle}`}
              handle={(route as any).handle}
              onBack={goBackSmart}
              onRequestExpand={handleRequestExpand}
              onCardElementChange={registerCardElement}
            />
          ) : route.name === "artists" ? (
            <ArtistsListPage
              key={`artists:${(route as any).which}`}
              which={(route as any).which}
              onBack={goBackSmart}
              onOpenArtist={openArtist}
            />
          ) : route.name === "artist" ? (
            <ArtistPage
              key={`artist:${(route as any).artist}`}
              artist={(route as any).artist}
              onBack={goBackSmart}
              onRequestExpand={handleRequestExpand}
              onCardElementChange={registerCardElement}
            />
          ) : route.name === "profile" ? (
            <ProfilePage
              onRequestExpand={handleRequestExpand}
              onCardElementChange={registerCardElement}
            />
          ) : (
            <div className="space-y-4">
              {recsShuffled.length > 0 && (
                <TracksCarousel
                  tracks={recsShuffled}
                  autoplay
                  autoplayDelay={8000}
                  loop
                  title="Клевый рандом"
                />
              )}

              {recsShuffled.length === 0 && !loading && (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-4 text-sm text-zinc-500">
                  Рекомендаций пока нет — попробуйте поиск или подпишитесь на артистов.
                </div>
              )}

              <ProfilePage
                embedded
                onRequestExpand={handleRequestExpand}
                onCardElementChange={registerCardElement}
              />
            </div>
          )}
        </div>

        <PlayerOverlayLayer
          measureCardRect={measureCardRect}
          onTogglePlayPause={togglePlayPauseExpanded}
        />

        <GlobalAudioPlayer
          onRequestExpand={handleRequestExpand}
          onAddToPlaylist={(t) => openAddPopover(t, "plus")}
        />
      </div>

      {/* Поповер выбора плейлиста */}
      <AddToPlaylistPopover
        open={addOpen}
        anchorRef={addBtnAnchorRef as React.RefObject<HTMLElement>}
        onClose={() => setAddOpen(false)}
        trackTitle={addTrack?.title}
        trackArtists={addTrack?.artists}
        trackId={addTrack?.id}
        playlists={publicPlaylists}
        disabled={addDisabled}
        containsServer={containsMap}
        intent={addIntent}
        onPickLocal={async () => {
          if (!addTrack) return;
          setAddDisabled(true);
          try {
            const { added } = addToLocal(addTrack);
            // сразу отправим идемпотентный POST в личный плейлист на сервере
            try {
              if (addTrack?.id) await addItemToMyPersonalPlaylist(addTrack.id);
            } catch {
              // молча — оффлайн/сеть, следующая sync добросит
            }
            // тост — как было
            try {
              window.dispatchEvent(
                new CustomEvent("ogma:toast", {
                  detail: {
                    type: added ? "success" : "info",
                    text: added
                      ? "Добавлено в локальный плейлист"
                      : "Уже в локальном плейлисте",
                  },
                })
              );
            } catch { }
            // сообщаем плееру: этот трек добавлен в локальный/серверный плейлист
            try {
              window.dispatchEvent(
                new CustomEvent("ogma:playlist-added", {
                  detail: { trackId: addTrack.id, playlist: { type: "local" as const } },
                })
              );
            } catch { }
          } finally {
            setAddDisabled(false);
            setAddOpen(false);
          }
        }}
        onPickServer={async (p, trackId) => {
          if (!trackId) {
            console.warn("[add-to-playlist] empty trackId for playlist", p?.id);
            return;
          }
          setAddDisabled(true);
          try {
            await addItemToPlaylist(p.id, trackId);
            setContainsMap((m) => ({ ...m, [p.id]: true }));
            if (typeof window !== "undefined") {
              const cleanHandle = (p.handle || "").replace(/^@/, "");
              const token =
                typeof (globalThis as any).crypto?.randomUUID === "function"
                  ? (globalThis as any).crypto.randomUUID()
                  : `pl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
              let detailTrack: any = null;
              const sourceTrack = addTrack;
              if (sourceTrack) {
                try {
                  if (typeof (globalThis as any).structuredClone === "function") {
                    detailTrack = (globalThis as any).structuredClone(sourceTrack);
                  } else {
                    detailTrack = JSON.parse(JSON.stringify(sourceTrack));
                  }
                } catch {
                  detailTrack = { ...sourceTrack };
                }
              }
              if (!detailTrack) detailTrack = { id: trackId };
              window.dispatchEvent(
                new CustomEvent("ogma:public-playlist-item-added", {
                  detail: {
                    playlistId: String(p.id),
                    handle: cleanHandle || null,
                    playlistTitle: p.title ?? null,
                    track: detailTrack,
                    token,
                  },
                })
              );
            }
            // тост — как было
            try {
              window.dispatchEvent(
                new CustomEvent("ogma:toast", {
                  detail: {
                    type: "success",
                    text: `Трек добавлен в @${(p.handle || "").replace(
                      /^@/,
                      ""
                    ) || "public"}`,
                  },
                })
              );
            } catch { }
            // сообщаем плееру конкретный серверный плейлист
            try {
              window.dispatchEvent(
                new CustomEvent("ogma:playlist-added", {
                  detail: {
                    trackId,
                    playlist: {
                      type: "server" as const,
                      id: String(p.id),
                      handle: p.handle ?? null,
                      title: p.title ?? null,
                      is_public: !!p.is_public,
                    },
                  },
                })
              );
            } catch { }
          } catch {
            try {
              window.dispatchEvent(
                new CustomEvent("ogma:toast", {
                  detail: {
                    type: "error",
                    text: "Не удалось добавить трек в плейлист",
                  },
                })
              );
            } catch { }
          } finally {
            setAddDisabled(false);
            setAddOpen(false);
          }
        }}
      />
    </AuthGate>
  );
}

function PlayerOverlayLayer({
  measureCardRect,
  onTogglePlayPause,
}: {
  measureCardRect: (trackId: string) => RectLike | null;
  onTogglePlayPause: () => void;
}) {
  const expanded = usePlayerStore(selectExpandedState);
  const track = usePlayerStore(selectExpandedVisibleTrack);
  const paused = usePlayerStore(selectIsPaused);
  const shuffle = usePlayerStore(selectShuffle);

  const handleClose = useCallback(() => {
    const originId = expanded.originTrackId;
    const rect = originId ? measureCardRect(originId) : null;
    requestOverlayCloseController(rect);
  }, [expanded.originTrackId, measureCardRect]);

  const handleOpened = useCallback(() => {
    markOverlayOpened();
  }, []);

  const handleClosed = useCallback(() => {
    markOverlayClosed();
  }, []);

  if (expanded.phase === "closed") {
    return null;
  }

  const phase = expanded.phase as "opening" | "open" | "closing";

  return (
    <ExpandedPlayerOverlay
      track={track}
      phase={phase}
      originRect={expanded.originRect}
      onOpened={handleOpened}
      onClosed={handleClosed}
      onCloseRequested={handleClose}
      paused={paused}
      onTogglePlayPause={onTogglePlayPause}
      onNext={() => nextTrack(false)}
      onPrev={() => prevTrack(false)}
      getAudio={getAudioElement}
      shuffle={shuffle}
      onToggleShuffle={(enabled) => setShuffleController(enabled)}
    />
  );
}