from __future__ import annotations

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timezone, timedelta

import asyncpg

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

    # апсерт агрегации по суткам (UTC)
    if delta > 0:
        today = datetime.now(timezone.utc).date()
        await pool.execute("""
            insert into listening_seconds(user_id, track_id, day, seconds)
            values ($1, $2::uuid, $3, $4)
            on conflict (user_id, track_id, day)
            do update set
              seconds   = LEAST(86400, listening_seconds.seconds + EXCLUDED.seconds),
              updated_at = now()
        """, uid, track_id, today, delta)

    # быстрый ответ с суммами сегодня/за всё время
    row = await pool.fetchrow("""
        select
          coalesce((select seconds
                    from listening_seconds
                    where user_id=$1 and track_id=$2::uuid and day=current_date), 0) as today,
          coalesce((select sum(seconds)
                    from listening_seconds
                    where user_id=$1 and track_id=$2::uuid), 0) as all_time
    """, uid, track_id)

    return {"ok": True, "deduped": deduped, "delta_applied": delta, "totals": dict(row)}


@router.get("/me/listen-seconds")
async def me_listen_seconds(request: Request, period: str = "all"):
    uid = _maybe_user_id(request)
    if not uid:
        raise HTTPException(401, "Unauthorized")

    pool: asyncpg.Pool = request.app.state.pool
    if not pool:
        raise HTTPException(503, "DB pool not ready")

    await _ensure_schema(pool)

    period_norm = (period or "all").strip().lower()
    today = datetime.now(timezone.utc).date()
    date_from = None

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
