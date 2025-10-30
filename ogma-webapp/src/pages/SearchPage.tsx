import { useEffect, useState } from "react";
import GlobalSearch from "@/components/GlobalSearch";
import type { Track } from "@/types/types";

export default function SearchPage({
  query,
  onBack,
  onRequestExpand,
  onCardElementChange,
}: {
  query: string;
  onBack: () => void;
  onRequestExpand?: (track: Track, rect: DOMRect) => void;
  onCardElementChange?: (trackId: string, el: HTMLDivElement | null) => void;
}) {
  const [controlledQuery, setControlledQuery] = useState(query);

  useEffect(() => {
    setControlledQuery(query);
  }, [query]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const clean = controlledQuery.trim();
    const params = new URLSearchParams();
    if (clean) params.set("q", clean);
    const suffix = params.toString();
    const target = suffix ? `#/search?${suffix}` : "#/search";
    if (window.location.hash !== target) {
      try {
        window.history.replaceState(null, "", target);
      } catch {
        window.location.hash = target;
      }
    }
  }, [controlledQuery]);

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="px-3 py-1 rounded-lg text-xs bg-zinc-200 dark:bg-zinc-800 hover:opacity-90"
        >
          ← Назад
        </button>
        <div className="text-base font-semibold truncate">Поиск</div>
        <div className="w-16" />
      </div>

      <div className="mt-3 border-t border-zinc-200 dark:border-zinc-800" />

      <GlobalSearch
        standalone
        initialQuery={controlledQuery}
        onQueryChange={setControlledQuery}
        onRequestExpand={onRequestExpand}
        onCardElementChange={onCardElementChange}
      />
    </section>
  );
}
