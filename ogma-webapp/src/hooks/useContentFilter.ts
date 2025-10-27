// /home/ogma/ogma/ogma-webapp/src/hooks/useContentFilter.ts
import { useEffect, useState } from "react";

const LS_KEY = "ogma_content_filter_on";
const EVT = "ogma:content-filter-changed";

/** Нормализация названия для сравнения «одинаковых» треков */
export function normalizeTitle(title?: string | null): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[‐-–—]+/g, "-") // разные тире к одному виду
    .trim();
}

/** Глобальный флажок «Фильтр контента» (дедуп по названию) */
export function useContentFilter(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    const raw = localStorage.getItem(LS_KEY);
    return raw == null ? true : raw === "1";
  });

  // слушаем кросс-вкладочные изменения
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_KEY) {
        const v = e.newValue == null ? true : e.newValue === "1";
        setOn(v);
      }
    };
    const onCustom = (e: Event) => {
      const v = (e as CustomEvent)?.detail?.on;
      if (typeof v === "boolean") setOn(v);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVT as any, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVT as any, onCustom);
    };
  }, []);

  const set = (v: boolean) => {
    try { localStorage.setItem(LS_KEY, v ? "1" : "0"); } catch { }
    setOn(v);
    try {
      window.dispatchEvent(new CustomEvent(EVT, { detail: { on: v } }));
    } catch { }
  };

  return [on, set];
}

/** Убирает дубликаты по нормализованному названию (оставляет первый попавшийся) */
export function filterTracksUniqueByTitle<T extends { title?: string | null }>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const key = normalizeTitle(item?.title || "");
    if (!key) { out.push(item); continue; } // пустые названия не склеиваем
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}