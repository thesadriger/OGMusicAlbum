// src/pages/ArtistsListPage.tsx
import { useEffect, useState } from "react";
import { fetchArtistsSummary } from "@/lib/api";

export default function ArtistsListPage({
  which,
  onBack,
  onOpenArtist,
}: {
  which: "ru" | "en";
  onBack: () => void;
  onOpenArtist: (name: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchArtistsSummary(1, "OGMA_archive")
      .then((s) => {
        if (cancelled) return;
        setList(which === "ru" ? s.ru ?? [] : s.en ?? []);
      })
      .catch(() => {
        if (!cancelled) setList([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [which]);

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="px-3 py-1 rounded-lg text-xs bg-zinc-200 dark:bg-zinc-800 hover:opacity-90"
        >
          ← Назад
        </button>
        <div className="text-base font-semibold truncate">
          {which === "ru" ? "Все ru" : "All en"}
          {list.length > 0 && (
            <span className="ml-2 text-sm text-zinc-500">· {list.length}</span>
          )}
        </div>
      <div className="mt-3 border-t border-zinc-200 dark:border-zinc-800" />
        <div className="w-16" />
      </div>

      {loading && <div className="text-sm text-zinc-500">Загружаем…</div>}

      {!loading && (
        <div className="mt-5 md:mt-7 flex flex-wrap gap-2">
          {list.map((name) => (
            <button
              key={name}
              onClick={() => onOpenArtist(name)}
              className="px-3 py-1 rounded-xl bg-zinc-100/80 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-800 text-sm hover:opacity-95 active:opacity-90"
            >
              {name}
            </button>
          ))}
          {list.length === 0 && (
            <div className="text-sm text-zinc-500">Нет артистов</div>
          )}
        </div>
      )}
    </section>
  );
}
