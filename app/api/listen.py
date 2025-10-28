from __future__ import annotations

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timezone, timedelta

import asyncpg
import uuid

# Берём готовые хелперы авторизации и резолва юзера
from app.api.stream_gateway import _maybe_user_id

router = APIRouter()

class ListenIn(BaseModel):
    # идентификация трека:
    track_id: Optional[str] = None
    chat: Optional[str] = None
    msg_id: Optional[int] = None

    # сколько секунд накапало с прошлого «тика»
    delta_sec: int = Field(..., ge=1, le=60, description="Seconds listened since the last ping (1..60)")

    # опциональный идемпотентный ключ от клиента (напр. тайм-слот раз в 5с)
    tick_key: Optional[str] = Field(
        None,
        description="Client idempotency key (e.g., `${trackId}:${Math.floor(Date.now()/5000)}`)"
    )

    playlist_id: Optional[str] = Field(
        None,
        description="UUID of the playlist the track is played from"
    )
    playlist_handle: Optional[str] = Field(
        None,
        description="Handle (@name) of the playlist when UUID is not available"
    )

async def _ensure_schema(pool: asyncpg.Pool) -> None:
    # создаём таблицы, если их ещё нет (idempotent)
    await pool.execute("""
    create table if not exists listening_seconds(
      user_id   bigint    not null,
      track_id  uuid      not null,
      day       date      not null,
      seconds   integer   not null default 0 check (seconds >= 0),
      updated_at timestamptz not null default now(),
      primary key (user_id, track_id, day)
    );

    create table if not exists listening_ticks(
      user_id   bigint    not null,
      track_id  uuid      not null,
      tick_key  text      not null,
      seconds   integer   not null check (seconds > 0),
      created_at timestamptz not null default now(),
      primary key (user_id, track_id, tick_key)
    );

    create table if not exists playlist_listening_totals(
      playlist_id uuid primary key references playlists(id) on delete cascade,
      seconds     bigint not null default 0 check (seconds >= 0),
      updated_at  timestamptz not null default now()
    );

    create index if not exists playlist_listening_totals_updated_idx
      on playlist_listening_totals (updated_at desc);

    create table if not exists playlist_owner_listening_totals(
      user_id    bigint primary key references users(telegram_id) on delete cascade,
      seconds    bigint not null default 0 check (seconds >= 0),
      updated_at timestamptz not null default now()
    );

    create index if not exists playlist_owner_listening_totals_updated_idx
      on playlist_owner_listening_totals (updated_at desc);
    """)

async def _resolve_track_id(pool: asyncpg.Pool, payload: ListenIn) -> Optional[str]:
    if payload.track_id:
        return payload.track_id
    if payload.chat and payload.msg_id is not None:
        row = await pool.fetchrow(
            "select id::text from tracks where chat_username=$1 and tg_msg_id=$2 limit 1",
            payload.chat.lstrip("@"), int(payload.msg_id)
        )
        return row["id"] if row else None
    return None


async def _increment_playlist_totals(
    con: asyncpg.Connection,
    playlist_id: uuid.UUID,
    owner_id: int,
    delta: int,
) -> None:
    await con.execute(
        """
        insert into playlist_listening_totals(playlist_id, seconds)
        values ($1, $2)
        on conflict (playlist_id)
        do update set
          seconds   = playlist_listening_totals.seconds + EXCLUDED.seconds,
          updated_at = now()
        """,
        playlist_id,
        int(delta),
    )
    await con.execute(
        """
        insert into playlist_owner_listening_totals(user_id, seconds)
        values ($1, $2)
        on conflict (user_id)
        do update set
          seconds   = playlist_owner_listening_totals.seconds + EXCLUDED.seconds,
          updated_at = now()
        """,
        int(owner_id),
        int(delta),
    )


async def _owner_total_seconds(con: asyncpg.Connection, owner_id: int) -> int:
    cached = await con.fetchval(
        "select seconds from playlist_owner_listening_totals where user_id=$1",
        int(owner_id),
    )
    if cached is not None:
        return int(cached)

    agg = await con.fetchval(
        """
        select coalesce(sum(lst.seconds), 0)
          from playlist_listening_totals lst
          join playlists p on p.id = lst.playlist_id
         where p.user_id = $1
        """,
        int(owner_id),
    )

    total = int(agg or 0)
    if total > 0:
        await con.execute(
            """
            insert into playlist_owner_listening_totals(user_id, seconds)
            values ($1, $2)
            on conflict (user_id)
            do update set
              seconds   = EXCLUDED.seconds,
              updated_at = now()
            """,
            int(owner_id),
            total,
        )
    return total

