import type { Track } from "@/types/types";

// src/lib/api.ts
// Унификация BASE: если задан абсолютный — используем как есть,
// если относительный — «прибиваем» к origin. Убираем завершающий слэш.
function normalizeBase(base: string | undefined): string {
  const raw = base ?? "/api";
  try {
    const url = new URL(raw, window.location.origin); // ok и для "/api", и для "https://api.host/api"
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/$/, "");
  }
}

// Можно задать ЛИБО VITE_API_BASE, ЛИБО VITE_API_ORIGIN (+ относительный /api)
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN || window.location.origin;
export const API_BASE: string = (() => {
  const b = import.meta.env.VITE_API_BASE as string | undefined;
  if (b && /^https?:\/\//i.test(b)) return normalizeBase(b);
  // если VITE_API_BASE относительный — склеим с ORIGIN
  if (b) return normalizeBase(new URL(b, API_ORIGIN).toString());
  // по умолчанию — тот же домен, под /api
  return normalizeBase("/api");
})();

// helper: аккуратная сборка URL’ов
function join(base: string, path: string) {
  return new URL(path.replace(/^\//, ""), base + "/").toString();
}

const BOT: string = import.meta.env.VITE_BOT_USERNAME || "OGMusicAlbum_Bot";

/** Приклеить tg initData как query-параметр, чтобы <audio> тоже «знал» пользователя */
function withInit(url: string): string {
  const init = getInitData();
  if (!init) return url;
  return `${url}${url.includes("?") ? "&" : "?"}init=${encodeURIComponent(init)}`;
}

export function streamUrl(id: string): string {
  const base = join(API_BASE, `/stream/${encodeURIComponent(String(id))}`);
  return withInit(base);
}

/** URL для стрима по msgId+chat (предпочтительно), с фолбэком на uuid */
export function streamUrlFor(t: Pick<Track, "id" | "chat" | "msgId">): string {
  if (t?.chat && t?.msgId) {
    const u = new URL(join(API_BASE, `/stream/by-msg/${encodeURIComponent(String(t.msgId))}`));
    u.searchParams.set("chat", t.chat.replace(/^@/, ""));
    return withInit(u.toString());
  }
  return streamUrl(String(t.id));
}


/** Получить Telegram initData из WebApp/URL, либо пустую строку */
export function getInitData(): string {
  try {
    const w = (window as any);
    const direct = w?.Telegram?.WebApp?.initData;
    if (typeof direct === "string" && direct.length > 0) return direct;

    const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("tgWebAppData");
    if (fromHash) return fromHash;

    const fromSearch = new URLSearchParams(location.search).get("tgWebAppData");
    return fromSearch || "";
  } catch {
    return "";
  }
}

/** Мгновенный перевод пользователя в мини-апп Telegram */
export function ensureTelegramAuth(): never | void {
  const init = getInitData();
  if (init) return; // уже в WebApp — всё ок

  const deeplink = `https://t.me/${BOT}?startapp=app`;
  // пробуем через SDK (если он есть)
  try {
    (window as any)?.Telegram?.WebApp?.openTelegramLink?.(deeplink);
  } catch { }
  // гарантирующий фолбэк
  location.href = deeplink;
  // дальше выполнение не важно
}

/** В DEV добавляем отладочные заголовки */
function getDevHeaders(): Record<string, string> {
  try {
    const qp = new URLSearchParams(location.search);
    const allow =
      import.meta.env.DEV ||
      import.meta.env.VITE_ALLOW_BROWSER === '1' ||
      qp.has('noauth');
    if (allow) {
      return {
        'X-Debug-User-Id': '12345',
        'X-Debug-Username': 'devuser',
        'X-Debug-Name': 'Dev User',
      };
    }
  } catch { }
  return {};
}

export class ApiError extends Error {
  constructor(public status: number, msg?: string) { super(msg ?? `HTTP ${status}`); }
}

export async function apiGet<T>(path: string, opts: { timeoutMs?: number } = {}): Promise<T> {
  const url = path.startsWith("http") ? path : join(API_BASE, path);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);

  try {
    const headers: Record<string, string> = { Accept: "application/json" };

    // добавляем Telegram initData, если есть (для API-запросов)
    const initData = getInitData();
    if (initData) headers["X-Telegram-Init-Data"] = initData;

    Object.assign(headers, getDevHeaders());

    const r = await fetch(url, {
      signal: ctrl.signal,
      credentials: "include",
      headers,
      cache: "no-store",   // <- не даём браузеру/прокси закешировать
      redirect: "follow",
    });

    if (r.status === 401) {
      const qp = new URLSearchParams(location.search);
      const ALLOW_BROWSER =
        import.meta.env.DEV ||
        import.meta.env.VITE_ALLOW_BROWSER === '1' ||
        qp.has('noauth');
      if (!ALLOW_BROWSER) ensureTelegramAuth();
      throw new ApiError(401, "Unauthorized"); // <-- status сохраняем
    }

    if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status} ${r.statusText}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function apiPost<T = any>(
  path: string,
  body?: any,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<T> {
  const url = path.startsWith("http") ? path : join(API_BASE, path);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    };

    // добавляем Telegram initData, если есть (для API-запросов)
    const initData = getInitData();
    if (initData) headers["X-Telegram-Init-Data"] = initData;

    Object.assign(headers, getDevHeaders());

    const r = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      credentials: "include",
      headers,
      cache: "no-store",
      redirect: "follow",
      body: body == null ? null : JSON.stringify(body),
    });

    if (r.status === 401) {
      const qp = new URLSearchParams(location.search);
      const ALLOW_BROWSER =
        import.meta.env.DEV ||
        import.meta.env.VITE_ALLOW_BROWSER === "1" ||
        qp.has("noauth");
      if (!ALLOW_BROWSER) ensureTelegramAuth();
      throw new ApiError(401, "Unauthorized");
    }

    if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status} ${r.statusText}`);

    // если тело пустое, не пытаемся парсить JSON
    const text = await r.text();
    return (text ? JSON.parse(text) : (undefined as unknown)) as T;
  } finally {
    clearTimeout(timer);
  }
}


// -------- artists API --------
export type ArtistsSummary = {
  top: { artist: string; seconds_total: number }[];
  ru: string[];
  en: string[];
  chat: string;
};

export async function fetchArtistsSummary(top = 3, chat = "OGMA_archive") {
  return apiGet<ArtistsSummary>(`/catalog/artists/summary?top=${top}&chat=${encodeURIComponent(chat)}`);
}

export async function fetchArtistTracks(artist: string, chat = "OGMA_archive") {
  return apiGet<{ artist: string; chat: string; count: number; items: Track[] }>(
    `/catalog/artist/tracks?artist=${encodeURIComponent(artist)}&chat=${encodeURIComponent(chat)}`
  );
}


const ENDPOINT_SEND = "/me/send";

export async function sendTrackToMe(t: Pick<Track, "id" | "chat" | "msgId">) {
  const initData = getInitData();
  const body: any = {};
  if (t.chat && t.msgId) {
    body.chat = String(t.chat).replace(/^@/, "");
    body.msg_id = t.msgId;
  } else {
    body.track_id = t.id;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (initData) headers["X-Telegram-Init-Data"] = initData;

  await fetch(`${API_BASE}${ENDPOINT_SEND}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "include",
  });
}
