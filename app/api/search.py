from __future__ import annotations
import os, time
from typing import Any, Dict, Optional, Tuple

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from app.api.users import _get_pool

# Meili — опционально: если нет ключа/хоста, автоматически уйдём в fallback (БД)
try:
    import meilisearch  # type: ignore
except Exception:  # библиотека не установлена — работаем только через БД
    meilisearch = None  # type: ignore

router = APIRouter()

# -------------------- настройки кэша и Meili --------------------
SEARCH_TTL = int(os.environ.get("TRACKS_SEARCH_TTL", "30"))  # сек, 15–60 норм
CACHE_MAX  = int(os.environ.get("TRACKS_CACHE_MAX", "1000"))

_MEILI_HOST = os.environ.get("MEILI_HOST") or os.environ.get("MEILI_URL")
_MEILI_KEY  = os.environ.get("MEILI_KEY") or os.environ.get("MEILI_MASTER_KEY")

CacheKey = Tuple[str, int, int, int, int]

_cache: Dict[CacheKey, Tuple[float, Dict[str, Any]]] = {}

def _cache_get(key: CacheKey) -> Optional[Dict[str, Any]]:
    hit = _cache.get(key)
    if not hit:
        return None
    ts, val = hit
    if (time.time() - ts) > SEARCH_TTL:
        _cache.pop(key, None)
        return None
    return val

def _cache_put(key: CacheKey, val: Dict[str, Any]) -> None:
    if len(_cache) >= CACHE_MAX:
        try:
            _cache.pop(next(iter(_cache)))  # самый старый
        except Exception:
            _cache.clear()
    _cache[key] = (time.time(), val)


def _set_cache_headers(response: Response) -> None:
    response.headers["Cache-Control"] = f"public, max-age={SEARCH_TTL}"
    response.headers["Vary"] = "Accept-Encoding"

def _get_meili_index():
    if not (meilisearch and _MEILI_HOST and _MEILI_KEY):
        return None
    try:
        client = meilisearch.Client(_MEILI_HOST, _MEILI_KEY)  # type: ignore
        return client.index("tracks")
    except Exception:
        return None

# -------------------- основной эндпоинт --------------------
@router.get("/search")
async def search_tracks(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    *,
    playlist_limit: int = Query(10, ge=1, le=100, alias="playlist_limit"),
    playlist_offset: int = Query(0, ge=0, alias="playlist_offset"),
    response: Response,
    pool: asyncpg.Pool = Depends(_get_pool),
):
    term = q.strip()
    if not term:
        raise HTTPException(400, "Empty query")

    ckey: CacheKey = (
        term.lower(),
        int(limit),
        int(offset),
        int(playlist_limit),
        int(playlist_offset),
    )
    cached = _cache_get(ckey)
    if cached is not None:
        _set_cache_headers(response)
        return cached

    idx = _get_meili_index()
    tracks_section: Optional[Dict[str, Any]] = None
    if idx is not None:
        try:
            r = idx.search(
                term,
                {
                    "limit": limit,
                    "offset": offset,
                },
            )
            tracks_section = {
                "hits": r.get("hits", []),
                "limit": limit,
                "offset": offset,
                "estimatedTotalHits": r.get("estimatedTotalHits"),
            }
        except Exception:
            pass

    handle_term = term[1:] if term.startswith("@") else term
    playlist_rows = []
    playlist_total = 0

    async with pool.acquire() as con:
        async with con.transaction():
            await con.execute("SET LOCAL statement_timeout = '2000ms'")

            if tracks_section is None:
                rows = await con.fetch(
                    """
                    select id::text, tg_msg_id as "msgId", chat_username as chat,
                           title, artists, hashtags, duration_s as duration, mime, created_at
                    from tracks
                    where search_blob_norm like '%' || lower(unaccent($1)) || '%'
                    order by tg_msg_id desc
                    limit $2 offset $3
                    """,
                    term,
                    limit,
                    offset,
                )
                tracks_section = {
                    "hits": [dict(r) for r in rows],
                    "limit": limit,
                    "offset": offset,
                    "estimatedTotalHits": None,
                }

            playlist_rows = await con.fetch(
                """
                select
                    id::text                 as id,
                    user_id                  as "userId",
                    title,
                    kind,
                    is_public               as "isPublic",
                    handle,
                    created_at,
                    updated_at,
                    count(*) over()         as total
                from playlists
                where is_public = true
                  and (
                        (handle is not null and $1 <> '' and lower(handle) like '%' || lower($1) || '%')
                        or lower(unaccent(title)) like '%' || lower(unaccent($2)) || '%'
                      )
                order by updated_at desc nulls last, created_at desc
                limit $3 offset $4
                """,
                handle_term,
                term,
                playlist_limit,
                playlist_offset,
            )

    playlist_hits = []
    for row in playlist_rows:
        payload = dict(row)
        playlist_total = payload.pop("total", playlist_total)
        playlist_hits.append(payload)

    playlist_section = {
        "hits": playlist_hits,
        "limit": playlist_limit,
        "offset": playlist_offset,
        "estimatedTotalHits": playlist_total if playlist_hits else 0,
    }

    result = {
        "hits": tracks_section["hits"] if tracks_section else [],
        "limit": tracks_section["limit"] if tracks_section else limit,
        "offset": tracks_section["offset"] if tracks_section else offset,
        "estimatedTotalHits": tracks_section.get("estimatedTotalHits") if tracks_section else None,
        "playlists": playlist_section,
    }

    _cache_put(ckey, result)
    _set_cache_headers(response)
    return result
