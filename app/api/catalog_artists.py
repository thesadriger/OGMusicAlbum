from __future__ import annotations

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Request, HTTPException, Query

router = APIRouter(tags=["catalog"])

# --- helpers ---------------------------------------------------------------

def _row_to_track(r) -> Dict[str, Any]:
    """Унифицированная форма трека для фронта."""
    return {
        "id": str(r["id"]),
        "title": r.get("title"),
        "artists": r.get("artists") or [],
        "hashtags": r.get("hashtags") or [],
        "duration": r.get("duration_s"),
        "mime": r.get("mime"),
        "size_bytes": r.get("size_bytes"),
        "created_at": r.get("created_at"),
        "chat": r.get("chat"),
        "msgId": int(r.get("msgId") or 0),
    }

# --- API -------------------------------------------------------------------

@router.get("/catalog/artists/summary")
async def artists_summary(
    request: Request,
    top: int = Query(3, ge=1, le=20),
    chat: str = Query("OGMA_archive"),
) -> Dict[str, Any]:
    """
    Возвращает:
      - top: топ-N артистов по сумме секунд прослушивания (только треки из chat)
      - ru:  все артисты из chat (кириллица), по алфавиту
      - en:  все артисты из chat (латиница), по алфавиту
    """
    pool = getattr(request.app.state, "pool", None)
    if not pool:
        raise HTTPException(503, "DB pool not ready")

    sql = r"""
    WITH top_art AS (
      SELECT a.artist, SUM(ls.seconds)::bigint AS sec
      FROM listening_seconds ls
      JOIN tracks t ON t.id = ls.track_id
      CROSS JOIN LATERAL unnest(t.artists) AS a(artist)
      WHERE t.chat_username = $1
      GROUP BY a.artist
      ORDER BY sec DESC, a.artist ASC
      LIMIT $2
    ),
    all_art AS (
      SELECT DISTINCT a.artist
      FROM tracks t
      CROSS JOIN LATERAL unnest(t.artists) AS a(artist)
      WHERE t.chat_username = $1
    )
    SELECT
      COALESCE(
        (SELECT json_agg(json_build_object('artist', artist, 'seconds_total', sec))
         FROM top_art),
        '[]'::json) AS top,
      COALESCE(
        (SELECT array_agg(artist ORDER BY artist)
         FROM all_art
         WHERE artist ~* '^[А-ЯЁа-яё]'),
        ARRAY[]::text[]) AS ru,
      COALESCE(
        (SELECT array_agg(artist ORDER BY artist)
         FROM all_art
         WHERE artist ~* '^[A-Z]'),
        ARRAY[]::text[]) AS en;
    """

    async with pool.acquire() as con:
        row = await con.fetchrow(sql, chat, top)

    # asyncpg arrays -> list, json -> list[dict] (если настроены кодеки)
    out_top = row["top"]
    if isinstance(out_top, str):
        # на случай, если кодеки json/jsonb не настроены
        import json as _json
        try:
            out_top = _json.loads(out_top)
        except Exception:
            out_top = []

    return {
        "top": out_top,
        "ru": row["ru"] or [],
        "en": row["en"] or [],
        "chat": chat,
    }


@router.get("/catalog/artist/tracks")
async def artist_tracks(
    request: Request,
    artist: str,
    chat: str = Query("OGMA_archive"),
) -> Dict[str, Any]:
    """
    Все треки артиста из указанного Telegram-канала (chat), по дате убыв.
    """
    pool = getattr(request.app.state, "pool", None)
    if not pool:
        raise HTTPException(503, "DB pool not ready")

    sql = """
    SELECT
      t.id::text                 AS id,
      t.title                    AS title,
      t.artists                  AS artists,
      t.hashtags                 AS hashtags,
      t.duration_s               AS duration_s,
      t.mime                     AS mime,
      t.size_bytes               AS size_bytes,
      t.created_at               AS created_at,
      t.chat_username            AS chat,
      t.tg_msg_id                AS "msgId"
    FROM tracks t
    WHERE t.chat_username = $1
      AND $2 = ANY (t.artists)
    ORDER BY t.created_at DESC;
    """

    async with pool.acquire() as con:
        rows = await con.fetch(sql, chat, artist)

    items = [_row_to_track(r) for r in rows]
    return {"artist": artist, "chat": chat, "count": len(items), "items": items}