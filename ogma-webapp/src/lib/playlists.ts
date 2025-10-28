// src/lib/playlists.ts
import type { Track } from "@/types/types";

export type Playlist = {
  id: string;
  user_id: number;
  title: string;
  kind: "custom" | "system";
  is_public: boolean;
  handle: string | null;
  created_at: string;
  updated_at: string;
  item_count?: number;
};

const parse = async (r: Response) => {
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.text();
};

function getCsrfFromCookies() {
  // подхватываем популярные имена токенов
  const m = document.cookie.match(
    /(?:^|;\s*)(?:csrf|csrftoken|XSRF-TOKEN|xsrf-token)=([^;]+)/i
  );
  return m ? decodeURIComponent(m[1]) : null;
}
function authHeaders(extra?: HeadersInit): HeadersInit {
  const initData = (window as any)?.Telegram?.WebApp?.initData || "";
  const csrf = getCsrfFromCookies();
  return {
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    ...(initData ? { "X-Telegram-Init-Data": initData } : {}),
    ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    ...(extra || {}),
  };
}

async function req<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...init });
  const body = await parse(r);
  if (!r.ok) {
    const err: any =
      body && typeof body === "object"
        ? body
        : new Error(String(body || r.statusText));
    err.status = r.status;
    throw err;
  }
  return body as T;
}

/* ======================= ПУБЛИЧНЫЕ ПЛЕЙЛИСТЫ (как было) ======================= */

export async function listMyPlaylists() {
  return req<{ items: Playlist[] }>("/api/playlists", {
    method: "GET",
    headers: authHeaders({
      Accept: "application/json",
      "Cache-Control": "no-store",
    }),
  } as RequestInit);
}

export async function createPlaylist(payload: {
  title: string;
  is_public?: boolean;
  handle?: string | null;
}) {
  return req<Playlist>("/api/playlists", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
}

export async function updatePlaylist(
  id: string,
  payload: { title?: string; handle?: string | null; is_public?: boolean }
) {
  const body: Record<string, string | boolean | null> = {};
  if (payload.title !== undefined) body.title = payload.title;
  if (payload.handle !== undefined) body.handle = payload.handle;
  if (payload.is_public !== undefined) body.is_public = payload.is_public;

  const url = `/api/playlists/${encodeURIComponent(id)}`;
  const json = JSON.stringify(body);
  const baseHeaders = authHeaders({ "Content-Type": "application/json" });

  try {
    return await req<Playlist>(url, {
      method: "PATCH",
      headers: baseHeaders,
      body: json,
    });
  } catch (e: any) {
    const msg = String(e?.detail || e?.message || "");
    if (e?.status !== 405 && !/method not allowed/i.test(msg)) {
      throw e;
    }

    try {
      return await req<Playlist>(url, {
        method: "PUT",
        headers: baseHeaders,
        body: json,
      });
    } catch (errPut: any) {
      const msgPut = String(errPut?.detail || errPut?.message || "");
      if (errPut?.status !== 405 && !/method not allowed/i.test(msgPut)) {
        throw errPut;
      }

      return req<Playlist>(url, {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          "X-HTTP-Method-Override": "PATCH",
        }),
        body: json,
      });
    }
  }
}

export async function setPlaylistHandle(id: string, handle: string | null) {
  return req<Playlist>(`/api/playlists/${id}/handle`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ handle }),
  });
}

export async function addItemToPlaylist(playlistId: string, trackId: string) {
  return req<{
    playlist_id: string;
    track_id: string;
    position?: number;
    added_at?: string;
  }>(`/api/playlists/${playlistId}/items?track_id=${encodeURIComponent(trackId)}`, {
    method: "POST",
    headers: authHeaders(),
  });
}

