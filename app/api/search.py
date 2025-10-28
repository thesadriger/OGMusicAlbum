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

_cache: Dict[Tuple[str, int, int], Tuple[float, Dict[str, Any]]] = {}

def _cache_get(key: Tuple[str, int, int]) -> Optional[Dict[str, Any]]:
    hit = _cache.get(key)
    if not hit:
        return None
    ts, val = hit
    if (time.time() - ts) > SEARCH_TTL:
        _cache.pop(key, None)
        return None
    return val

def _cache_put(key: Tuple[str, int, int], val: Dict[str, Any]) -> None:
    if len(_cache) >= CACHE_MAX:
        try:
            _cache.pop(next(iter(_cache)))  # самый старый
        except Exception:
            _cache.clear()
    _cache[key] = (time.time(), val)

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
    response: Response,
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    term = q.strip()
    if not term:
        raise HTTPException(400, "Empty query")

    # ключ кэша (в кэше держим только неперсонализированный ответ)
    ckey = (term.lower(), int(limit), int(offset))
    cached = _cache_get(ckey)
    if cached is not None:
        # соблюдаем форму ответа под фронт (hits/limit/offset/estimatedTotalHits)
        return {"hits": cached["hits"], "limit": limit, "offset": offset,
                "estimatedTotalHits": cached.get("estimatedTotalHits")}

    # 1) попробуем Meili
    idx = _get_meili_index()
    if idx is not None:
        try:
            # отдаём минимально необходимое; можно добавить attributesToRetrieve при желании
            r = idx.search(
                term,
                {
                    "limit": limit,
                    "offset": offset,
                },
            )
            out = {
                "hits": r.get("hits", []),
                "limit": limit,
                "offset": offset,
                "estimatedTotalHits": r.get("estimatedTotalHits"),
            }
            _cache_put(ckey, out)
            return out
        except Exception:
            # если Meili недоступен/ошибка — падаем в fallback
            pass

    # 2) fallback: Postgres (быстрое условие по нормализованному полю и индексу)
    async with pool.acquire() as con:
        async with con.transaction():
            # на всякий — ограничим запрос по времени
            await con.execute("SET LOCAL statement_timeout = '2000ms'")
            # Используем нормализованное поле + индекс GIN/TRGM (ты уже создал)
            rows = await con.fetch(
                """
                select id::text, tg_msg_id as "msgId", chat_username as chat,
                       title, artists, hashtags, duration_s as duration, mime, created_at
                from tracks
                where search_blob_norm like '%' || lower(unaccent($1)) || '%'
                order by tg_msg_id desc
                limit $2 offset $3
                """,
                term, limit, offset
            )
            # приводим к той же форме, что и Meili
            hits = [dict(r) for r in rows]
            out = {"hits": hits, "limit": limit, "offset": offset, "estimatedTotalHits": None}
            _cache_put(ckey, out)
            response.headers["Cache-Control"] = f"public, max-age={SEARCH_TTL}"
            response.headers["Vary"] = "Accept-Encoding"
            return out