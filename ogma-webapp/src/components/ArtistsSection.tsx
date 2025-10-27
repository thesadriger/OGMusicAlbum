// src/components/ArtistsSection.tsx
import { useEffect, useState } from "react";
import { fetchArtistsSummary } from "@/lib/api";
import { getRecentArtists } from "@/lib/recent";
import { goArtists } from "@/lib/router";

type Props = { onOpenArtist: (name: string) => void };

export default function ArtistsSection({ onOpenArtist }: Props) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<{ ru: string[]; en: string[] } | null>(null);

  // Последние прослушанные (локальный стор)
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // top не нужен, берём только списки
    fetchArtistsSummary(1, "OGMA_archive")
      .then((s) => !cancelled && setSummary({ ru: s.ru ?? [], en: s.en ?? [] }))
      .catch(() => !cancelled && setSummary({ ru: [], en: [] }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  // подписка на изменения «последних прослушанных»
  useEffect(() => {
    const refresh = () => setRecent(getRecentArtists(12));
    refresh();
    const handler = () => refresh();
    window.addEventListener("ogma:recent-change" as any, handler as any);
    return () => window.removeEventListener("ogma:recent-change" as any, handler as any);
  }, []);

  const RU = summary?.ru ?? [];
  const EN = summary?.en ?? [];

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3 space-y-4">
      <div className="flex items-center justify-between px-1">
        <div className="text-sm text-zinc-500">Артисты</div>
        {loading && <div className="text-xs text-zinc-400">загрузка…</div>}
      </div>

      {/* Последние прослушанные */}
      <div>
        <div className="text-sm font-medium mb-2">Недавно прослушанные</div>
        <div className="flex flex-wrap gap-2">
          {recent.map((name) => (
            <button
              key={`rec:${name}`}
              onClick={() => onOpenArtist(name)}
              className="px-3 py-1 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-100/80 dark:bg-zinc-800/60 hover:opacity-95 active:opacity-90 text-sm"
            >
              {name}
            </button>
          ))}
          {recent.length === 0 && (
            <div className="text-sm text-zinc-500">Пока нет данных</div>
          )}
        </div>
      </div>

      {/* Каталог по алфавиту */}
      <div>
        <div className="text-sm font-medium mb-2">Каталог по алфавиту</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* RU */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-2">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Русские</div>
              <button
                onClick={() => goArtists("ru")}
                className="px-2 py-1 rounded-lg text-xs bg-zinc-200 dark:bg-zinc-800 hover:opacity-90"
              >
                Все
              </button>
            </div>
            <div className="flex flex-wrap gap-2 max-h-72 overflow-auto pr-1">
              {RU.slice(0, 60).map((name) => (
                <button
                  key={`ru:${name}`}
                  onClick={() => onOpenArtist(name)}
                  className="px-3 py-1 rounded-xl bg-zinc-100/80 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-800 text-sm hover:opacity-95 active:opacity-90"
                >
                  {name}
                </button>
              ))}
              {RU.length === 0 && <div className="text-sm text-zinc-500">Нет артистов</div>}
            </div>
          </div>

          {/* EN */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-2">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Английские</div>
              <button
                onClick={() => goArtists("en")}
                className="px-2 py-1 rounded-lg text-xs bg-zinc-200 dark:bg-zinc-800 hover:opacity-90"
              >
                All
              </button>
            </div>
            <div className="flex flex-wrap gap-2 max-h-72 overflow-auto pr-1">
              {EN.slice(0, 60).map((name) => (
                <button
                  key={`en:${name}`}
                  onClick={() => onOpenArtist(name)}
                  className="px-3 py-1 rounded-xl bg-zinc-100/80 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-800 text-sm hover:opacity-95 active:opacity-90"
                >
                  {name}
                </button>
              ))}
              {EN.length === 0 && <div className="text-sm text-zinc-500">Нет артистов</div>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}