export async function removeItemFromPlaylist(
  playlistId: string,
  trackId: string
) {
  const pid = encodeURIComponent(playlistId);
  const tid = encodeURIComponent(trackId);
  let lastErr: any;

  // 1) DELETE /api/playlists/:id/items/:trackId
  try {
    return await req<{ ok: true }>(`/api/playlists/${pid}/items/${tid}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch (e) {
    lastErr = e;
  }

  // 2) DELETE /api/playlists/:id/items?track_id=...
  try {
    return await req<{ ok: true }>(
      `/api/playlists/${pid}/items?track_id=${tid}`,
      {
        method: "DELETE",
        headers: authHeaders(),
      }
    );
  } catch (e: any) {
    lastErr = e;
    const msg = String(e?.detail || e?.message || "");
    // 3) POST + X-HTTP-Method-Override: DELETE
    if (e?.status === 405 || /method not allowed/i.test(msg)) {
      try {
        return await postAsDelete(
          `/api/playlists/${pid}/items?track_id=${tid}`
        );
      } catch (ee) {
        lastErr = ee;
      }
    }
  }

  // 4) POST /api/playlists/:id/items/remove { track_id }
  try {
    return await req<{ ok: true }>(`/api/playlists/${pid}/items/remove`, {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "application/json",
        Accept: "application/json",
      }),
      body: JSON.stringify({ track_id: trackId }),
    });
  } catch (e) {
    lastErr = e;
  }

  throw lastErr || new Error("Failed to remove item from playlist");
}

export async function removeItemFromPlaylistByMsg(
  playlistId: string,
  msgId: string,
  chat: string
) {
  const pid = encodeURIComponent(playlistId);
  const qs = (s: string) => encodeURIComponent(String(s));
  let lastErr: any;

  try {
    return await req<{ ok: true }>(
      `/api/playlists/${pid}/items/by-msg/${qs(msgId)}?chat=${qs(
        chat.replace(/^@/, "")
      )}`,
      { method: "DELETE", headers: authHeaders() }
    );
  } catch (e) {
    lastErr = e;
  }

  try {
    return await req<{ ok: true }>(
      `/api/playlists/${pid}/items?msg_id=${qs(msgId)}&chat=${qs(
        chat.replace(/^@/, "")
      )}`,
      { method: "DELETE", headers: authHeaders() }
    );
  } catch (e: any) {
    lastErr = e;
    const msg = String(e?.detail || e?.message || "");
    if (e?.status === 405 || /method not allowed/i.test(msg)) {
      try {
        return await req<{ ok: true }>(
          `/api/playlists/${pid}/items?msg_id=${qs(msgId)}&chat=${qs(
            chat.replace(/^@/, "")
          )}`,
          {
            method: "POST",
            headers: authHeaders({
              "X-HTTP-Method-Override": "DELETE",
            }),
            body: "{}",
          }
        );
      } catch (ee) {
        lastErr = ee;
      }
    }
  }

  try {
    return await req<{ ok: true }>(`/api/playlists/${pid}/items/remove`, {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "application/json",
        Accept: "application/json",
      }),
      body: JSON.stringify({ msg_id: Number(msgId), chat: chat.replace(/^@/, "") }),
    });
  } catch (e) {
    lastErr = e;
  }

  throw lastErr || new Error("Failed to remove item by msg from playlist");
}

// вспомогательный фоллбек: POST + X-HTTP-Method-Override: DELETE
async function postAsDelete(url: string) {
  return req<{ ok: true }>(url, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/json",
      "X-HTTP-Method-Override": "DELETE",
      Accept: "application/json",
    }),
    body: "{}", // некоторые бэки требуют тело у POST
  });
}

export async function deletePlaylistById(id: string | number) {
  const url = `/api/playlists/${encodeURIComponent(String(id))}`;
  try {
    return await req<{ ok: true }>(url, {
      method: "DELETE",
      headers: authHeaders({ Accept: "application/json" }),
    });
  } catch (e: any) {
    const msg = String(e?.detail || e?.message || "");
    if (e?.status === 405 || /method not allowed/i.test(msg)) {
      try {
        return await postAsDelete(url);
      } catch {
        /* ниже ещё один фоллбек */
      }
      return req<{ ok: true }>(`${url}/delete`, {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: "{}",
      });
    }
    throw e;
  }
}

export async function deletePlaylist(opts: {
  id?: string | number;
  handle?: string | null;
}) {
  const { id, handle } = opts || {};
  let lastErr: any;

  if (handle) {
    try {
      return await deletePlaylistByHandle(handle);
    } catch (e) {
      lastErr = e;
    }
  }

  if (id != null) {
    try {
      return await deletePlaylistById(id);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Delete failed");
}

export async function deletePlaylistByHandle(handle: string) {
  const clean = handle.replace(/^@/, "").toLowerCase();
  const base = `/api/playlists/by-handle/${encodeURIComponent(clean)}`;
  try {
    return await req<{ ok: true }>(base, {
      method: "DELETE",
      headers: authHeaders({ Accept: "application/json" }),
    });
  } catch (e: any) {
    const msg = String(e?.detail || e?.message || "");
    if (e?.status === 405 || /method not allowed/i.test(msg)) {
      try {
        return await postAsDelete(base);
      } catch {
        /* ниже ещё один фоллбек */
      }
      return req<{ ok: true }>(`${base}/delete`, {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: "{}",
      });
    }
    throw e;
  }
}

// Явно запрещаем кэш и приводим ответ к единому виду
export async function getPublicPlaylistByHandle(handle: string) {
  const clean = handle.replace(/^@/, "").toLowerCase();
  return req<Playlist>(
    `/api/playlists/by-handle/${encodeURIComponent(clean)}`,
    {
      method: "GET",
      headers: authHeaders({
        Accept: "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      }),
    } as RequestInit
  );
}

/** Список треков публичного плейлиста по хэндлу */
export async function getPublicPlaylistItemsByHandle(
  handle: string,
  limit = 50,
  offset = 0
) {
  const clean = handle.replace(/^@/, "").toLowerCase();
  const bust = `_=${Date.now()}`; // cache-buster
  return req<{
    items: (Track & { position: number; added_at: string })[];
    limit: number;
    offset: number;
    total: number;
  }>(
    `/api/playlists/by-handle/${encodeURIComponent(
      clean
    )}/items?limit=${limit}&offset=${offset}&${bust}`,
    {
      method: "GET",
      headers: authHeaders({
        Accept: "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      }),
    } as RequestInit
  );
}

// Вытаскиваем id из любых возможных форматов ответа
async function resolvePlaylistIdFromHandle(
  handle: string
): Promise<string | null> {
  try {
    const pl: any = await getPublicPlaylistByHandle(handle);
    const candidates = [
      pl?.id,
      pl?.playlist_id,
      pl?.playlistId,
      pl?.playlist?.id,
      pl?.data?.id,
    ];
    const found = candidates.find(
      (v) => v !== undefined && v !== null && String(v).length > 0
    );
    return found != null ? String(found) : null;
  } catch {
    return null;
  }
}

export async function removeItemFromPublicPlaylistByHandle(
  handle: string,
  t: Pick<Track, "id" | "msgId" | "chat">
) {
  const clean = handle.replace(/^@/, "").toLowerCase();
  const qs = (s: string) => encodeURIComponent(String(s));
  let lastErr: any;
  const trackId = t?.id;
  const msgId = t?.msgId != null ? String(t.msgId) : null;
  const chat = (t?.chat || "").replace(/^@/, "");

  const baseByHandle = `/api/playlists/by-handle/${qs(clean)}`;

  // 1) СНАЧАЛА пробуем по msg_id+chat
  if (msgId && chat) {
    try {
      return await req<{ ok: true }>(
        `${baseByHandle}/items/by-msg/${qs(msgId)}?chat=${qs(chat)}`,
        { method: "DELETE", headers: authHeaders() }
      );
    } catch (e) {
      lastErr = e;
    }

    try {
      return await req<{ ok: true }>(
        `${baseByHandle}/items?msg_id=${qs(msgId)}&chat=${qs(chat)}`,
        { method: "DELETE", headers: authHeaders() }
      );
    } catch (e: any) {
      lastErr = e;
      if (
        e?.status === 405 ||
        /method not allowed/i.test(String(e?.detail || e?.message || ""))
      ) {
        try {
          return await req<{ ok: true }>(
            `${baseByHandle}/items?msg_id=${qs(msgId)}&chat=${qs(chat)}`,
            {
              method: "POST",
              headers: authHeaders({ "X-HTTP-Method-Override": "DELETE" }),
              body: "{}",
            }
          );
        } catch (ee) {
          lastErr = ee;
        }
      }
    }

    try {
      return await req<{ ok: true }>(`${baseByHandle}/items/remove`, {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify({ msg_id: Number(msgId), chat }),
      });
    } catch (e) {
      lastErr = e;
    }
  }

  // 2) Потом — по track_id
  if (trackId) {
    try {
      return await req<{ ok: true }>(`${baseByHandle}/items/${qs(trackId)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch (e) {
      lastErr = e;
    }

    try {
      return await req<{ ok: true }>(
        `${baseByHandle}/items?track_id=${qs(trackId)}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        }
      );
    } catch (e: any) {
      lastErr = e;
      if (
        e?.status === 405 ||
        /method not allowed/i.test(String(e?.detail || e?.message || ""))
      ) {
        try {
          return await req<{ ok: true }>(
            `${baseByHandle}/items?track_id=${qs(trackId)}`,
            {
              method: "POST",
              headers: authHeaders({ "X-HTTP-Method-Override": "DELETE" }),
              body: "{}",
            }
          );
        } catch (ee) {
          lastErr = ee;
        }
      }
    }

    try {
      return await req<{ ok: true }>(`${baseByHandle}/items/remove`, {
        method: "POST",
        headers: authHeaders({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify({ track_id: trackId }),
      });
    } catch (e) {
      lastErr = e;
    }
  }

  // 3) Фолбэк: резолвим id и снова пробуем
  const id = await resolvePlaylistIdFromHandle(clean);
  if (id) {
    if (msgId && chat) {
      try {
        return await removeItemFromPlaylistByMsg(id, msgId, chat);
      } catch (e) {
        lastErr = e;
      }
    }
    if (trackId) {
      try {
        return await removeItemFromPlaylist(id, trackId);
      } catch (e) {
        lastErr = e;
      }
    }
  }

  throw lastErr || new Error("Failed to remove item from public playlist");
}

/* ======================= ЛОКАЛЬНЫЙ ПЛЕЙЛИСТ ======================= */
const LOCAL_KEY = "ogma_playlist_v1";

function readLocal(): Track[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveLocal(list: Track[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  } finally {
    // уведомим подписчиков (PlaylistPage уже слушает это событие)
    window.dispatchEvent(new Event("ogma:playlist-change" as any));
  }
}

export function getPlaylist(): Track[] {
  return readLocal();
}
export function inPlaylist(id: string): boolean {
  return readLocal().some((t) => t?.id === id);
}
export function addToPlaylist(t: Track): { added: boolean; list: Track[] } {
  const list = readLocal();
  const exists = list.findIndex((x) => x?.id === t.id);
  if (exists !== -1) {
    const [item] = list.splice(exists, 1);
    list.unshift(item);
    saveLocal(list);
    return { added: false, list };
  }
  list.unshift(t);
  saveLocal(list);
  return { added: true, list };
}
export function removeFromPlaylist(id: string) {
  const list = readLocal().filter((t) => t?.id !== id);
  saveLocal(list);
}

/* ======================= МОЙ ЛИЧНЫЙ ПЛЕЙЛИСТ (сервер) ======================= */

// форма ответа GET /me/playlist
type MyPlaylistResp = {
  items: (Track & { added_at?: string })[];
  limit: number;
  offset: number;
  total: number;
  rev?: string;
};

export async function getMyPersonalPlaylist(limit = 2000, offset = 0) {
  // без кэша, с куками
  return req<MyPlaylistResp>(`/api/me/playlist?limit=${limit}&offset=${offset}`, {
    method: "GET",
    headers: authHeaders({
      Accept: "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    }),
  } as RequestInit);
}

export async function addItemToMyPersonalPlaylist(trackId: string) {
  return req<{ ok: true; track_id: string }>(`/api/me/playlist/items`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ track_id: trackId }),
  });
}

export async function removeItemFromMyPersonalPlaylist(trackId: string) {
  const tid = encodeURIComponent(trackId);
  return req<{ ok: true }>(`/api/me/playlist/items/${tid}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

/** Открыть SSE-стрим личного плейлиста. Клиент обязан закрыть его сам. */
export function openMyPlaylistEventSource(onEvent: (kind: "hello" | "changed") => void) {
  // Важно: используем withCredentials, чтобы прошли cookies-сессии
  const es = new (window as any).EventSource("/api/me/playlist/stream", {
    withCredentials: true,
  }) as EventSource;

  // Именованные события "playlist"
  es.addEventListener("playlist", (e: MessageEvent) => {
    const data = String(e?.data || "");
    const kind: "hello" | "changed" = data === "hello" ? "hello" : "changed";
    try { onEvent(kind); } catch {}
  });

  // Браузер также шлёт message на безымянное событие — не используем.

  return es;
}

/**
 * Синхронизация локального плейлиста с сервером:
 * - Если сервер пуст и локально есть элементы — пушим все локальные (миграция 1-го запуска).
 * - Затем приводим локальное состояние к серверному (источник правды — сервер),
 *   добавляя локальные "уникальные" хвостом (на случай оффлайна).
 * - Мердж по id, без дублей; отображение дубликатов по названию решает UI-хук.
 */
export async function syncPlaylistWithServer(): Promise<void> {
  const local = readLocal();

  // читаем сервер
  let server: Track[] = [];
  let total = 0;
  try {
    const r = await getMyPersonalPlaylist(4000, 0);
    server = (r?.items || []) as Track[];
    total = r?.total ?? server.length;
  } catch {
    return; // оффлайн — ничего не делаем
  }

  // 1) всегда пушим локальные, которых нет на сервере
  const serverIds = new Set(server.map((t) => t.id).filter(Boolean));
  const toPush = local.filter((t) => t?.id && !serverIds.has(t.id));
  for (const t of toPush) {
    try { await addItemToMyPersonalPlaylist(t.id!); } catch {}
  }

  // 2) перечитать сервер (на случай, если что-то не допушилось — просто возьмём то, что есть)
  try {
    const r2 = await getMyPersonalPlaylist(4000, 0);
    server = (r2?.items || []) as Track[];
    total  = r2?.total ?? server.length;
  } catch {}

  // 3) собрать локальный state: сервер (источник правды) + локальные «хвостом» без дублей
  const seen = new Set<string>();
  const next: Track[] = [];
  for (const t of server) { if (t?.id && !seen.has(t.id)) { seen.add(t.id); next.push(t); } }
  for (const t of local)  { if (t?.id && !seen.has(t.id)) { seen.add(t.id); next.push(t); } }

  saveLocal(next);
}

/* ======================= ПРОВЕРКА НАЛИЧИЯ ТРЕКА В СЕРВЕРНОМ ПЛЕЙЛИСТЕ ======================= */

// надёжная проверка наличия трека в серверном плейлисте
export async function hasTrackInPlaylist(
  playlistId: string,
  trackId: string
): Promise<boolean> {
  const pid = encodeURIComponent(playlistId);
  const tid = encodeURIComponent(trackId);

  const tryReq = async <T = any>(url: string) => {
    try {
      return await req<T>(url, { method: "GET", headers: authHeaders() });
    } catch (e: any) {
      if (e?.status === 404) return null;
      if (e?.status === 405) return null;
      throw e;
    }
  };

  // 1) универсальный фильтр
  const r1 = await tryReq<{ items?: any[]; total?: number }>(
    `/api/playlists/${pid}/items?track_id=${tid}&limit=1`
  );
  if (r1) {
    if (Array.isArray(r1.items)) return r1.items.length > 0;
    if (typeof r1.total === "number") return r1.total > 0;
  }

  // 2) алиасы
  const r2 = await tryReq<{ contains?: boolean }>(
    `/api/playlists/${pid}/items/contains?track_id=${tid}`
  );
  if (r2 && typeof (r2 as any).contains === "boolean")
    return !!(r2 as any).contains;

  const r3 = await tryReq<{ contains?: boolean }>(
    `/api/playlists/${pid}/contains?track_id=${tid}`
  );
  if (r3 && typeof (r3 as any).contains === "boolean")
    return !!(r3 as any).contains;

  const r4 = await tryReq<{ has?: boolean }>(
    `/api/playlists/${pid}/has?track_id=${tid}`
  );
  if (r4 && typeof (r4 as any).has === "boolean") return !!(r4 as any).has;

  return false;
}