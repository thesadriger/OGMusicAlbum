import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { Track } from "@/types/types";
import { TrackCard } from "@/components/TrackCard";
import AnimatedList from "@/components/AnimatedList";
import EditPlaylistModal from "@/components/EditPlaylistModal";
import {
  getPublicPlaylistByHandle,
  getPublicPlaylistItemsByHandle,
  removeItemFromPublicPlaylistByHandle,
} from "@/lib/playlists";
import { useMe } from "@/hooks/useMe";
import { goPlaylistHandle } from "@/lib/router";
import { formatSecondsToHMS } from "@/lib/time";
import {
  usePlayerStore,
  selectCurrentTrackId,
  selectIsPaused,
  selectExpandedTrackId,
} from "@/store/playerStore";
import { toggleTrack as toggleTrackController } from "@/lib/playerController";

const GearIcon = () => (
  <svg width="20" height="20" viewBox="0 0 1024 1024" aria-hidden="true" fill="currentColor">
    <path d="M600.704 64a32 32 0 0130.464 22.208l35.2 109.376c14.784 7.232 28.928 15.36 42.432 24.512l112.384-24.192a32 32 0 0134.432 15.36L944.32 364.8a32 32 0 01-4.032 37.504l-77.12 85.12a357.12 357.12 0 010 49.024l77.12 85.248a32 32 0 014.032 37.504l-88.704 153.6a32 32 0 01-34.432 15.296L708.8 803.904c-13.44 9.088-27.648 17.28-42.368 24.512l-35.264 109.376A32 32 0 01600.704 960H423.296a32 32 0 01-30.464-22.208L357.696 828.48a351.616 351.616 0 01-42.56-24.64l-112.32 24.256a32 32 0 01-34.432-15.36L79.68 659.2a32 32 0 014.032-37.504l77.12-85.248a357.12 357.12 0 010-48.896l-77.12-85.248A32 32 0 0179.68 364.8l88.704-153.6a32 32 0 0134.432-15.296l112.32 24.256c13.568-9.152 27.776-17.408 42.56-24.64l35.2-109.312A32 32 0 01423.232 64H600.64zm-23.424 64H446.72l-36.352 113.088-24.512 11.968a294.113 294.113 0 00-34.816 20.096l-22.656 15.36-116.224-25.088-65.28 113.152 79.68 88.192-1.92 27.136a293.12 293.12 0 000 40.192l1.92 27.136-79.808 88.192 65.344 113.152 116.224-25.024 22.656 15.296a294.113 294.113 0 0034.816 20.096l24.512 11.968L446.72 896h130.688l36.48-113.152 24.448-11.904a288.282 288.282 0 0034.752-20.096l22.592-15.296 116.288 25.024 65.28-113.152-79.744-88.192 1.92-27.136a293.12 293.12 0 000-40.256l-1.92-27.136 79.808-88.128-65.344-113.152-116.288 24.96-22.592-15.232a287.616 287.616 0 00-34.752-20.096l-24.448-11.904L577.344 128zM512 320a192 192 0 110 384 192 192 0 010-384zm0 64a128 128 0 100 256 128 128 0 000-256z" />
  </svg>
);