@router.post("/me/listen")
async def me_listen(payload: ListenIn, request: Request):
    uid = _maybe_user_id(request)
    if not uid:
        raise HTTPException(401, "Unauthorized")

    pool: asyncpg.Pool = request.app.state.pool
    if not pool:
        raise HTTPException(503, "DB pool not ready")

    await _ensure_schema(pool)

    track_id = await _resolve_track_id(pool, payload)
    if not track_id:
        raise HTTPException(404, "Track not found")

    try:
        track_uuid = uuid.UUID(str(track_id))
    except Exception:
        track_uuid = None

    playlist_uuid: Optional[uuid.UUID] = None
    playlist_owner: Optional[int] = None

    async def _resolve_playlist_by_id(candidate: uuid.UUID) -> tuple[Optional[uuid.UUID], Optional[int]]:
        if track_uuid is None:
            return None, None
        row = await pool.fetchrow(
            "SELECT id, user_id, is_public FROM playlists WHERE id=$1",
            candidate,
        )
        if not row or not bool(row["is_public"]):
            return None, None
        has_track = await pool.fetchval(
            "SELECT 1 FROM playlist_items WHERE playlist_id=$1 AND track_id=$2",
            candidate,
            track_uuid,
        )
        if not has_track:
            return None, None
        try:
            owner = int(row["user_id"])
        except Exception:
            owner = None
        return candidate, owner

    if payload.playlist_id and track_uuid is not None:
        try:
            candidate_uuid = uuid.UUID(str(payload.playlist_id))
        except Exception:
            candidate_uuid = None
        if candidate_uuid is not None:
            playlist_uuid, playlist_owner = await _resolve_playlist_by_id(candidate_uuid)

    if (
        playlist_uuid is None
        and payload.playlist_handle
        and track_uuid is not None
    ):
        handle = str(payload.playlist_handle or "").strip().lstrip("@").lower()
        if handle:
            row = await pool.fetchrow(
                "SELECT id FROM playlists WHERE is_public=true AND lower(handle)=lower($1)",
                handle,
            )
            if row and row.get("id"):
                candidate = row["id"]
                resolved_uuid, resolved_owner = await _resolve_playlist_by_id(candidate)
                if resolved_uuid is not None:
                    playlist_uuid = resolved_uuid
                    playlist_owner = resolved_owner

    # безопасно зажмём дельту (на всякий)
    try:
        delta = int(payload.delta_sec)
    except Exception:
        raise HTTPException(422, "Invalid delta_sec")
    delta = max(1, min(60, delta))

    # идемпотентность: если пришёл tick_key — учитываем не больше одного раза
    deduped = False
    if payload.tick_key:
        try:
            await pool.execute(
                "insert into listening_ticks(user_id, track_id, tick_key, seconds) values ($1,$2,$3,$4)",
                uid, track_id, payload.tick_key, delta
            )
        except Exception:
            # уже есть такой тик — не суммируем повторно
            deduped = True
            delta = 0

    async with pool.acquire() as con:
        if delta > 0:
            today = datetime.now(timezone.utc).date()
            await con.execute(
                """
                insert into listening_seconds(user_id, track_id, day, seconds)
                values ($1, $2::uuid, $3, $4)
                on conflict (user_id, track_id, day)
                do update set
                  seconds   = LEAST(86400, listening_seconds.seconds + EXCLUDED.seconds),
                  updated_at = now()
                """,
                uid,
                track_id,
                today,
                delta,
            )

            if (
                playlist_uuid is not None
                and playlist_owner is not None
                and int(uid) != int(playlist_owner)
            ):
                await _increment_playlist_totals(
                    con,
                    playlist_uuid,
                    int(playlist_owner),
                    delta,
                )

        # быстрый ответ с суммами сегодня/за всё время
        row = await con.fetchrow(
            """
            select
              coalesce((select seconds
                        from listening_seconds
                        where user_id=$1 and track_id=$2::uuid and day=current_date), 0) as today,
              coalesce((select sum(seconds)
                        from listening_seconds
                        where user_id=$1 and track_id=$2::uuid), 0) as all_time
            """,
            uid,
            track_id,
        )

    return {"ok": True, "deduped": deduped, "delta_applied": delta, "totals": dict(row)}


@router.get("/me/listen-seconds")
async def me_listen_seconds(
    request: Request,
    period: str = "all",
    scope: str | None = None,
):
    uid = _maybe_user_id(request)
    if not uid:
        raise HTTPException(401, "Unauthorized")

    pool: asyncpg.Pool = request.app.state.pool
    if not pool:
        raise HTTPException(503, "DB pool not ready")

    await _ensure_schema(pool)

    scope_norm = (scope or "").strip().lower()

    if scope_norm in {"playlists", "playlist", "received"}:
        if period and (period or "").strip().lower() not in {"", "all", "*", "total"}:
            raise HTTPException(400, "Period is not supported for playlist totals")
        async with pool.acquire() as con:
            total = await _owner_total_seconds(con, int(uid))
        return {"seconds": int(total)}

    if scope_norm not in {"", "tracks", "track"}:
        raise HTTPException(400, "Unsupported scope")

    period_norm = (period or "all").strip().lower()
    today = datetime.now(timezone.utc).date()

    if period_norm in {"all", "*", "total"}:
        date_from = None
    elif period_norm in {"today", "day", "1d"}:
        date_from = today
    elif period_norm in {"week", "7d"}:
        date_from = today - timedelta(days=6)
    elif period_norm in {"month", "30d"}:
        date_from = today.replace(day=1)
    else:
        raise HTTPException(400, "Unsupported period")

    async with pool.acquire() as con:
        if date_from is None:
            total = await con.fetchval(
                "select coalesce(sum(seconds), 0) from listening_seconds where user_id=$1",
                uid,
            )
        else:
            total = await con.fetchval(
                """
                select coalesce(sum(seconds), 0)
                  from listening_seconds
                 where user_id=$1
                   and day >= $2
                """,
                uid,
                date_from,
            )

    return {"seconds": int(total or 0)}
