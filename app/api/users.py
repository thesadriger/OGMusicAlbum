# /home/ogma/ogma/app/api/users.py
"""
Роутер пользовательских эндпоинтов (FastAPI):
- Аутентификация через Telegram WebApp initData (или debug-заголовки в dev)
- Работа с пользователями/контактами
- UI preferences (чтение/запись)
- Глобальный поиск плейлиста по handle
- Базовые счётчики (favorites/plays)

Предполагается, что пул БД (asyncpg.Pool) уже инициализирован в app.state.pool
в вашем main.py на старте приложения.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any, Dict, List, Optional, Tuple, Set

import asyncpg
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status, Response
from pydantic import BaseModel
from urllib.parse import parse_qsl

from starlette.responses import StreamingResponse

# ---------------------------------------------------------------------------
# Константы и настройки из окружения
# ---------------------------------------------------------------------------

router = APIRouter()

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "") or os.environ.get("BOT_TOKEN", "")
ALLOW_DEBUG = os.environ.get("ALLOW_DEBUG_HEADERS", "0").lower() in {"1", "true", "yes"}
TG_AUTH_MAX_AGE = int(
    os.environ.get("TG_AUTH_MAX_AGE", "86400")
)  # по умолчанию 24 часа
ALLOWED_UI_PREF_KEYS = {"headerBgKey", "trackBgMode", "trackBgKey", "appBg"}


# ---------------------------------------------------------------------------
# Кэш для /api/search (in-proc, per-worker)
# ---------------------------------------------------------------------------
_SEARCH_CACHE_TTL = int(os.environ.get("SEARCH_CACHE_TTL", "30"))  # сек
_SEARCH_CACHE_MAX = int(os.environ.get("SEARCH_CACHE_MAX", "1000"))  # записей
_SEARCH_CACHE: Dict[Tuple[str, int], Tuple[float, Dict[str, Any]]] = {}


def _search_cache_get(key: Tuple[str, int]) -> Optional[Dict[str, Any]]:
    hit = _SEARCH_CACHE.get(key)
    if not hit:
        return None
    ts, val = hit
    if (time.time() - ts) > _SEARCH_CACHE_TTL:
        _SEARCH_CACHE.pop(key, None)
        return None
    return val


def _search_cache_put(key: Tuple[str, int], val: Dict[str, Any]) -> None:
    if len(_SEARCH_CACHE) >= _SEARCH_CACHE_MAX:
        # простой выброс самого "старого" по порядку вставки
        try:
            _SEARCH_CACHE.pop(next(iter(_SEARCH_CACHE)))
        except Exception:
            _SEARCH_CACHE.clear()
    _SEARCH_CACHE[key] = (time.time(), val)


# ---------------------------------------------------------------------------
# Вспомогательные функции: валидация Telegram initData
# ---------------------------------------------------------------------------


def _extract_pairs(init_data: str) -> Dict[str, str]:
    """Парсим initData в пары ключ/значение, проверяем наличие hash."""
    pairs = dict(parse_qsl(init_data, keep_blank_values=True, encoding="utf-8"))
    if "hash" not in pairs:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing hash")
    return pairs


def _build_data_check_string(pairs: Dict[str, str]) -> str:
    """Строим Data Check String: key=value по всем полям, кроме 'hash', сортировка по ключу."""
    items = [f"{k}={pairs[k]}" for k in sorted(k for k in pairs.keys() if k != "hash")]
    return "\n".join(items)


def _secret_webapp(bot_token: str) -> bytes:
    """Секрет для WebApp: HMAC_SHA256(key='WebAppData', msg=bot_token)."""
    return hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()


def _secret_login_widget(bot_token: str) -> bytes:
    """Секрет для классического Login Widget: SHA256(bot_token)."""
    return hashlib.sha256(bot_token.encode("utf-8")).digest()


def _verify_signature(secret: bytes, dcs: str, received_hash_hex: str) -> bool:
    """Сравниваем HMAC(dcs) с присланным hash, тайминг-сейф сравнение."""
    calc = hmac.new(secret, dcs.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(calc, received_hash_hex.lower())


def _verify_webapp_init_data(init_data: str) -> Dict[str, Any]:
    """
    Валидация Telegram initData (WebApp/mini-app).
    Совместимо и с Login Widget, но основной вариант — WebApp secret.
    Возвращает dict пользователя (payload user).
    """
    if not BOT_TOKEN:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Server auth is not configured"
        )

    pairs = _extract_pairs(init_data)
    received_hash = pairs["hash"]
    dcs = _build_data_check_string(pairs)

    ok = _verify_signature(
        _secret_webapp(BOT_TOKEN), dcs, received_hash
    ) or _verify_signature(_secret_login_widget(BOT_TOKEN), dcs, received_hash)
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bad auth signature")

    # Свежесть auth_date
    try:
        auth_date = int(pairs.get("auth_date", "0"))
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bad auth_date")
    now_ts = int(time.time())
    if auth_date <= 0 or (now_ts - auth_date) > TG_AUTH_MAX_AGE:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Auth data expired")

    # Поле user приходит JSON-ом
    try:
        user = json.loads(pairs.get("user", "{}"))
        if not isinstance(user, dict):
            raise ValueError
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid user payload")

    return user


# ---------------------------------------------------------------------------
# Доступ к пулу БД
# ---------------------------------------------------------------------------


async def _get_pool(req: Request) -> asyncpg.Pool:
    """Достаём пул соединений из app.state (инициализируется в main.py)."""
    pool = getattr(req.app.state, "pool", None)
    if not pool:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "DB pool not ready")
    return pool


# ---------------------------------------------------------------------------
# Мягкие миграции "на лету" (idempotent) — создают таблицы/индексы при первом обращении
# ---------------------------------------------------------------------------


async def _ensure_users_table(pool: asyncpg.Pool) -> None:
    """
    Создание базовых таблиц пользователей/контактов/настроек.
    В проде стоит использовать нормальные миграции (Alembic), но здесь — безопасный fallback.
    """
    ddl = """
    create table if not exists users(
      telegram_id     bigint primary key,
      username        text,
      name            text,
      photo_url       text,
      is_discoverable boolean default false,
      created_at      timestamptz default now()
    );

    create table if not exists user_contacts(
      user_id     bigint not null,
      contact_tid bigint not null,
      primary key (user_id, contact_tid)
    );

    create table if not exists user_settings(
      user_id    bigint primary key references users(telegram_id) on delete cascade,
      data       jsonb not null default '{}'::jsonb,
      updated_at timestamptz default now()
    );

    create index if not exists user_settings_gin on user_settings using gin (data);
    -- Индекс для быстрых case-insensitive запросов по username
    create index if not exists users_username_ci on users (lower(username));
    """
    try:
        async with pool.acquire() as con:
            await con.execute(ddl)
    except Exception:
        # В проде это нужно логировать; здесь не валим запрос
        pass


async def _ensure_ui_prefs_table(pool: asyncpg.Pool) -> None:
    """Таблица пользовательских UI-настроек (jsonb)."""
    ddl = """
    create table if not exists user_ui_prefs(
        user_id    bigint primary key references users(telegram_id) on delete cascade,
        ui_prefs   jsonb not null default '{}'::jsonb,
        updated_at timestamptz default now()
    );
    """
    try:
        async with pool.acquire() as con:
            await con.execute(ddl)
    except Exception:
        pass


async def _ensure_playlists_table(pool: asyncpg.Pool) -> None:
    """
    Таблица плейлистов с глобальными хэндлами.
    Приводим схему к актуальному виду: uuid, user_id, публичность и updated_at.
    """
    ddl = """
    create extension if not exists pgcrypto;

    create table if not exists playlists(
        id         uuid primary key default gen_random_uuid(),
        user_id    bigint not null references users(telegram_id) on delete cascade,
        title      text,
        description text,
        cover_url  text,
        handle     text,
        is_public  boolean not null default false,
        kind       text not null default 'custom',
        created_at timestamptz default now(),
        updated_at timestamptz default now()
    );

    alter table playlists alter column id set default gen_random_uuid();
    alter table playlists alter column handle drop not null;

    do $$
    begin
        if exists (
            select 1 from information_schema.columns
            where table_name = 'playlists' and column_name = 'owner_id'
        ) and not exists (
            select 1 from information_schema.columns
            where table_name = 'playlists' and column_name = 'user_id'
        ) then
            alter table playlists rename column owner_id to user_id;
        end if;
    end $$;

    alter table playlists add column if not exists user_id bigint references users(telegram_id) on delete cascade;
    alter table playlists add column if not exists title text;
    alter table playlists add column if not exists description text;
    alter table playlists add column if not exists cover_url text;
    alter table playlists add column if not exists handle text;
    alter table playlists add column if not exists is_public boolean not null default false;
    alter table playlists add column if not exists kind text not null default 'custom';
    alter table playlists add column if not exists updated_at timestamptz default now();

    alter table playlists alter column user_id set not null;

    create unique index if not exists playlists_handle_ci
        on playlists (lower(handle))
        where handle is not null;
    create index if not exists playlists_user_idx on playlists (user_id);
    create index if not exists playlists_public_updated_idx on playlists (is_public, updated_at desc);
    """
    try:
        async with pool.acquire() as con:
            await con.execute(ddl)
    except Exception:
        pass

async def _ensure_user_playlist_table(pool: asyncpg.Pool) -> None:
    """
    Личный плейлист пользователя: одна таблица со связью user_id -> track_id.
    Idempotent insert (unique user_id+track_id).
    """
    ddl = """
    create table if not exists user_playlist_items(
      user_id   bigint not null references users(telegram_id) on delete cascade,
      track_id  uuid   not null references tracks(id) on delete cascade,
      position  int    not null default 0,     -- зарезервировано, можно не использовать
      added_at  timestamptz default now(),
      primary key (user_id, track_id)
    );
    create index if not exists user_playlist_added_idx on user_playlist_items (user_id, added_at desc);
    """
    try:
        async with pool.acquire() as con:
            await con.execute(ddl)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# UI prefs: утилиты
# ---------------------------------------------------------------------------


def _sanitize_ui_prefs(p: Dict[str, Any]) -> Dict[str, Any]:
    """
    Очищаем payload UI-настроек:
    - Оставляем только ожидаемые ключи.
    - В appBg сохраняем только метаданные (type/color), никакого base64/dataURL.
    """
    if not isinstance(p, dict):
        return {}

    out: Dict[str, Any] = {k: v for k, v in p.items() if k in ALLOWED_UI_PREF_KEYS}

    app = out.get("appBg")
    if isinstance(app, dict):
        out["appBg"] = {k: v for k, v in app.items() if k in {"type", "color"}}

    return out


async def _read_ui_prefs(pool: asyncpg.Pool, user_id: int) -> Dict[str, Any]:
    """Читаем JSON-настройки пользователя (пустой словарь, если записей нет)."""
    await _ensure_ui_prefs_table(pool)
    row = await pool.fetchval(
        "select ui_prefs from user_ui_prefs where user_id=$1", user_id
    )
    # asyncpg для jsonb возвращает python-объект; но на всякий случай:
    return dict(row) if isinstance(row, dict) else (row or {})


async def _write_ui_prefs(
    pool: asyncpg.Pool, user_id: int, prefs: Dict[str, Any]
) -> None:
    """Сохраняем настройки (upsert), предварительно санитизируя их."""
    await _ensure_ui_prefs_table(pool)
    safe = _sanitize_ui_prefs(prefs)
    await pool.execute(
        """
        insert into user_ui_prefs(user_id, ui_prefs, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (user_id) do update
        set ui_prefs = excluded.ui_prefs,
            updated_at = now()
        """,
        user_id,
        json.dumps(safe),
    )


# ---------------------------------------------------------------------------
# Текущий пользователь
# ---------------------------------------------------------------------------


async def _current_user_id(
    req: Request, pool: asyncpg.Pool = Depends(_get_pool)
) -> int:
    """
    Определение текущего пользователя:
      1) Прод: заголовок X-Telegram-Init-Data (полный initData из WebApp)
      2) Dev:  X-Debug-User-Id (+ X-Debug-Username/Name), если ALLOW_DEBUG_HEADERS=1
               либо если запрос локальный (127.0.0.1/::1/localhost)
    На каждом вызове поддерживаем/создаём пользователя в БД.
    """
    init_data = req.headers.get("x-telegram-init-data")
    if init_data:
        u = _verify_webapp_init_data(init_data)
        tid = int(u["id"])
        username = u.get("username")
        name = (u.get("first_name") or "") + (
            (" " + u.get("last_name")) if u.get("last_name") else ""
        )
        photo = u.get("photo_url")
    elif ALLOW_DEBUG or (
        req.client and req.client.host in ("127.0.0.1", "::1", "localhost")
    ):
        debug_id = req.headers.get("x-debug-user-id")
        if not debug_id:
            # Явный dev-режим — объясняем, что надо передать id; иначе просто 401
            detail = "No auth (debug id missing)" if ALLOW_DEBUG else "No auth"
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail)
        tid = int(debug_id)
        username = req.headers.get("x-debug-username")
        name = req.headers.get("x-debug-name") or (username or f"user_{tid}")
        photo = None
    else:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No auth")

    # ensure schema + upsert user
    await _ensure_users_table(pool)
    await pool.execute(
        """
        insert into users(telegram_id, username, name, photo_url)
        values ($1,$2,$3,$4)
        on conflict (telegram_id) do update
        set username   = coalesce(excluded.username, users.username),
            name       = coalesce(excluded.name, users.name),
            photo_url  = coalesce(excluded.photo_url, users.photo_url)
        """,
        tid,
        username,
        name,
        photo,
    )
    return tid


# ---------------------------------------------------------------------------
# Схемы запросов/ответов
# ---------------------------------------------------------------------------


class DiscoverableBody(BaseModel):
    value: bool


class ImportContactsBody(BaseModel):
    user_ids: Optional[List[int]] = None
    usernames: Optional[List[str]] = None


# ---------------------------------------------------------------------------
# Эндпоинты
# ---------------------------------------------------------------------------


@router.get("/me")
async def me(
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """
    Текущий пользователь + простая статистика (favorites/play).
    """
    user = await pool.fetchrow(
        """
        select telegram_id, username, name, photo_url, is_discoverable, created_at
        from users where telegram_id=$1
        """,
        user_id,
    )
    favs = (
        await pool.fetchval("select count(*) from favorites where user_id=$1", user_id)
        or 0
    )
    plays = (
        await pool.fetchval(
            "select count(*) from history where user_id=$1 and action::text='play'",
            user_id,
        )
        or 0
    )
    return {
        "user": dict(user) if user else {"telegram_id": user_id},
        "stats": {"favorites": favs, "plays": plays},
    }


@router.get("/me/favorites")
async def get_favorites(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """
    Список избранного пользователя (пагинация).
    """
    rows = await pool.fetch(
        """
        select t.id::text, t.tg_msg_id as "msgId", t.chat_username as chat,
               t.title, t.artists, t.hashtags, t.duration_s as duration, t.mime, f.ts
        from favorites f
        join tracks t on t.id = f.track_id
        where f.user_id = $1
        order by f.ts desc
        limit $2 offset $3
        """,
        user_id,
        limit,
        offset,
    )
    total = await pool.fetchval(
        "select count(*) from favorites where user_id=$1", user_id
    )
    return {
        "items": [dict(r) for r in rows],
        "limit": limit,
        "offset": offset,
        "total": total,
    }


@router.post("/me/favorites/{track_id}")
async def add_favorite(
    track_id: str,
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """
    Добавить трек в избранное (id — UUID). Также логируем событие в history.
    """
    ok = await pool.fetchval("select 1 from tracks where id=$1::uuid", track_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Track not found")

    await pool.execute(
        "insert into favorites(user_id, track_id) values ($1, $2::uuid) on conflict do nothing",
        user_id,
        track_id,
    )
    await pool.execute(
        "insert into history(user_id, track_id, action) values ($1, $2::uuid, 'save')",
        user_id,
        track_id,
    )
    return {"ok": True}


@router.delete("/me/favorites/{track_id}")
async def remove_favorite(
    track_id: str,
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """Удалить трек из избранного."""
    await pool.execute(
        "delete from favorites where user_id=$1 and track_id=$2::uuid",
        user_id,
        track_id,
    )
    return {"ok": True}


@router.get("/me/recs")
async def my_recommendations(
    limit: int = Query(30, ge=1, le=50),
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """
    Рекомендации: микс по топ-артистам пользователя + свежие треки, исключая избранное и недавние.
    """
    # исключаем уже сохранённые/игранные
    ex_rows = await pool.fetch(
        """
        select track_id::text from favorites where user_id=$1
        union
        select track_id::text from history where user_id=$1 and action::text in ('play','save')
        """,
        user_id,
    )
    exclude = {r["track_id"] for r in ex_rows}

    # верхние артисты пользователя
    arts = await pool.fetch(
        """
        with fav_art as (
            select unnest(t.artists) a
            from favorites f join tracks t on t.id = f.track_id
            where f.user_id=$1
        ),
        play_art as (
            select unnest(t.artists) a
            from history h join tracks t on t.id = h.track_id
            where h.user_id=$1 and h.action::text in ('play','save')
        )
        select lower(a) artist, count(*) cnt
        from (select a from fav_art union all select a from play_art) s
        group by 1
        order by cnt desc
        limit 5
        """,
        user_id,
    )
    top_artists = [r["artist"] for r in arts]

    items: List[Dict[str, Any]] = []
    if top_artists:
        per_bucket = max(3, min(10, limit // max(1, len(top_artists)) + 2))
        buckets: List[List[Dict[str, Any]]] = []
        for a in top_artists:
            rows = await pool.fetch(
                """
                select id::text, tg_msg_id as "msgId", chat_username as chat,
                       title, artists, hashtags, duration_s as duration, mime, created_at
                from tracks
                where exists (select 1 from unnest(artists) x where lower(x)=lower($1))
                order by created_at desc
                limit $2
                """,
                a,
                per_bucket * 4,
            )
            buckets.append([dict(r) for r in rows if r["id"] not in exclude])

        # round-robin по корзинам
        for idx in range(per_bucket * 4):
            for lst in buckets:
                if len(items) >= limit:
                    break
                if idx < len(lst):
                    rec = dict(lst[idx])
                    rec["reason"] = "artist"
                    items.append(rec)
            if len(items) >= limit:
                break

    # fallback — просто новые
    if len(items) < limit:
        rows = await pool.fetch(
            """
            select id::text, tg_msg_id as "msgId", chat_username as chat,
                   title, artists, hashtags, duration_s as duration, mime, created_at
            from tracks
            order by created_at desc
            limit $1
            """,
            limit * 2,
        )
        for r in rows:
            if len(items) >= limit:
                break
            if r["id"] in exclude:
                continue
            rec = dict(r)
            rec["reason"] = "new"
            items.append(rec)

    return {"items": items[:limit], "limit": limit}

# ----------------------- Personal playlist (per-user) -----------------------

# простейший локальный broadcaster для SSE: user_id -> набор очередей
_PLAYLIST_SUBS: Dict[int, Set[asyncio.Queue[str]]] = {}

def _broadcast_playlist_changed(user_id: int) -> None:
    qs = _PLAYLIST_SUBS.get(user_id)
    if not qs: return
    for q in list(qs):
        try: q.put_nowait("changed")
        except Exception: pass

@router.get("/me/playlist")
async def get_my_playlist(
    limit: int = Query(1000, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    await _ensure_users_table(pool)
    await _ensure_user_playlist_table(pool)

    rows = await pool.fetch(
        """
        select t.id::text, t.tg_msg_id as "msgId", t.chat_username as chat,
               t.title, t.artists, t.hashtags, t.duration_s as duration, t.mime, u.added_at
        from user_playlist_items u
        join tracks t on t.id = u.track_id
        where u.user_id = $1
        order by u.added_at desc
        limit $2 offset $3
        """,
        user_id, limit, offset,
    )
    total = await pool.fetchval("select count(*) from user_playlist_items where user_id=$1", user_id)
    # простейшая ревизия — время последней вставки/удаления
    rev = await pool.fetchval("select coalesce(max(added_at), now()) from user_playlist_items where user_id=$1", user_id)
    return {"items": [dict(r) for r in rows], "limit": limit, "offset": offset, "total": total, "rev": str(rev)}

class AddItemBody(BaseModel):
    track_id: Optional[str] = None

@router.post("/me/playlist/items")
async def add_my_playlist_item(
    body: AddItemBody,
    track_id: Optional[str] = Query(default=None),
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    await _ensure_users_table(pool)
    await _ensure_user_playlist_table(pool)

    tid = (track_id or body.track_id or "").strip()
    if not tid:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "track_id required")

    ok = await pool.fetchval("select 1 from tracks where id=$1::uuid", tid)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Track not found")

    await pool.execute(
        """
        insert into user_playlist_items(user_id, track_id, added_at)
        values ($1, $2::uuid, now())
        on conflict (user_id, track_id) do update
        set added_at = greatest(user_playlist_items.added_at, excluded.added_at)
        """,
        user_id, tid
    )

    _broadcast_playlist_changed(user_id)
    return {"ok": True, "track_id": tid}

@router.delete("/me/playlist/items/{track_id}")
async def remove_my_playlist_item(
    track_id: str,
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    await _ensure_user_playlist_table(pool)
    await pool.execute("delete from user_playlist_items where user_id=$1 and track_id=$2::uuid", user_id, track_id)
    _broadcast_playlist_changed(user_id)
    return {"ok": True}


# ----------------------- UI preferences -----------------------


@router.get("/me/ui-prefs")
@router.get("/me/prefs")  # backwards-compat alias
async def get_my_ui_prefs(
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """Мои UI-настройки."""
    prefs = await _read_ui_prefs(pool, user_id)
    return {"ui_prefs": prefs, "user_id": user_id}


@router.put("/me/ui-prefs")
@router.post("/me/ui-prefs")
@router.put("/me/prefs")
@router.post("/me/prefs")
async def put_my_ui_prefs(
    req: Request,
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """
    Сохранение UI-настроек.
    Принимает либо {"ui_prefs": {...}}, либо просто {...}.
    """
    try:
        payload = await req.json()
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bad JSON")

    if not isinstance(payload, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bad JSON")

    prefs = payload.get("ui_prefs", payload)
    if not isinstance(prefs, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bad ui_prefs")

    await _write_ui_prefs(pool, user_id, prefs)
    return {"ok": True, "ui_prefs": await _read_ui_prefs(pool, user_id)}


@router.get("/users/{other_id}/ui-prefs")
async def get_user_ui_prefs_by_id(
    other_id: int,
    _viewer_id: int = Depends(
        _current_user_id
    ),  # авторизация обязательна, но viewer_id дальше не используется
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """Публичное чтение UI-настроек по telegram_id пользователя."""
    await _ensure_users_table(pool)
    await _ensure_ui_prefs_table(pool)

    exists = await pool.fetchval("select 1 from users where telegram_id=$1", other_id)
    if not exists:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    prefs = await _read_ui_prefs(pool, other_id)
    return {"user_id": other_id, "ui_prefs": prefs}


@router.get("/users/by-username/{username}/ui-prefs")
async def get_user_ui_prefs_by_username(
    username: str,
    _viewer_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """Публичное чтение UI-настроек по username (регистронезависимо)."""
    await _ensure_users_table(pool)
    row = await pool.fetchrow(
        "select telegram_id from users where lower(username)=lower($1)",
        username,
    )
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    uid = int(row["telegram_id"])
    prefs = await _read_ui_prefs(pool, uid)
    return {"user_id": uid, "ui_prefs": prefs}


# ----------------------- Consent / Contacts -----------------------


@router.post("/consent/discoverable")
async def set_discoverable(
    body: DiscoverableBody,
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """Согласие пользователя быть видимым в поиске/подсказках."""
    await pool.execute(
        "update users set is_discoverable=$2 where telegram_id=$1",
        user_id,
        body.value,
    )
    return {"ok": True, "is_discoverable": body.value}


@router.post("/contacts/import")
async def import_contacts(
    body: ImportContactsBody,
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """
    Импорт контактов по списку telegram_id и/или username'ов (username -> id по нашей БД).
    Дубликаты игнорируются (on conflict do nothing).
    """
    to_add: set[int] = set()

    # По id
    if body.user_ids:
        for x in body.user_ids:
            try:
                tid = int(x)
                if tid > 0 and tid != user_id:
                    to_add.add(tid)
            except Exception:
                pass

    # По username
    if body.usernames:
        ulist = [u.lower() for u in body.usernames if u]
        if ulist:
            rows = await pool.fetch(
                "select telegram_id from users where lower(username) = any($1::text[])",
                ulist,
            )
            for r in rows:
                tid = int(r["telegram_id"])
                if tid > 0 and tid != user_id:
                    to_add.add(tid)

    if to_add:
        await pool.executemany(
            "insert into user_contacts(user_id, contact_tid) values ($1,$2) on conflict do nothing",
            [(user_id, tid) for tid in to_add],
        )

    total = await pool.fetchval(
        "select count(*) from user_contacts where user_id=$1", user_id
    )
    return {"added": len(to_add), "total": total}


@router.get("/contacts")
async def get_contacts(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    suggest: bool = Query(
        False, description="если true — показать всех discoverable, а не только моих"
    ),
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """
    Список контактов пользователя, либо глобальные предложения (suggest=True).
    """
    if suggest:
        rows = await pool.fetch(
            """
            select
              u.telegram_id, u.username, u.name, u.photo_url, u.created_at,
              false as is_mutual
            from users u
            where u.is_discoverable = true and u.telegram_id <> $1
            order by u.created_at desc
            limit $2 offset $3
            """,
            user_id,
            limit,
            offset,
        )
        total = await pool.fetchval(
            """
            select count(*) from users u
            where u.is_discoverable = true and u.telegram_id <> $1
            """,
            user_id,
        )
    else:
        rows = await pool.fetch(
            """
            select
              u.telegram_id, u.username, u.name, u.photo_url, u.created_at,
              exists (
                select 1
                from user_contacts c2
                where c2.user_id = u.telegram_id and c2.contact_tid = $1
              ) as is_mutual
            from user_contacts c
            join users u on u.telegram_id = c.contact_tid
            where c.user_id = $1 and u.is_discoverable = true
            order by (u.username is null) asc, u.username asc nulls last, u.name asc nulls last
            limit $2 offset $3
            """,
            user_id,
            limit,
            offset,
        )
        total = await pool.fetchval(
            """
            select count(*)
            from user_contacts c
            join users u on u.telegram_id = c.contact_tid
            where c.user_id = $1 and u.is_discoverable = true
            """,
            user_id,
        )

    return {
        "items": [dict(r) for r in rows],
        "limit": limit,
        "offset": offset,
        "total": total,
    }


@router.get("/contacts/mutual")
async def get_contacts_mutual(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """Взаимные контакты (есть связь в обе стороны)."""
    rows = await pool.fetch(
        """
        select u.telegram_id, u.username, u.name, u.photo_url, u.created_at, true as is_mutual
        from user_contacts c1
        join user_contacts c2
          on c2.user_id = c1.contact_tid and c2.contact_tid = c1.user_id
        join users u on u.telegram_id = c1.contact_tid
        where c1.user_id = $1 and u.is_discoverable = true
        order by (u.username is null) asc, u.username asc nulls last, u.name asc nulls last
        limit $2 offset $3
        """,
        user_id,
        limit,
        offset,
    )
    total = await pool.fetchval(
        """
        select count(*)
        from user_contacts c1
        join user_contacts c2
          on c2.user_id = c1.contact_tid and c2.contact_tid = c1.user_id
        join users u on u.telegram_id = c1.contact_tid
        where c1.user_id = $1 and u.is_discoverable = true
        """,
        user_id,
    )
    return {
        "items": [dict(r) for r in rows],
        "limit": limit,
        "offset": offset,
        "total": total,
    }


# ----------------------- Глобальный поиск плейлиста по handle -----------------------


@router.get("/playlists/by-handle/{handle}")
async def get_playlist_by_handle(
    handle: str,
    _viewer_id: int = Depends(
        _current_user_id
    ),  # авторизация обязательна (как и для профилей)
    pool: asyncpg.Pool = Depends(_get_pool),
):
    """
    Регистронезависимый поиск плейлиста по хэндлу.
    Возвращаем сам плейлист + UI prefs владельца (чтобы фронт сразу знал оформление).
    """
    await _ensure_users_table(pool)
    await _ensure_playlists_table(pool)

    row = await pool.fetchrow(
        """
        select p.id::text,
               p.user_id,
               p.handle,
               p.title,
               p.description,
               p.cover_url,
               p.created_at,
               p.updated_at,
               p.is_public
        from playlists p
        where p.is_public = true
          and lower(p.handle) = lower($1)
        """,
        handle,
    )
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Playlist not found")

    owner_id = int(row["user_id"])
    owner_prefs = await _read_ui_prefs(pool, owner_id)

    payload = dict(row)
    payload.setdefault("owner_id", owner_id)
    payload.setdefault("user_id", owner_id)

    return {
        "playlist": payload,
        "owner": {"telegram_id": owner_id},
        "owner_ui_prefs": owner_prefs,
    }


# ----------------------- Универсальный поиск: @username / @handle -----------------------


@router.get("/search/universal")
async def universal_search(
    q: str = Query(..., min_length=1, description="Строка вида @username или @handle"),
    limit: int = Query(
        10, ge=1, le=50, description="Сколько подсказок вернуть на категорию"
    ),
    _viewer_id: int = Depends(_current_user_id),  # требуем авторизацию
    pool: asyncpg.Pool = Depends(_get_pool),
):
"""
    Универсальный поиск по строке q (эндпоинт /api/search/universal):
      - если начинается с '@' — это ок, снимем префикс и нормализуем;
      - ищем точное совпадение user.username и playlist.handle (lower(...) = lower($1));
      - если точных совпадений нет/мало — даём короткие списки по префиксу (autocomplete).
    Возвращаем:
      {
        "query": исходная_строка,
        "term": нормализованный_запрос_без_@,
        "primary": {"kind": "user"|"playlist", "data": {...}} | null,
        "users": [...],        # подсказки пользователей
        "playlists": [...]     # подсказки плейлистов
      }
    """
    # нормализация
    term_raw = q.strip()
    term = term_raw[1:].strip() if term_raw.startswith("@") else term_raw
    if not term:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty query")

    # --- кэш по нормализованному терму и лимиту (результат не персонализирован)
    cache_key = (term.lower(), int(limit))
    cached_core = _search_cache_get(cache_key)
    if cached_core is not None:
        # query/term подставляем актуальные из запроса
        return {"query": q, "term": term, **cached_core}

    # гарантируем наличие таблиц
    await _ensure_users_table(pool)
    await _ensure_playlists_table(pool)

    # --- точные совпадения (регистронезависимо)
    user_exact = await pool.fetchrow(
        """
        select telegram_id, username, name, photo_url, is_discoverable, created_at
        from users
        where lower(username) = lower($1)
        """,
        term,
    )

    playlist_exact = await pool.fetchrow(
        """
        select p.id::text          as id,
               p.user_id          as user_id,
               p.handle           as handle,
               p.title            as title,
               p.description      as description,
               p.cover_url        as cover_url,
               p.created_at       as created_at,
               p.updated_at       as updated_at,
               p.is_public        as is_public,
               u.username         as owner_username,
               u.name             as owner_name
        from playlists p
        left join users u on u.telegram_id = p.user_id
        where p.is_public = true
          and p.handle is not null
          and lower(p.handle) = lower($1)
        """,
        term,
    )

    like_pat = term + "%"
    title_pat = "%" + term + "%"

    users_like = await pool.fetch(
        """
        select telegram_id, username, name, photo_url, created_at
        from users
        where username is not null
          and lower(username) like lower($1)
        order by lower(username) asc
        limit $2
        """,
        like_pat,
        limit,
    )

    playlists_handle = await pool.fetch(
        """
        select p.id::text    as id,
               p.user_id     as user_id,
               p.handle      as handle,
               p.title       as title,
               p.description as description,
               p.cover_url   as cover_url,
               p.created_at  as created_at,
               p.updated_at  as updated_at,
               p.is_public   as is_public,
               u.username    as owner_username,
               u.name        as owner_name
        from playlists p
        left join users u on u.telegram_id = p.user_id
        where p.is_public = true
          and p.handle is not null
          and lower(p.handle) like lower($1)
        order by lower(p.handle) asc, p.updated_at desc
        limit $2
        """,
        like_pat,
        limit * 2,
    )

    playlists_title = await pool.fetch(
        """
        select p.id::text    as id,
               p.user_id     as user_id,
               p.handle      as handle,
               p.title       as title,
               p.description as description,
               p.cover_url   as cover_url,
               p.created_at  as created_at,
               p.updated_at  as updated_at,
               p.is_public   as is_public,
               u.username    as owner_username,
               u.name        as owner_name
        from playlists p
        left join users u on u.telegram_id = p.user_id
        where p.is_public = true
          and coalesce(p.title, '') <> ''
          and lower(p.title) like lower($1)
        order by strpos(lower(p.title), lower($1)) asc, p.updated_at desc
        limit $2
        """,
        title_pat,
        limit * 2,
    )

    playlists_owner = await pool.fetch(
        """
        select p.id::text    as id,
               p.user_id     as user_id,
               p.handle      as handle,
               p.title       as title,
               p.description as description,
               p.cover_url   as cover_url,
               p.created_at  as created_at,
               p.updated_at  as updated_at,
               p.is_public   as is_public,
               u.username    as owner_username,
               u.name        as owner_name
        from playlists p
        left join users u on u.telegram_id = p.user_id
        where p.is_public = true
          and u.username is not null
          and lower(u.username) like lower($1)
        order by lower(u.username) asc, p.updated_at desc
        limit $2
        """,
        like_pat,
        limit * 2,
    )

    def _row_to_dict(row: Optional[asyncpg.Record]) -> Dict[str, Any]:
        if not row:
            return {}
        data = dict(row)
        if "user_id" in data:
            data.setdefault("owner_id", data["user_id"])
        return data

    users_out = [_row_to_dict(r) for r in users_like]
    if user_exact:
        user_dict = _row_to_dict(user_exact)
        users_out = [user_dict] + [
            u
            for u in users_out
            if not u.get("username")
            or u["username"].lower() != str(user_dict.get("username", "")).lower()
        ]

    playlists_acc: List[Dict[str, Any]] = []
    seen_ids: Set[str] = set()

    def _push(rows: List[asyncpg.Record]) -> None:
        for r in rows:
            data = _row_to_dict(r)
            pid = str(data.get("id") or "")
            if not pid or pid in seen_ids:
                continue
            if data.get("is_public") is not True:
                continue
            seen_ids.add(pid)
            playlists_acc.append(data)
            if len(playlists_acc) >= limit:
                return

    if playlist_exact:
        _push([playlist_exact])
    if len(playlists_acc) < limit:
        _push(list(playlists_handle))
    if len(playlists_acc) < limit:
        _push(list(playlists_title))
    if len(playlists_acc) < limit:
        _push(list(playlists_owner))

    # Выберем primary: по UX логике сперва user, потом playlist
    primary = None
    if user_exact and not playlist_exact:
        primary = {"kind": "user", "data": _row_to_dict(user_exact)}
    elif playlist_exact and not user_exact:
        primary = {"kind": "playlist", "data": _row_to_dict(playlist_exact)}
    elif user_exact and playlist_exact:
        primary = {"kind": "user", "data": _row_to_dict(user_exact)}

    result_core = {
        "primary": primary,
        "users": users_out[:limit],
        "playlists": playlists_acc[:limit],
    }
    _search_cache_put(cache_key, result_core)

    return {"query": q, "term": term, **result_core}


# ---------------------------------------------------------------------------
# Экспорт для других модулей (например, stream_gateway)
# ---------------------------------------------------------------------------

__all__ = ["_verify_webapp_init_data"]


@router.get("/me/playlist/stream")
async def stream_my_playlist(
    request: Request,
    user_id: int = Depends(_current_user_id),
):
    """
    SSE: отправляет 'event: playlist\\ndata: changed\\n\\n' при изменениях,
    а также "hello" сразу при подключении.
    """
    q: asyncio.Queue[str] = asyncio.Queue()
    _PLAYLIST_SUBS.setdefault(user_id, set()).add(q)

    async def gen():
        try:
            # первая посылка — клиент может сразу дернуть sync
            yield b"retry: 3000\n"
            yield b"event: playlist\ndata: hello\n\n"
            while True:
                # раз в 30 сек шлём ping, чтобы не умирал прокси
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"event: playlist\ndata: {msg}\n\n".encode("utf-8")
                except asyncio.TimeoutError:
                    yield b": ping\n\n"
                if await request.is_disconnected():
                    break
        finally:
            _PLAYLIST_SUBS.get(user_id, set()).discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # для nginx
        "Connection": "keep-alive",
    })
