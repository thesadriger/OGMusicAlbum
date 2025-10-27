from __future__ import annotations
import asyncpg
from fastapi import APIRouter, Depends, Query
from app.api.users import _get_pool, _current_user_id

router = APIRouter()

@router.get("/me/recs")
async def me_recs(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user_id: int = Depends(_current_user_id),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    async with pool.acquire() as con:
        # Локальный таймаут только для этого запроса
        async with con.transaction():
            await con.execute("SET LOCAL statement_timeout = '2000ms'")
            rows = await con.fetch("""
                select id::text, tg_msg_id as "msgId", chat_username as chat,
                       title, artists, hashtags, duration_s as duration, mime, created_at
                from tracks
                order by created_at desc nulls last
                limit $1 offset $2
            """, limit, offset)
    return {"items": [dict(r) for r in rows], "limit": limit, "offset": offset, "total": None}
