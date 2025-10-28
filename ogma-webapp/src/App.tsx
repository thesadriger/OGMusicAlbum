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
import { pushRecentArtists } from "@/lib/recent";
import ArtistsListPage from "@/pages/ArtistsListPage";
import PlaylistPage from "@/pages/PlaylistPage";
import GlobalAudioPlayer from "@/components/GlobalAudioPlayer";
import ProfilePage from "@/pages/Profile";
import PublicPlaylistPage from "@/pages/PublicPlaylistPage";
import { useMe } from "@/hooks/useMe";
import TracksCarousel from "@/components/TracksCarousel";
import AddToPlaylistPopover from "@/components/AddToPlaylistPopover";
import GlobalSearch from "@/components/GlobalSearch";

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
  const playlistTitle = ownerLabel ? `${ownerLabel} MusicAlbum` : "MusicAlbum";

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


  const [now, setNow] = useState<Track | null>(null);
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);

  const pauseLockRef = useRef(false);

  const [queue, setQueue] = useState<Track[]>([]);
  const [qIndex, setQIndex] = useState<number>(-1);

  // режим перемешивания
  const [shuffle, setShuffle] = useState(false);

  // === Add-to-Playlist popover — ВНУТРИ компонента ===
  const addBtnAnchorRef = useRef<HTMLElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addTrack, setAddTrack] = useState<Track | null>(null);
  const [publicPlaylists, setPublicPlaylists] = useState<PlaylistLite[]>([]);
  const [containsMap, setContainsMap] = useState<Record<string, boolean>>({});
  const [addDisabled, setAddDisabled] = useState(false);

  const resolveAddAnchor = useCallback(() => {
    const el =
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

  const playList = (list: Track[], startIndex: number) => {
    pauseLockRef.current = false; // явный старт — снимаем замок
    const safe = list.filter(Boolean);
    if (!safe.length) return;
    const idx = Math.max(0, Math.min(startIndex, safe.length - 1));
    setQueue(safe);
    setQIndex(idx);
    setNow(safe[idx]);
    setPaused(false);
    pushRecentArtists(safe[idx].artists ?? []);
  };

  const toggleTrack = (list: Track[], index: number, trackId: string) => {
    if (now && now.id === trackId) {
      const wasPaused = paused;
      setPaused((p) => !p);
      if (wasPaused) {
        // пользователь жмёт Play по текущему
        pauseLockRef.current = false;
        try {
          (window as any).__ogmaPlay?.(now);
        } catch { }
      } else {
        // пользователь жмёт Pause по текущему
        pauseLockRef.current = true;
        try {
          (window as any).__ogmaPause?.();
        } catch { }
      }
      return;
    }
    // выбор нового трека — это явное действие: снимаем замок
    pauseLockRef.current = false;
    const t = list[index];
    if (!t) return;
    setNow(t);
    setPaused(false);
    try {
      (window as any).__ogmaPlay?.(t);
    } catch { }
    setQueue(list.filter(Boolean));
    setQIndex(index);
    pushRecentArtists(t.artists ?? []);
  };

  const onQueueEnd = () => {
    setPaused(true);
    // Не автозапускаем следующий, даже если где-то попытаемся
    pauseLockRef.current = true;
  };

  const next = useCallback(
    (wrap: boolean = false): boolean => {
      if (!queue.length || pauseLockRef.current) return false;

      // shuffle
      if (shuffle && queue.length > 1) {
        const len = queue.length;
        let nextIdx = qIndex;
        do {
          nextIdx = Math.floor(Math.random() * len);
        } while (nextIdx === qIndex);
        const tr = queue[nextIdx];
        if (!tr) return false;
        setQIndex(nextIdx);
        setNow(tr);
        try {
          (window as any).__ogmaPlay?.(tr);
        } catch { }
        setPaused(false);
        try {
          pushRecentArtists(tr.artists ?? []);
        } catch { }
        return true;
      }

      // последовательный
      let moved = false;
      setQIndex((prev) => {
        if (prev < 0) return prev;
        const safeLen = queue.length;
        let nextIdx = prev + 1;

        if (nextIdx >= safeLen) {
          if (!wrap) {
            onQueueEnd?.();
            return prev;
          }
          nextIdx = 0;
        }

        const tr = queue[nextIdx];
        if (!tr) return prev;

        setNow(tr);
        try {
          (window as any).__ogmaPlay?.(tr);
        } catch { }
        setPaused(false);
        try {
          pushRecentArtists(tr.artists ?? []);
        } catch { }

        moved = true;
        return nextIdx;
      });

      return true;
    },
    [queue, shuffle, qIndex]
  );

  const prev = useCallback(
    (wrap: boolean = false): boolean => {
      if (!queue.length || pauseLockRef.current) return false;

      if (shuffle && queue.length > 1) {
        const len = queue.length;
        let nextIdx = qIndex;
        do {
          nextIdx = Math.floor(Math.random() * len);
        } while (nextIdx === qIndex);
        const tr = queue[nextIdx];
        if (!tr) return false;
        setQIndex(nextIdx);
        setNow(tr);
        try {
          (window as any).__ogmaPlay?.(tr);
        } catch { }
        setPaused(false);
        try {
          pushRecentArtists(tr.artists ?? []);
        } catch { }
        return true;
      }

      let moved = false;
      setQIndex((prevIdx) => {
        if (prevIdx < 0) return prevIdx;

        const safeLen = queue.length;
        let nextIdx = prevIdx - 1;

        if (nextIdx < 0) {
          if (!wrap) return prevIdx;
          nextIdx = Math.max(0, safeLen - 1);
        }

        const tr = queue[nextIdx];
        if (!tr) return prevIdx;

        setNow(tr);
        try {
          (window as any).__ogmaPlay?.(tr);
        } catch { }
        setPaused(false);
        try {
          pushRecentArtists(tr.artists ?? []);
        } catch { }

        moved = true;
        return nextIdx;
      });

      return true;
    },
    [queue, shuffle, qIndex]
  );

  useEffect(() => {
    (window as any).__ogmaPlayList = (list: Track[], startIndex: number) => {
      // явный старт плейлиста — снимаем замок
      pauseLockRef.current = false;
      playList(list, startIndex);
      requestAnimationFrame(() => {
        try {
          (window as any).__ogmaPlay?.(list[startIndex]);
        } catch { }
      });
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
      <div className="min-h-screen pb-28 bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
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
                  className="text-2xl font-bold hover:opacity-90 truncate max-w-[70vw]"
                  title={`Открыть плейлист: ${playlistTitle}`}
                  aria-label={`Открыть плейлист: ${playlistTitle}`}
                >
                  {playlistTitle}
                </button>
              </div>
              <UserAvatar />
            </div>
          )}

          {!isProfile && (
            <GlobalSearch
              nowId={now?.id ?? null}
              paused={paused}
              onToggleTrack={(list, idx) => toggleTrack(list, idx, list[idx]?.id)}
            />
          )}

          {route.name === "playlist" ? (
            <PlaylistPage
              key="playlist"
              onBack={goBackSmart}
              nowId={now?.id ?? null}
              paused={paused}
              onToggleTrack={toggleTrack}
            />
          ) : route.name === "publicPlaylist" ? (
            <PublicPlaylistPage
              key={`public:${(route as any).handle}`}
              handle={(route as any).handle}
              onBack={goBackSmart}
              nowId={now?.id ?? null}
              paused={paused}
              onToggleTrack={(list, idx) => toggleTrack(list, idx, list[idx]?.id)}
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
              nowId={now?.id ?? null}
              paused={paused}
              onToggleTrack={toggleTrack}
            />
          ) : route.name === "profile" ? (
            <ProfilePage nowId={now?.id ?? null} paused={paused} />
          ) : (
            <div className="space-y-4">
              {recsShuffled.length > 0 && (
                <TracksCarousel
                  tracks={recsShuffled}
                  nowId={now?.id ?? null}
                  paused={paused}
                  onToggle={(list, idx) => toggleTrack(list, idx, list[idx].id)}
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

              <ProfilePage nowId={now?.id ?? null} paused={paused} embedded />
            </div>
          )}
        </div>

        <GlobalAudioPlayer
          now={now}
          paused={paused}
          onEnded={() => {
            if (pauseLockRef.current) {
              setPaused(true);
              return;
            }
            const ok = next(false);
            if (!ok) setPaused(true);
          }}
          onPlayPauseChange={(p) => {
            setPaused(p);
          }}
          onPrev={() => prev(false)}
          onNext={() => next(false)}
          queue={queue}
          currentIndex={qIndex}
          onPickFromQueue={(i) => {
            if (i >= 0 && i < queue.length) {
              setQIndex(i);
              const tr = queue[i];
              setNow(tr);
              setPaused(false);
              try {
                (window as any).__ogmaPlay?.(tr);
              } catch { }
            }
          }}
          shuffle={shuffle}
          onToggleShuffle={(v) => setShuffle(v)}
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