export default function PublicPlaylistPage({
  handle,
  onBack,
  onRequestExpand,
  onCardElementChange,
}: {
  handle: string;
  onBack: () => void;
  onRequestExpand?: (track: Track, rect: DOMRect) => void;
  onCardElementChange?: (trackId: string, el: HTMLDivElement | null) => void;
}) {
  const nowId = usePlayerStore(selectCurrentTrackId);
  const paused = usePlayerStore(selectIsPaused);
  const expandedTrackId = usePlayerStore(selectExpandedTrackId);
  const [info, setInfo] = useState<any | null>(null);
  const [items, setItems] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [editTarget, setEditTarget] = useState<any | null>(null);
  const lastPlaylistEventTokenRef = useRef<string | null>(null);
  const { me } = useMe();
  const normalizedRouteHandle = handle.replace(/^@/, "").toLowerCase();

  const toggleFromList = useCallback((tracks: Track[], index: number) => {
    toggleTrackController(tracks, index, tracks[index]?.id);
  }, []);

  const listenSeconds = useMemo(
    () => Number(info?.listen_seconds ?? info?.listenSeconds ?? 0),
    [info]
  );

  const canEdit = useMemo(() => {
    if (!info || !me) return false;
    const rawOwner = info.user_id ?? info.userId ?? info.ownerId ?? info.owner_id ?? null;
    const ownerId = rawOwner != null ? Number(rawOwner) : NaN;
    if (!Number.isFinite(ownerId)) return false;
    return ownerId === Number(me.telegram_id);
  }, [info, me]);

  const playlistContext = useMemo(() => {
    if (!info) return null;
    const rawId = info.id ?? (info as any).playlist_id ?? (info as any).playlistId;
    if (!rawId) return null;
    const ownerRaw = info.user_id ?? info.userId ?? info.owner_id ?? info.ownerId;
    let ownerId: number | null = null;
    if (ownerRaw != null) {
      const num = Number(ownerRaw);
      ownerId = Number.isFinite(num) ? num : null;
    }
    return {
      id: String(rawId),
      handle: info.handle ?? null,
      ownerId,
      title: info.title ?? null,
      isPublic: info.is_public ?? info.isPublic ?? null,
    };
  }, [info]);

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

  useEffect(() => {
    if (typeof window === "undefined") return;

    const matchesPlaylist = (detail: any) => {
      const pid = detail?.playlistId ?? detail?.playlist_id ?? null;
      if (pid && info?.id && String(info.id) === String(pid)) return true;
      const handleRaw = detail?.handle;
      if (handleRaw) {
        const clean = String(handleRaw).replace(/^@/, "").toLowerCase();
        if (clean === normalizedRouteHandle) return true;
      }
      return false;
    };

    const tracksEqual = (a: any, b: any) => {
      if (!a || !b) return false;
      if (a.id && b.id && String(a.id) === String(b.id)) return true;
      const msgA = a.msgId ?? a.msg_id ?? null;
      const msgB = b.msgId ?? b.msg_id ?? null;
      if (msgA != null && msgB != null) {
        const chatA = (a.chat ?? a.chat_username ?? a.chatUsername ?? "")
          .toString()
          .replace(/^@/, "")
          .toLowerCase();
        const chatB = (b.chat ?? b.chat_username ?? b.chatUsername ?? "")
          .toString()
          .replace(/^@/, "")
          .toLowerCase();
        if (Number(msgA) === Number(msgB)) {
          if (!chatA || !chatB) return true;
          return chatA === chatB;
        }
      }
      return false;
    };

    const onAdded = (event: Event) => {
      const detail = (event as CustomEvent<any>)?.detail ?? {};
      if (detail?.token && detail.token === lastPlaylistEventTokenRef.current) return;
      if (!matchesPlaylist(detail)) return;
      const track = detail.track ?? detail;
      if (!track) return;
      let appended = false;
      setItems((prev) => {
        if (prev.some((item) => tracksEqual(item, track))) return prev;
        appended = true;
        return [track, ...prev];
      });
      if (appended) {
        setInfo((prev: any) => {
          if (!prev) return prev;
          const base =
            typeof prev.item_count === "number"
              ? prev.item_count
              : Array.isArray(prev.items)
                ? prev.items.length
                : 0;
          return { ...prev, item_count: base + 1 };
        });
      }
    };

    const onRemoved = (event: Event) => {
      const detail = (event as CustomEvent<any>)?.detail ?? {};
      if (detail?.token && detail.token === lastPlaylistEventTokenRef.current) return;
      if (!matchesPlaylist(detail)) return;
      const track = detail.track ?? detail;
      if (!track) return;
      let removed = false;
      setItems((prev) => {
        const next = prev.filter((item) => !tracksEqual(item, track));
        removed = removed || next.length !== prev.length;
        return next;
      });
      if (removed) {
        setInfo((prev: any) => {
          if (!prev) return prev;
          const base =
            typeof prev.item_count === "number"
              ? prev.item_count
              : Array.isArray(prev.items)
                ? prev.items.length
                : 0;
          return { ...prev, item_count: Math.max(0, base - 1) };
        });
      }
    };

    window.addEventListener("ogma:public-playlist-item-added", onAdded as any);
    window.addEventListener("ogma:public-playlist-item-removed", onRemoved as any);

    return () => {
      window.removeEventListener("ogma:public-playlist-item-added", onAdded as any);
      window.removeEventListener("ogma:public-playlist-item-removed", onRemoved as any);
    };
  }, [info?.id, info?.handle, normalizedRouteHandle]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return (items || []).filter(t => {
      const hay = (t.title || "") + " " + (t.artists?.join(" ") || "") + " " + ((t as any).hashtags?.join(" ") || "");
      return hay.toLowerCase().includes(s);
    });
  }, [q, items]);

  const playbackList = useMemo(() => {
    if (!playlistContext) return filtered;
    return filtered.map((t) => ({ ...t, playlistContext }));
  }, [filtered, playlistContext]);

  return (
    <>
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
        <div className="flex items-center justify-end min-w-[4.5rem]">
          {canEdit && info ? (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() =>
                setEditTarget({
                  ...info,
                  id: String(info.id),
                  handle: info.handle ?? null,
                })
              }
              aria-label="Настройки плейлиста"
              title="Настройки плейлиста"
              className="p-2 rounded-lg bg-zinc-200 dark:bg-zinc-800 hover:opacity-90"
            >
              <GearIcon />
            </button>
          ) : null}
        </div>
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
        <AnimatedList
          items={filtered.map((t, i) => ({
            key: t.id,
            content: (
              <TrackCard
                t={t}
                isActive={nowId === t.id}
                isPaused={paused}
                onToggle={() => toggleFromList(playbackList, i)}
                mode="playlist"
                onRequestExpand={onRequestExpand}
                hideDuringExpand={expandedTrackId === t.id}
                onCardElementChange={onCardElementChange}
                onRemoveFromPublic={async (track) => {
                  await removeItemFromPublicPlaylistByHandle(handle, track);
                  let removed = false;
                  setItems((prev) => {
                    const next = prev.filter((x) => {
                      if (!x) return true;
                      if (x.id && track.id && String(x.id) === String(track.id)) {
                        return false;
                      }
                      const xMsg = (x as any).msgId ?? (x as any).msg_id ?? null;
                      const tMsg = (track as any).msgId ?? (track as any).msg_id ?? null;
                      if (xMsg != null && tMsg != null) {
                        const xChat = (x as any).chat ?? (x as any).chat_username ?? (x as any).chatUsername ?? "";
                        const tChat = (track as any).chat ?? (track as any).chat_username ?? (track as any).chatUsername ?? "";
                        const cleanX = String(xChat).replace(/^@/, "").toLowerCase();
                        const cleanT = String(tChat).replace(/^@/, "").toLowerCase();
                        if (Number(xMsg) === Number(tMsg)) {
                          if (!cleanX || !cleanT || cleanX === cleanT) {
                            return false;
                          }
                        }
                      }
                      return true;
                    });
                    removed = removed || next.length !== prev.length;
                    return next;
                  });
                  if (removed) {
                    setInfo((prev: any) => {
                      if (!prev) return prev;
                      const base =
                        typeof prev.item_count === "number"
                          ? prev.item_count
                          : Array.isArray(prev.items)
                            ? prev.items.length
                            : 0;
                      return { ...prev, item_count: Math.max(0, base - 1) };
                    });
                  }
                  if (typeof window !== "undefined") {
                    const token =
                      typeof (globalThis as any).crypto?.randomUUID === "function"
                        ? (globalThis as any).crypto.randomUUID()
                        : `pl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                    lastPlaylistEventTokenRef.current = token;
                    let detailTrack: any;
                    try {
                      if (typeof (globalThis as any).structuredClone === "function") {
                        detailTrack = (globalThis as any).structuredClone(track);
                      } else {
                        detailTrack = JSON.parse(JSON.stringify(track));
                      }
                    } catch {
                      detailTrack = { ...track };
                    }
                    const playlistIdStr = info?.id ? String(info.id) : null;
                    const cleanHandle = (info?.handle ?? handle ?? "")
                      .toString()
                      .replace(/^@/, "");
                    window.dispatchEvent(
                      new CustomEvent("ogma:public-playlist-item-removed", {
                        detail: {
                          playlistId: playlistIdStr,
                          handle: cleanHandle || normalizedRouteHandle,
                          playlistTitle: info?.title ?? null,
                          track: detailTrack,
                          token,
                        },
                      })
                    );
                  }
                }}
              />
            ),
          }))}
          listClassName="space-y-3"
          scrollable={false}
          showGradients={false}
        />
      )}

      <div className="pt-3 text-xs text-zinc-500 border-t border-zinc-200/60 dark:border-zinc-800/60">
        Прослушано другими: <span className="font-mono text-zinc-700 dark:text-zinc-300">{formatSecondsToHMS(listenSeconds)}</span>
      </div>
      </section>
      <EditPlaylistModal
        open={Boolean(editTarget)}
        playlist={editTarget}
        onClose={() => setEditTarget(null)}
        onUpdated={(updated) => {
          setEditTarget(null);
          setInfo((prev: any) => (prev ? { ...prev, ...updated } : updated));
          if (!updated.is_public || !updated.handle) {
            setItems([]);
            onBack();
            return;
          }

          const nextHandle = updated.handle.replace(/^@/, "").toLowerCase();
          if (nextHandle !== normalizedRouteHandle) {
            goPlaylistHandle(nextHandle);
            return;
          }

          (async () => {
            try {
              const refreshed = await getPublicPlaylistByHandle(updated.handle || handle);
              if (refreshed) {
                setInfo(refreshed);
                const li = await getPublicPlaylistItemsByHandle(updated.handle || handle, 200, 0);
                setItems((li?.items as any[]) || []);
              }
            } catch { }
          })();
        }}
      />
    </>
  );
}