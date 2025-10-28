#home/ogma/ogma/app/api/playlists.py
from __future__ import annotations

import os
import re
import hmac
import json
import uuid
import time
import base64
import hashlib
import urllib.parse
from typing import Optional

import asyncpg
from pydantic import BaseModel, field_validator
from fastapi import (
    APIRouter, Depends, HTTPException, Query, Body, Header, Request, Cookie, status
)
from typing import List, Dict, Any
from app.api.users import _get_pool  # общий пул

router = APIRouter()

JWT_SECRET = os.environ.get("API_JWT_SECRET") or ""
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN") or os.environ.get("BOT_TOKEN") or ""

HANDLE_RE = re.compile(r"^[a-z0-9_][a-z0-9_-]{2,31}$")

_LISTEN_TOTALS_READY = False
_LISTEN_TOTALS_DDL = """
create table if not exists playlist_listening_totals (
  playlist_id uuid primary key references playlists(id) on delete cascade,
  seconds     bigint not null default 0 check (seconds >= 0),
  updated_at  timestamptz not null default now()
);
create index if not exists playlist_listening_totals_updated_idx on playlist_listening_totals (updated_at desc);
"""


# -------------------- utils --------------------

def _clean_handle(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    s = s.strip().lstrip("@").lower()
    return s or None


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _parse_jwt_hs256(token: str, secret: str) -> Optional[dict]:
    try:
        h_b64, p_b64, s_b64 = token.split(".")
    except ValueError:
        return None
    try:
        header = json.loads(_b64url_decode(h_b64))
        payload = json.loads(_b64url_decode(p_b64))
    except Exception:
        return None
    if not isinstance(header, dict) or header.get("alg") != "HS256":
        return None
    mac = hmac.new(secret.encode(), msg=f"{h_b64}.{p_b64}".encode(), digestmod=hashlib.sha256).digest()
    sig_ok = hmac.compare_digest(_b64url_encode(mac), s_b64)
    if not sig_ok:
        return None
    exp = payload.get("exp")
    if isinstance(exp, (int, float)) and time.time() > float(exp):
        return None
    return payload


def _tg_init_secret(bot_token: str) -> bytes:
    return hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()


def _verify_tg_initdata(raw: str, bot_token: str) -> Optional[dict]:
    if not bot_token:
        return None
    params = urllib.parse.parse_qs(raw, keep_blank_values=True, strict_parsing=False)
    params = {k: v[-1] for k, v in params.items()}
    given_hash = params.pop("hash", None)
    if not given_hash:
        return None

    data_check_string = "\n".join(f"{k}={params[k]}" for k in sorted(params.keys()))
    secret = _tg_init_secret(bot_token)
    mac = hmac.new(secret, msg=data_check_string.encode(), digestmod=hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, given_hash):
        return None

    auth_date = params.get("auth_date")
    if auth_date and auth_date.isdigit():
        ts = int(auth_date)
        if ts < time.time() - 24 * 3600:
            return None

    try:
        user = json.loads(params.get("user", "{}"))
    except Exception:
        user = {}
    if not isinstance(user, dict):
        user = {}

    return {
        "user": user,
        "auth_date": int(params.get("auth_date", "0") or 0),
        "query_id": params.get("query_id"),
    }


# -------------------- models --------------------

class PlaylistCreate(BaseModel):
    title: str
    is_public: bool = False
    handle: Optional[str] = None


class HandleUpdate(BaseModel):
    handle: Optional[str] = None


class PlaylistUpdate(BaseModel):
    title: Optional[str] = None
    handle: Optional[str] = None
    is_public: Optional[bool] = None

    @field_validator("title")
    @classmethod
    def _validate_title(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Title must not be empty")
        return cleaned

    @field_validator("handle", mode="before")
    @classmethod
    def _validate_handle(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return _clean_handle(value)

    def prepare_updates(self, *, was_public: bool) -> Dict[str, Any]:
        data = self.model_dump(exclude_unset=True)
        if not data:
            raise ValueError("No changes requested")

        target_public = bool(data["is_public"]) if "is_public" in data else was_public

        if not was_public and not target_public:
            allowed = {"title"}
            if "is_public" in data:
                data["is_public"] = False
                allowed.add("is_public")
            forbidden = set(data) - allowed
            if forbidden:
                raise ValueError("Only title can be updated for private playlists")
            return data

        handle_provided = "handle" in data
        handle = data.get("handle") if handle_provided else None
        if handle_provided and handle:
            if not HANDLE_RE.fullmatch(handle):
                raise ValueError("Handle must match ^[a-z0-9_]{3,32}$")
        if handle_provided and not target_public and handle:
            raise ValueError("Handle can be set only for public playlists")

        if "is_public" in data:
            data["is_public"] = target_public

        if not target_public:
            data["handle"] = None
        elif handle_provided and not handle:
            data["handle"] = None

        return data


class RemoveItemBody(BaseModel):
    # Либо track_id, либо пара (msg_id, chat)
    track_id: Optional[str] = None
    msg_id: Optional[int] = None
    chat: Optional[str] = None


# -------------------- auth helpers --------------------

async def _ensure_db_user(con: asyncpg.Connection, uid: int) -> None:
    await con.execute(
        "INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT (telegram_id) DO NOTHING",
        uid,
    )


async def _ensure_default_playlist(con: asyncpg.Connection, user_id: int) -> str:
    existing = await con.fetchrow(
        """
        SELECT id::text
          FROM playlists
         WHERE user_id = $1
           AND title = 'Мой плейлист'
         ORDER BY created_at ASC
         LIMIT 1
        """,
        user_id,
    )
    if existing:
        return existing["id"]

    row = await con.fetchrow(
        """
        INSERT INTO playlists (user_id, title, kind)
        VALUES ($1, 'Мой плейлист', 'custom')
        RETURNING id::text
        """,
        user_id,
    )
    return row["id"]


async def _ensure_playlist_listening_totals(pool: asyncpg.Pool) -> None:
    global _LISTEN_TOTALS_READY
    if _LISTEN_TOTALS_READY:
        return
    await pool.execute(_LISTEN_TOTALS_DDL)
    _LISTEN_TOTALS_READY = True


async def get_current_user(
    request: Request,
    pool: asyncpg.Pool = Depends(_get_pool),
    x_user_id: Optional[int] = Header(default=None, alias="X-User-Id"),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    x_tg_init: Optional[str] = Header(default=None, alias="X-Telegram-Init-Data"),
    init_qs: Optional[str] = Query(default=None, alias="init"),
    ogma_session: Optional[str] = Cookie(default=None, alias="ogma_session"),
) -> int:
    """
    Возвращает telegram_id текущего пользователя.
    Источники: X-User-Id, Bearer JWT, cookie ogma_session, Telegram initData.
    Успешная авторизация → ensure user + ensure default playlist.
    """
    uid: Optional[int] = None

    if x_user_id:
        try:
            uid = int(x_user_id)
        except Exception:
            raise HTTPException(401, "Bad X-User-Id")

    if uid is None and authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(None, 1)[1].strip()
        if JWT_SECRET:
            payload = _parse_jwt_hs256(token, JWT_SECRET)
            if payload:
                cand = payload.get("uid") or payload.get("sub")
                if isinstance(cand, int) or (isinstance(cand, str) and cand.isdigit()):
                    uid = int(cand)

    if uid is None and ogma_session and JWT_SECRET:
        payload = _parse_jwt_hs256(ogma_session, JWT_SECRET)
        if payload:
            cand = payload.get("uid") or payload.get("sub")
            if isinstance(cand, int) or (isinstance(cand, str) and cand.isdigit()):
                uid = int(cand)

    if uid is None and (x_tg_init or init_qs):
        raw = x_tg_init or init_qs or ""
        v = _verify_tg_initdata(raw, BOT_TOKEN)
        if v and isinstance(v.get("user"), dict):
            tg_user = v["user"]
            cand = tg_user.get("id")
            if isinstance(cand, int) or (isinstance(cand, str) and str(cand).isdigit()):
                uid = int(cand)

    if uid is None:
        raise HTTPException(401, "Unauthorized")

    async with pool.acquire() as con:
        await _ensure_db_user(con, uid)
        await _ensure_default_playlist(con, uid)

    return uid


# -------------------- DB helpers for deletion --------------------

async def _delete_item_by_track(con: asyncpg.Connection, pid: uuid.UUID, tid: uuid.UUID) -> int:
    tag = await con.execute(
        "DELETE FROM playlist_items WHERE playlist_id=$1 AND track_id=$2",
        pid, tid
    )
    try:
        return int(tag.split()[-1])  # "DELETE 1" → 1
    except Exception:
        return 0


async def _delete_item_by_msg(con: asyncpg.Connection, pid: uuid.UUID, msg_id: int, chat: str) -> int:
    chat = chat.lstrip("@")
    tag = await con.execute(
        """
        DELETE FROM playlist_items i
        USING tracks t
        WHERE i.playlist_id = $1
          AND i.track_id = t.id
          AND t.tg_msg_id = $2
          AND lower(t.chat_username) = lower($3)
        """,
        pid, msg_id, chat,
    )
    try:
        return int(tag.split()[-1])
    except Exception:
        return 0


# -------------------- ROUTES --------------------

@router.get("/playlists")
async def list_playlists(
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    await _ensure_playlist_listening_totals(pool)
    async with pool.acquire() as con:
        rows = await con.fetch(
            """
            SELECT p.id::text, p.user_id, p.title, p.kind, p.is_public, p.handle,
                   p.created_at, p.updated_at,
                   (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id=p.id) AS item_count,
                   COALESCE(lst.seconds, 0) AS listen_seconds
            FROM playlists p
            LEFT JOIN playlist_listening_totals lst ON lst.playlist_id = p.id
            WHERE p.user_id = $1
            ORDER BY p.updated_at DESC, p.created_at DESC
            """,
            user_id,
        )
    return {"items": [dict(r) for r in rows]}


@router.post("/playlists", status_code=status.HTTP_201_CREATED)
async def create_playlist(
    payload: Optional[PlaylistCreate] = Body(default=None),
    title_q: Optional[str] = Query(default=None, alias="title"),
    is_public_q: bool = Query(default=False, alias="is_public"),
    handle_q: Optional[str] = Query(default=None, alias="handle"),
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    if payload is not None:
        title = (payload.title or "").strip()
        is_public = bool(payload.is_public)
        handle = payload.handle
    else:
        title = (title_q or "").strip() if title_q is not None else ""
        is_public = bool(is_public_q)
        handle = handle_q

    if not title:
        raise HTTPException(400, "Title is required")

    h = _clean_handle(handle)
    if h is not None and not HANDLE_RE.fullmatch(h):
        raise HTTPException(400, "Handle must match ^[a-z0-9_]{3,32}$")

    async with pool.acquire() as con:
        if h is not None:
            exists = await con.fetchval(
                "SELECT 1 FROM playlists WHERE lower(handle)=lower($1)", h
            )
            if exists:
                raise HTTPException(409, "Handle is already taken")

        try:
            row = await con.fetchrow(
                """
                INSERT INTO playlists (user_id, title, kind, is_public, handle)
                VALUES ($1, $2, 'custom', $3, $4)
                RETURNING id::text, user_id, title, kind, is_public, handle, created_at, updated_at
                """,
                user_id, title, is_public, h,
            )
        except asyncpg.UniqueViolationError as e:
            cn = getattr(e, "constraint_name", "") or ""
            detail = getattr(e, "detail", "") or ""
            text = f"{cn} {detail}".lower()
            if "handle" in text:
                raise HTTPException(409, "Handle is already taken")
            raise HTTPException(409, "Failed to create playlist")

    payload = dict(row)
    if "listen_seconds" not in payload:
        payload["listen_seconds"] = 0
    return payload


async def _perform_playlist_update(
    playlist_id: str,
    payload: PlaylistUpdate,
    pool: asyncpg.Pool,
    user_id: int,
):
    await _ensure_playlist_listening_totals(pool)
    try:
        pid = uuid.UUID(playlist_id)
    except Exception:
        raise HTTPException(400, "Invalid playlist_id")

    async with pool.acquire() as con:
        row = await con.fetchrow(
            "SELECT id::text, user_id, title, kind, is_public, handle FROM playlists WHERE id=$1",
            pid,
        )
        if row is None:
            raise HTTPException(404, "Playlist not found")
        if row["user_id"] != user_id:
            raise HTTPException(403, "Forbidden")

        try:
            updates = payload.prepare_updates(was_public=bool(row["is_public"]))
        except ValueError as exc:
            raise HTTPException(400, str(exc))

        handle = updates.get("handle") if "handle" in updates else None
        if handle is not None:
            exists = await con.fetchval(
                "SELECT 1 FROM playlists WHERE lower(handle)=lower($1) AND id<>$2",
                handle,
                pid,
            )
            if exists:
                raise HTTPException(409, "Handle is already taken")

        set_parts = []
        values: List[Any] = []
        idx = 1

        if "title" in updates:
            set_parts.append(f"title = ${idx}")
            values.append(updates["title"])
            idx += 1

        if "handle" in updates:
            set_parts.append(f"handle = ${idx}")
            values.append(updates["handle"])
            idx += 1

        if "is_public" in updates:
            set_parts.append(f"is_public = ${idx}")
            values.append(updates["is_public"])
            idx += 1

        if not set_parts:
            raise HTTPException(400, "No changes requested")

        set_parts.append("updated_at = now()")

        try:
            updated = await con.fetchrow(
                f"""
                UPDATE playlists
                   SET {', '.join(set_parts)}
                 WHERE id = ${idx}
             RETURNING id::text, user_id, title, kind, is_public, handle, created_at, updated_at
                """,
                *values,
                pid,
            )
        except asyncpg.UniqueViolationError as e:
            cn = getattr(e, "constraint_name", "") or ""
            detail = getattr(e, "detail", "") or ""
            text = f"{cn} {detail}".lower()
            if "handle" in text:
                raise HTTPException(409, "Handle is already taken")
            raise HTTPException(409, "Failed to update playlist")

        result = dict(updated)
        agg = await con.fetchval(
            "SELECT seconds FROM playlist_listening_totals WHERE playlist_id=$1",
            pid,
        )

    result["listen_seconds"] = int(agg or 0)
    return result


@router.patch("/playlists/{playlist_id}")
async def update_playlist(
    playlist_id: str,
    payload: PlaylistUpdate = Body(...),
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    return await _perform_playlist_update(
        playlist_id=playlist_id, payload=payload, pool=pool, user_id=user_id
    )


def _get_method_override(request: Request) -> Optional[str]:
    override = request.query_params.get("_method")
    if not override:
        override = request.headers.get("X-HTTP-Method-Override")
    if not override:
        override = request.headers.get("X-Http-Method-Override")
    return override.upper() if override else None


async def _parse_override_payload(request: Request) -> PlaylistUpdate:
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip()

    if content_type == "application/json":
        data = await request.json()
    elif content_type in {
        "application/x-www-form-urlencoded",
        "multipart/form-data",
    }:
        form = await request.form()
        data = {}
        for key, value in form.multi_items():
            if key == "_method":
                continue
            if key == "handle_null":
                # form encodes handle=null as empty string + flag
                data.setdefault("handle", None)
                continue
            if key in {"title", "handle", "is_public"}:
                data[key] = value
        if "is_public" in data:
            data["is_public"] = str(data["is_public"]).lower() in {"1", "true", "yes"}
        if "handle" in data and data["handle"] == "":
            data["handle"] = None
    elif not content_type:
        data = await request.json()
    else:
        raise HTTPException(415, "Unsupported Media Type")

    if not isinstance(data, dict):
        raise HTTPException(400, "Invalid payload")

    # Query parameters may contain overrides for null handle when using JSON body
    if data.get("handle") == "" and request.query_params.get("handle_null"):
        data["handle"] = None

    return PlaylistUpdate(**data)


@router.post("/playlists/{playlist_id}")
async def override_update_playlist(
    request: Request,
    playlist_id: str,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    override = _get_method_override(request)
    if override not in {"PATCH"}:
        raise HTTPException(status.HTTP_405_METHOD_NOT_ALLOWED, "Method not allowed")

    payload = await _parse_override_payload(request)
    return await _perform_playlist_update(
        playlist_id=playlist_id, payload=payload, pool=pool, user_id=user_id
    )

@router.post("/playlists/{playlist_id}/update")
async def update_playlist_explicit(
    playlist_id: str,
    payload: PlaylistUpdate = Body(...),
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    """
    Простой "обнови плейлист" без PATCH и без override.
    Фронт будет стучаться сюда обычным POST.
    """
    return await _perform_playlist_update(
        playlist_id=playlist_id,
        payload=payload,
        pool=pool,
        user_id=user_id,
    )

@router.patch("/playlists/{playlist_id}/handle", status_code=status.HTTP_200_OK)
async def set_playlist_handle(
    playlist_id: str,
    payload: HandleUpdate,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    await _ensure_playlist_listening_totals(pool)
    try:
        pid = uuid.UUID(playlist_id)
    except Exception:
        raise HTTPException(400, "Invalid playlist_id")

    h = _clean_handle(payload.handle)
    if h is not None and not HANDLE_RE.fullmatch(h):
        raise HTTPException(400, "Handle must match ^[a-z0-9_]{3,32}$")

    async with pool.acquire() as con:
        owner = await con.fetchval("SELECT user_id FROM playlists WHERE id=$1", pid)
        if owner is None:
            raise HTTPException(404, "Playlist not found")
        if owner != user_id:
            raise HTTPException(403, "Forbidden")

        if h is not None:
            exists = await con.fetchval(
                "SELECT 1 FROM playlists WHERE lower(handle)=lower($1) AND id<>$2",
                h, pid,
            )
            if exists:
                raise HTTPException(409, "Handle is already taken")

        row = await con.fetchrow(
            """
            UPDATE playlists
               SET handle    = $2,
                   is_public = CASE WHEN $2 IS NULL THEN is_public ELSE TRUE END,
                   updated_at = now()
             WHERE id = $1
         RETURNING id::text, user_id, title, kind, is_public, handle, created_at, updated_at
            """,
            pid, h,
        )
        result = dict(row)
        agg = await con.fetchval(
            "SELECT seconds FROM playlist_listening_totals WHERE playlist_id=$1",
            pid,
        )

    result["listen_seconds"] = int(agg or 0)
    return result


@router.get("/playlists/default")
async def get_or_create_default_playlist(
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    async with pool.acquire() as con:
        pid = await _ensure_default_playlist(con, user_id)
        row = await con.fetchrow(
            """
            SELECT p.id::text, p.user_id, p.title, p.kind, p.is_public, p.handle,
                   p.created_at, p.updated_at,
                   (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id=p.id) AS item_count
            FROM playlists p WHERE p.id = $1
            """,
            pid,
        )
    return dict(row)


@router.get("/playlists/{playlist_id}/items")
async def get_playlist_items(
    playlist_id: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    try:
        pid = uuid.UUID(playlist_id)
    except Exception:
        raise HTTPException(400, "Invalid playlist_id")

    async with pool.acquire() as con:
        owner = await con.fetchval("SELECT user_id FROM playlists WHERE id=$1", pid)
        if owner is None:
            raise HTTPException(404, "Playlist not found")
        if owner != user_id:
            raise HTTPException(403, "Forbidden")

        rows = await con.fetch(
            """
            SELECT
              t.id::text          AS id,
              t.tg_msg_id         AS "msgId",
              t.chat_username     AS chat,
              t.title, t.artists, t.hashtags,
              t.duration_s        AS duration,
              t.mime, t.size_bytes, t.created_at,
              i.position, i.added_at
            FROM playlist_items i
            JOIN tracks t ON t.id = i.track_id
            WHERE i.playlist_id = $1
            ORDER BY i.position
            LIMIT $2 OFFSET $3
            """,
            pid, limit, offset,
        )
        total = await con.fetchval(
            "SELECT COUNT(*) FROM playlist_items WHERE playlist_id=$1", pid
        )

    return {
        "items": [dict(r) for r in rows],
        "limit": limit,
        "offset": offset,
        "total": total,
    }


@router.post("/playlists/{playlist_id}/items")
async def add_item_to_playlist(
    playlist_id: str,
    track_id: str,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
    x_method_override: Optional[str] = Header(default=None, alias="X-HTTP-Method-Override"),
):
    try:
        pid = uuid.UUID(playlist_id)
        tid = uuid.UUID(track_id)
    except Exception:
        raise HTTPException(400, "Invalid UUID")

    async with pool.acquire() as con:
        owner = await con.fetchval("SELECT user_id FROM playlists WHERE id=$1", pid)
        if owner is None:
            raise HTTPException(404, "Playlist not found")
        if owner != user_id:
            raise HTTPException(403, "Forbidden")

        # Fallback: POST + X-HTTP-Method-Override: DELETE
        if (x_method_override or "").strip().upper() == "DELETE":
            n = await _delete_item_by_track(con, pid, tid)
            if n == 0:
                raise HTTPException(404, "Item not found")
            return {"ok": True}

        exists = await con.fetchval("SELECT 1 FROM tracks WHERE id=$1", tid)
        if not exists:
            raise HTTPException(404, "Track not found")

        await con.execute(
            """
            INSERT INTO playlist_items (playlist_id, track_id)
            VALUES ($1, $2)
            ON CONFLICT (playlist_id, track_id) DO NOTHING
            """,
            pid, tid,
        )
        row = await con.fetchrow(
            "SELECT position, added_at FROM playlist_items WHERE playlist_id=$1 AND track_id=$2",
            pid, tid,
        )
    return {"playlist_id": str(pid), "track_id": str(tid), **(dict(row) if row else {})}


# ---------- deletion by playlist_id ----------

@router.delete("/playlists/{playlist_id}/items/{track_id}")
async def remove_item_by_track_path(
    playlist_id: str,
    track_id: str,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    try:
        pid = uuid.UUID(playlist_id)
        tid = uuid.UUID(track_id)
    except Exception:
        raise HTTPException(400, "Invalid UUID")

    async with pool.acquire() as con:
        owner = await con.fetchval("SELECT user_id FROM playlists WHERE id=$1", pid)
        if owner is None:
            raise HTTPException(404, "Playlist not found")
        if owner != user_id:
            raise HTTPException(403, "Forbidden")

        n = await _delete_item_by_track(con, pid, tid)
        if n == 0:
            raise HTTPException(404, "Item not found")
    return {"ok": True}


@router.delete("/playlists/{playlist_id}/items/by-msg/{msg_id}")
async def remove_item_by_msg_path(
    playlist_id: str,
    msg_id: int,
    chat: str = Query(...),
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    try:
        pid = uuid.UUID(playlist_id)
    except Exception:
        raise HTTPException(400, "Invalid playlist_id")

    async with pool.acquire() as con:
        owner = await con.fetchval("SELECT user_id FROM playlists WHERE id=$1", pid)
        if owner is None:
            raise HTTPException(404, "Playlist not found")
        if owner != user_id:
            raise HTTPException(403, "Forbidden")

        n = await _delete_item_by_msg(con, pid, msg_id, chat)
        if n == 0:
            raise HTTPException(404, "Item not found")
    return {"ok": True}


@router.delete("/playlists/{playlist_id}/items")
async def remove_item_by_query(
    playlist_id: str,
    track_id: Optional[str] = Query(None),
    msg_id: Optional[int] = Query(None),
    chat: Optional[str] = Query(None),
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    # должен прийти track_id ИЛИ (msg_id и chat)
    if not track_id and not (msg_id and chat):
        raise HTTPException(422, "Provide track_id OR (msg_id AND chat)")

    if track_id:
        return await remove_item_by_track_path(playlist_id, track_id, pool, user_id)
    else:
        return await remove_item_by_msg_path(playlist_id, int(msg_id), chat or "", pool, user_id)


@router.post("/playlists/{playlist_id}/items/remove")
async def remove_item_by_post(
    playlist_id: str,
    body: RemoveItemBody,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    if body.track_id:
        return await remove_item_by_track_path(playlist_id, body.track_id, pool, user_id)
    if body.msg_id is not None and body.chat:
        return await remove_item_by_msg_path(playlist_id, int(body.msg_id), body.chat, pool, user_id)
    raise HTTPException(422, "Provide track_id OR (msg_id AND chat)")


@router.delete("/playlists/{playlist_id}")
async def delete_playlist(
    playlist_id: str,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    try:
        pid = uuid.UUID(playlist_id)
    except Exception:
        raise HTTPException(400, "Invalid playlist_id")

    async with pool.acquire() as con:
        owner = await con.fetchval("SELECT user_id FROM playlists WHERE id=$1", pid)
        if owner is None:
            raise HTTPException(404, "Playlist not found")
        if owner != user_id:
            raise HTTPException(403, "Forbidden")

        async with con.transaction():
            await con.execute("DELETE FROM playlist_items WHERE playlist_id=$1", pid)
            await con.execute("DELETE FROM playlists WHERE id=$1", pid)

    return {"ok": True}


@router.post("/playlists/{playlist_id}/delete")
async def delete_playlist_post(
    playlist_id: str,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    return await delete_playlist(playlist_id, pool, user_id)


@router.delete("/playlists/by-handle/{handle}")
async def delete_playlist_by_handle(
    handle: str,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    h = _clean_handle(handle)
    if not h or not HANDLE_RE.fullmatch(h):
        raise HTTPException(400, "Invalid handle format")

    async with pool.acquire() as con:
        row = await con.fetchrow(
            "SELECT id, user_id FROM playlists WHERE lower(handle)=lower($1)",
            h,
        )
        if not row:
            raise HTTPException(404, "Playlist not found")
        pid = row["id"]
        owner = row["user_id"]
        if owner != user_id:
            raise HTTPException(403, "Forbidden")

        async with con.transaction():
            await con.execute("DELETE FROM playlist_items WHERE playlist_id=$1", pid)
            await con.execute("DELETE FROM playlists WHERE id=$1", pid)

    return {"ok": True}


@router.post("/playlists/by-handle/{handle}/delete")
async def delete_playlist_by_handle_post(
    handle: str,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    return await delete_playlist_by_handle(handle, pool, user_id)


# ---------- public by handle ----------

@router.get("/playlists/by-handle/{handle}")
async def get_public_playlist_by_handle(
    handle: str,
    pool: asyncpg.Pool = Depends(_get_pool),
):
    await _ensure_playlist_listening_totals(pool)
    h = _clean_handle(handle)
    if not h or not HANDLE_RE.fullmatch(h):
        raise HTTPException(400, "Invalid handle format")
    async with pool.acquire() as con:
        row = await con.fetchrow(
            """
            SELECT p.id::text, p.user_id, p.title, p.kind, p.is_public, p.handle,
                   p.created_at, p.updated_at,
                   COALESCE(lst.seconds, 0) AS listen_seconds
            FROM playlists p
            LEFT JOIN playlist_listening_totals lst ON lst.playlist_id = p.id
            WHERE p.is_public = true AND lower(p.handle)=lower($1)
            """,
            h,
        )
    if not row:
        raise HTTPException(404, "Playlist not found")
    result = dict(row)
    result["listen_seconds"] = int(result.get("listen_seconds") or 0)
    return result


@router.get("/playlists/by-handle/{handle}/items")
async def get_public_playlist_items_by_handle(
    handle: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    pool: asyncpg.Pool = Depends(_get_pool),
):
    h = _clean_handle(handle)
    if not h or not HANDLE_RE.fullmatch(h):
        raise HTTPException(400, "Invalid handle")

    async with pool.acquire() as con:
        pid = await con.fetchval(
            "SELECT id FROM playlists WHERE is_public=true AND lower(handle)=lower($1)",
            h,
        )
        if not pid:
            raise HTTPException(404, "Playlist not found")

        rows = await con.fetch(
            """
            SELECT
              t.id::text AS id,
              t.tg_msg_id AS "msgId",
              t.chat_username AS chat,
              t.title, t.artists, t.hashtags,
              t.duration_s AS duration,
              t.mime, t.size_bytes, t.created_at,
              i.position, i.added_at
            FROM playlist_items i
            JOIN tracks t ON t.id = i.track_id
            WHERE i.playlist_id = $1
            ORDER BY i.position
            LIMIT $2 OFFSET $3
            """,
            pid, limit, offset,
        )
        total = await con.fetchval(
            "SELECT COUNT(*) FROM playlist_items WHERE playlist_id=$1", pid
        )

    return {
        "items": [dict(r) for r in rows],
        "limit": limit,
        "offset": offset,
        "total": total,
    }


@router.delete("/playlists/by-handle/{handle}/items/{track_id}")
async def remove_item_public_by_track_path(
    handle: str,
    track_id: str,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    h = _clean_handle(handle)
    if not h or not HANDLE_RE.fullmatch(h):
        raise HTTPException(400, "Invalid handle format")
    try:
        tid = uuid.UUID(track_id)
    except Exception:
        raise HTTPException(400, "Invalid UUID")

    async with pool.acquire() as con:
        row = await con.fetchrow(
            "SELECT id, user_id FROM playlists WHERE is_public=true AND lower(handle)=lower($1)",
            h,
        )
        if not row:
            raise HTTPException(404, "Playlist not found")
        pid, owner = row["id"], row["user_id"]
        if owner != user_id:
            raise HTTPException(403, "Forbidden")

        n = await _delete_item_by_track(con, pid, tid)
        if n == 0:
            raise HTTPException(404, "Item not found")
    return {"ok": True}


@router.delete("/playlists/by-handle/{handle}/items/by-msg/{msg_id}")
async def remove_item_public_by_msg_path(
    handle: str,
    msg_id: int,
    chat: str = Query(...),
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    h = _clean_handle(handle)
    if not h or not HANDLE_RE.fullmatch(h):
        raise HTTPException(400, "Invalid handle format")

    async with pool.acquire() as con:
        row = await con.fetchrow(
            "SELECT id, user_id FROM playlists WHERE is_public=true AND lower(handle)=lower($1)",
            h,
        )
        if not row:
            raise HTTPException(404, "Playlist not found")
        pid, owner = row["id"], row["user_id"]
        if owner != user_id:
            raise HTTPException(403, "Forbidden")

        n = await _delete_item_by_msg(con, pid, msg_id, chat)
        if n == 0:
            raise HTTPException(404, "Item not found")
    return {"ok": True}


@router.delete("/playlists/by-handle/{handle}/items")
async def remove_item_public_by_query(
    handle: str,
    track_id: Optional[str] = Query(None),
    msg_id: Optional[int] = Query(None),
    chat: Optional[str] = Query(None),
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    if not track_id and not (msg_id and chat):
        raise HTTPException(422, "Provide track_id OR (msg_id AND chat)")
    if track_id:
        return await remove_item_public_by_track_path(handle, track_id, pool, user_id)
    else:
        return await remove_item_public_by_msg_path(handle, int(msg_id), chat or "", pool, user_id)


@router.post("/playlists/by-handle/{handle}/items")
async def remove_item_public_by_handle_override(
    handle: str,
    track_id: Optional[str] = Query(None),
    msg_id: Optional[int] = Query(None),
    chat: Optional[str] = Query(None),
    x_method_override: Optional[str] = Header(default=None, alias="X-HTTP-Method-Override"),
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    # POST + X-HTTP-Method-Override: DELETE
    if (x_method_override or "").strip().upper() == "DELETE":
        if track_id:
            return await remove_item_public_by_track_path(handle, track_id, pool, user_id)
        if msg_id is not None and chat:
            return await remove_item_public_by_msg_path(handle, int(msg_id), chat, pool, user_id)
        raise HTTPException(422, "Provide track_id OR (msg_id AND chat)")
    raise HTTPException(405, "Method Not Allowed")


@router.post("/playlists/by-handle/{handle}/items/remove")
async def remove_item_public_by_post(
    handle: str,
    body: RemoveItemBody,
    pool: asyncpg.Pool = Depends(_get_pool),
    user_id: int = Depends(get_current_user),
):
    if body.track_id:
        return await remove_item_public_by_track_path(handle, body.track_id, pool, user_id)
    if body.msg_id is not None and body.chat:
        return await remove_item_public_by_msg_path(handle, int(body.msg_id), body.chat, pool, user_id)
    raise HTTPException(422, "Provide track_id OR (msg_id AND chat)")