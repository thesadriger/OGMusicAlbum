import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createPlaylist } from "@/lib/playlists";

const HANDLE_RE = /^[A-Za-z0-9_]{3,32}$/;

export default function CreatePlaylistModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (p: any) => void;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const [title, setTitle] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleOk = useMemo(() => {
    const h = handle.trim();
    if (!isPublic || h === "") return null;
    return HANDLE_RE.test(h) ? h : false;
  }, [handle, isPublic]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) { setError("Введите название"); return; }
    if (handleOk === false) { setError("Хэндл: a–z / A–Z / 0–9 / _, 3–32 символа."); return; }
    try {
      setBusy(true);
      const p = await createPlaylist({
        title: title.trim(),
        is_public: isPublic,
        handle: isPublic ? ((handleOk as string | null)?.toLowerCase() ?? null) : null,
      });
      onCreated?.(p);
      window.dispatchEvent(new Event("ogma:myplaylists-change" as any));
      onClose();
    } catch (e: any) {
      // # Подсказка при 401
      const raw = e?.detail || e?.message || "";
      const msg = /unauthorized/i.test(raw)
        ? "Unauthorized — требуется авторизация. Откройте профиль и заново авторизуйтесь."
        : (raw || "Не удалось создать плейлист");
      setError(String(msg));
    } finally {
      setBusy(false);
    }
  };

  // Скролл-лок + автофокус + центрирование
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

  if (!open) return null;

  const overlay = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 backdrop-blur-sm
                 px-4 sm:px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-3xl p-5 sm:p-6
                   bg-zinc-900/95 text-zinc-200
                   border border-zinc-800/80 shadow-2xl"
      >
        <div className="text-lg font-semibold mb-3">Новый плейлист</div>

        <label className="block mb-3">
          <div className="text-sm mb-1 text-zinc-300">Название</div>
          <input
            ref={titleRef}
            className="w-full rounded-xl px-3 py-2
                       bg-zinc-800 text-zinc-100 placeholder:text-zinc-500
                       border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-[#5db5f7]/60"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            placeholder="OGMusicAlbum"
          />
        </label>

        <label className="flex gap-2 items-center mb-3">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <span className="text-sm text-zinc-300">Сделать публичным</span>
        </label>

        {isPublic && (
          <label className="block mb-3">
            <div className="text-sm mb-1 text-zinc-300">Хэндл (опционально)</div>
            <div className="flex gap-2 items-center">
              <span className="opacity-70">@</span>
              <input
                className="flex-1 rounded-xl px-3 py-2
                           bg-zinc-800 text-zinc-100 placeholder:text-zinc-500
                           border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-[#5db5f7]/60"
                placeholder="OGMusicAlbum"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                maxLength={32}
              />
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              a–z, A–Z, 0–9, подчёркивание, 3–32 символа
            </div>
          </label>
        )}

        {error && <div className="text-sm text-red-400 mb-3">{error}</div>}

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-xl border border-[#5db5f7]/80 text-[#5db5f7] hover:bg-[#5db5f7]/10 active:opacity-90"
          >
            Отмена
          </button>
          <button
            disabled={busy}
            className="px-3 py-2 rounded-xl bg-[#5db5f7] text-black font-medium
                       hover:opacity-95 active:opacity-90 disabled:opacity-60"
          >
            Создать
          </button>
        </div>
      </form>
    </div>
  );

  return createPortal(overlay, document.body);
}