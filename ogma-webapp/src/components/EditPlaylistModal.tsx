//home/ogma/ogma/ogma-webapp/src/components/EditPlaylistModal.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createPortal } from "react-dom";
import { updatePlaylist, type Playlist } from "@/lib/playlists";

const HANDLE_RE = /^[a-z0-9_][a-z0-9_-]{2,31}$/;

type EditablePlaylist = Pick<Playlist, "id" | "title" | "is_public" | "handle" | "user_id"> & {
  kind?: string;
  created_at?: string;
  updated_at?: string;
};

type Props = {
  open: boolean;
  playlist: EditablePlaylist | null;
  onClose: () => void;
  onUpdated?: (playlist: EditablePlaylist) => void;
};

export default function EditPlaylistModal({ open, playlist, onClose, onUpdated }: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const [title, setTitle] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowPublicControls = Boolean(playlist?.is_public);

  useEffect(() => {
    if (!open || !playlist) return;
    setTitle(playlist.title || "");
    setIsPublic(Boolean(playlist.is_public));
    setHandle(playlist.handle ? playlist.handle.replace(/^@/, "") : "");
    setError(null);
    setBusy(false);
  }, [open, playlist?.id]);

  // Scroll lock + autofocus
  useEffect(() => {
    if (!open) return;

    const scrollY =
      window.scrollY ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;

    const prev = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";

    const raf = requestAnimationFrame(() => {
      titleRef.current?.focus();
      overlayRef.current?.scrollIntoView({ block: "center", inline: "center" });
    });

    return () => {
      document.body.style.overflow = prev.overflow;
      document.body.style.position = prev.position;
      document.body.style.top = prev.top;
      document.body.style.width = prev.width;
      window.scrollTo(0, scrollY);
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const normalizedHandle = useMemo(() => {
    const raw = handle.trim().replace(/^@/, "");
    if (!raw) return "";
    return raw.toLowerCase();
  }, [handle]);

  const handleOk = useMemo(() => {
    if (!isPublic) return null;
    if (!normalizedHandle) return null;
    return HANDLE_RE.test(normalizedHandle) ? normalizedHandle : false;
  }, [isPublic, normalizedHandle]);

  if (!open || !playlist) return null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!playlist) return;

    setError(null);

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Введите название");
      return;
    }

    if (allowPublicControls && isPublic && handleOk === false) {
      setError("Хэндл: a–z / A–Z / 0–9 / _, 3–32 символа.");
      return;
    }

    const changes: { title?: string; handle?: string | null; is_public?: boolean } = {};
    if (trimmedTitle !== (playlist.title || "")) {
      changes.title = trimmedTitle;
    }

    if (allowPublicControls) {
      if (isPublic !== Boolean(playlist.is_public)) {
        changes.is_public = isPublic;
      }

      if (isPublic) {
        const nextHandle = normalizedHandle || null;
        const currentHandle = playlist.handle ? playlist.handle.replace(/^@/, "").toLowerCase() : null;
        if (nextHandle !== currentHandle) {
          changes.handle = nextHandle;
        }
      } else if (playlist.is_public) {
        changes.handle = null;
      }
    }

    if (Object.keys(changes).length === 0) {
      setError("Изменений нет");
      return;
    }

    try {
      setBusy(true);
      const updated = await updatePlaylist(String(playlist.id), changes);
      const normalized: EditablePlaylist = {
        id: String(updated.id),
        title: updated.title,
        is_public: updated.is_public,
        handle: updated.handle,
        user_id: updated.user_id,
        kind: updated.kind,
        created_at: updated.created_at,
        updated_at: updated.updated_at,
      };
      onUpdated?.(normalized);
      window.dispatchEvent(new Event("ogma:myplaylists-change" as any));
      onClose();
    } catch (e: any) {
      const msg = String(e?.detail || e?.message || "Не удалось обновить плейлист");
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    onClose();
  };

  const overlay = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 backdrop-blur-sm px-4 sm:px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-3xl p-5 sm:p-6 bg-zinc-900/95 text-zinc-200 border border-zinc-800/80 shadow-2xl"
      >
        <div className="text-lg font-semibold mb-3">Редактирование плейлиста</div>

        <label className="block mb-3">
          <div className="text-sm mb-1 text-zinc-300">Название</div>
          <input
            ref={titleRef}
            className="w-full rounded-xl px-3 py-2 bg-zinc-800 text-zinc-100 placeholder:text-zinc-500 border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-[#5db5f7]/60"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
          />
        </label>

        {allowPublicControls ? (
          <label className="flex gap-2 items-center mb-3">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            <span className="text-sm text-zinc-300">Публичный доступ</span>
          </label>
        ) : (
          <div className="text-xs text-zinc-500 mb-3">
            Приватные плейлисты можно переименовать, остальное в разработке.
          </div>
        )}

        {allowPublicControls && isPublic && (
          <label className="block mb-3">
            <div className="text-sm mb-1 text-zinc-300">Хэндл (опционально)</div>
            <div className="flex gap-2 items-center">
              <span className="opacity-70">@</span>
              <input
                className="flex-1 rounded-xl px-3 py-2 bg-zinc-800 text-zinc-100 placeholder:text-zinc-500 border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-[#5db5f7]/60"
                placeholder="OGMusicAlbum"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                maxLength={32}
              />
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              a–z, 0-9, "_", "-", 3–32 символа
            </div>
          </label>
        )}

        {allowPublicControls && !isPublic && (
          <div className="text-xs text-zinc-500 mb-3">
            При отключении публичности хэндл будет убран и плейлист исчезнет из поиска.
          </div>
        )}

        {error && <div className="text-sm text-red-400 mb-3">{error}</div>}

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={close}
            className="px-3 py-2 rounded-xl border border-[#5db5f7]/80 text-[#5db5f7] hover:bg-[#5db5f7]/10 active:opacity-90"
          >
            Отмена
          </button>
          <button
            disabled={busy}
            className="px-3 py-2 rounded-xl bg-[#5db5f7] text-black font-medium hover:opacity-95 active:opacity-90 disabled:opacity-60"
          >
            Сохранить
          </button>
        </div>
      </form>
    </div>
  );

  return createPortal(overlay, document.body);
}
