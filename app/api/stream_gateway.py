#/home/ogma/ogma/app/api/stream_gateway.py

from __future__ import annotations

import os
import asyncio as _asyncio
import logging
from typing import AsyncGenerator, Optional, Tuple, List

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi import Query
from fastapi.responses import StreamingResponse

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import InputDocumentFileLocation, Document
from telethon.tl.functions.upload import GetFileRequest as _GetFileRequestOrig
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.errors.rpcerrorlist import UserAlreadyParticipantError

# --- Auth mode: bot vs user session ---
BOT_TOKEN: str = os.environ.get("TELEGRAM_BOT_TOKEN", "") or os.environ.get("BOT_TOKEN", "")
_IS_BOT: Optional[bool] = None  # определяем один раз в _ensure_tg()

# --- robust imports for Telethon errors ---
try:
    from telethon.errors import FloodWaitError  # type: ignore
except Exception:
    try:
        from telethon.errors.rpcerrorlist import FloodWaitError  # type: ignore
    except Exception:  # fallback stub
        class FloodWaitError(Exception):  # type: ignore
            def __init__(self, seconds=3):
                self.seconds = seconds

try:
    from telethon.errors import RPCError as _RPCError  # type: ignore
except Exception:
    try:
        from telethon.errors.rpcbase import RPCError as _RPCError  # type: ignore
    except Exception:
        _RPCError = Exception  # type: ignore

from contextlib import suppress
import asyncpg

# Метрики (безопасно, если прометей не используется)
try:
    from app.api.telemetry.metrics import (
        STREAM_START_TOTAL,
        STREAM_BYTES_TOTAL,
        DOWNLOAD_START_TOTAL,
        TG_FLOODWAITS_TOTAL,
        TG_RPC_ERRORS_TOTAL,
    )
except Exception:
    STREAM_START_TOTAL = STREAM_BYTES_TOTAL = DOWNLOAD_START_TOTAL = None  # type: ignore
    TG_FLOODWAITS_TOTAL = TG_RPC_ERRORS_TOTAL = None  # type: ignore

from app.api.telemetry.eventlog import EventLog

# Логгер модуля
log = logging.getLogger("app.tgstream")

# --- OGMA patch A (compat clamp): ограничиваем limit<=512 KiB и поддерживаем разные версии Telethon ---
try:
    import inspect as _inspect

    try:
        _OGMA_GFR_PARAMS = set(_inspect.signature(_GetFileRequestOrig).parameters)
    except Exception:
        _OGMA_GFR_PARAMS = set(_inspect.signature(_GetFileRequestOrig.__init__).parameters)
    _OGMA_GFR_PARAMS.discard("self")

    def GetFileRequest(*, location, offset, limit, precise=False, cdn_supported=False, **kw):
        MAX = 512 * 1024  # 512 KiB
        try:
            lim = int(limit)
        except Exception:
            lim = MAX
        if lim <= 0 or lim > MAX:
            lim = MAX

        _args = dict(location=location, offset=int(offset), limit=lim)
        if "precise" in _OGMA_GFR_PARAMS:
            _args["precise"] = precise
        if "cdn_supported" in _OGMA_GFR_PARAMS:
            _args["cdn_supported"] = cdn_supported
        if "cdn_file_hash" in _OGMA_GFR_PARAMS and "cdn_file_hash" in kw:
            _args["cdn_file_hash"] = kw["cdn_file_hash"]

        return _GetFileRequestOrig(**_args)
except Exception:  # pragma: no cover
    def GetFileRequest(*, location, offset, limit, precise=False, cdn_supported=False, **kw):  # type: ignore
        MAX = 512 * 1024
        try:
            lim = int(limit)
        except Exception:
            lim = MAX
        if lim <= 0 or lim > MAX:
            lim = MAX
        return _GetFileRequestOrig(location=location, offset=int(offset), limit=lim)

router = APIRouter()

_TG: Optional[TelegramClient] = None
_TG_LOCK = _asyncio.Lock()

CHUNK = 512 * 1024  # 512 KiB
_RETRIES = 3
_BACKOFF_BASE = 0.5  # seconds


async def _ensure_tg():
    """Гарантирует, что глобальный Telethon-клиент создан и ПОДКЛЮЧЕН.
       Поддерживает авторизацию как ПОЛЬЗОВАТЕЛЬ (session) и как БОТ (BOT_TOKEN)."""
    global _TG, _IS_BOT
    async with _TG_LOCK:
        if _TG is None:
            try:
                api_id = int(os.environ["TELEGRAM_API_ID"])
                api_hash = os.environ["TELEGRAM_API_HASH"]

                # 1) если задана TELEGRAM_STRING_SESSION — используем её (никаких файлов → нет SQLite lock)
                ss = (os.environ.get("TELEGRAM_STRING_SESSION", "") or "").strip()
                if ss:
                    sess = StringSession(ss)
                else:
                    # 2) иначе файловая сессия, но уникальная на процесс
                    base = (os.environ.get("TELEGRAM_SESSION", "") or "ogma-tg").strip()
                    if base.endswith(".session"):
                        base = base[:-8]
                    # нормализуем путь и создаём директорию при необходимости
                    base = os.path.expanduser(base)
                    d = os.path.dirname(base)
                    if d:
                        os.makedirs(d, exist_ok=True)
                    sess = f"{base}.{os.getpid()}"  # <base>.<PID>.session

                _TG = TelegramClient(sess, api_id, api_hash)
            except KeyError as e:
                raise HTTPException(500, f"Missing env: {e.args[0]}")

        if not _TG.is_connected():
            await _TG.connect()

        try:
            ok = await _TG.is_user_authorized()
        except Exception:
            await _TG.connect()
            ok = await _TG.is_user_authorized()

        # если нет авторизации — пробуем бот-токен
        if not ok and BOT_TOKEN:
            await _TG.start(bot_token=BOT_TOKEN)  # сохранит бот-сессию в файл
            ok = await _TG.is_user_authorized()

        if not ok:
            raise HTTPException(
                500,
                "Telethon session is not authorized. Задайте TELEGRAM_BOT_TOKEN или авторизуйте TELEGRAM_SESSION.",
            )

        # определить, бот это или нет (один раз)
        if _IS_BOT is None:
            try:
                me = await _TG.get_me()
                _IS_BOT = bool(getattr(me, "bot", False))
            except Exception:
                _IS_BOT = False


async def _ensure_join(chat_username: str):
    """Для пользователя пробуем JoinChannel. Для бота — ничего (бот должен быть добавлен вручную)."""
    await _ensure_tg()
    assert _TG is not None
    if _IS_BOT:
        return

    for attempt in range(_RETRIES):
        try:
            await _TG(JoinChannelRequest(chat_username))
            return
        except UserAlreadyParticipantError:
            return
        except FloodWaitError as e:
            if TG_FLOODWAITS_TOTAL:
                with suppress(Exception):
                    TG_FLOODWAITS_TOTAL.labels(op="JoinChannel").inc()
            await _asyncio.sleep(getattr(e, "seconds", 3))
        except _RPCError as e:
            if "BOT_METHOD_INVALID" in str(e):  # на всякий случай
                return
            if TG_RPC_ERRORS_TOTAL:
                with suppress(Exception):
                    TG_RPC_ERRORS_TOTAL.labels(op="JoinChannel").inc()
            await _TG.connect()
            await _asyncio.sleep(_BACKOFF_BASE * (2 ** attempt))
        except Exception:
            await _TG.connect()
            await _asyncio.sleep(_BACKOFF_BASE * (2 ** attempt))
    return


async def _db_get_track(pool: asyncpg.Pool, track_id: str) -> dict:
    sql = """
    select id::text,
           tg_msg_id,
           chat_username,
           title,
           artists,
           mime,
           size_bytes
      from tracks
     where id = $1::uuid
     limit 1;
    """
    row = await pool.fetchrow(sql, track_id)
    if not row:
        raise HTTPException(404, "Track not found")
    return dict(row)


async def _get_document(chat_username: str, msg_id: int) -> Document:
    await _ensure_tg()
    assert _TG is not None
    for attempt in range(_RETRIES):
        try:
            msg = await _TG.get_messages(chat_username, ids=msg_id)
            if not msg or not msg.document:
                raise HTTPException(404, "Message or document not found in Telegram")
            return msg.document
        except FloodWaitError as e:
            if TG_FLOODWAITS_TOTAL:
                with suppress(Exception):
                    TG_FLOODWAITS_TOTAL.labels(op="get_messages").inc()
            await _asyncio.sleep(getattr(e, "seconds", 3))
        except _RPCError as e:
            if TG_RPC_ERRORS_TOTAL:
                with suppress(Exception):
                    TG_RPC_ERRORS_TOTAL.labels(op="get_messages").inc()
            await _TG.connect()
            await _asyncio.sleep(_BACKOFF_BASE * (2 ** attempt))
        except (ConnectionError, OSError) as e:
            await _TG.connect()
            await _asyncio.sleep(_BACKOFF_BASE * (2 ** attempt))
    raise HTTPException(502, "Telegram upstream unavailable")


def _parse_range(range_header: Optional[str], size: int) -> Tuple[int, int, bool]:
    if not range_header or not range_header.startswith("bytes="):
        return 0, size - 1, False
    spec = range_header.split("=", 1)[1].strip()
    if "," in spec:
        raise HTTPException(416, "Multiple ranges not supported")
    start_s, _, end_s = spec.partition("-")
    if start_s == "":
        try:
            suffix = int(end_s)
        except Exception:
            raise HTTPException(416, "Invalid range")
        if suffix <= 0:
            raise HTTPException(416, "Invalid range")
        start = max(size - suffix, 0)
        end = size - 1
    else:
        try:
            start = int(start_s)
        except Exception:
            raise HTTPException(416, "Invalid range")
        if end_s:
            try:
                end = int(end_s)
            except Exception:
                raise HTTPException(416, "Invalid range")
        else:
            end = size - 1
    if start >= size:
        raise HTTPException(416, "Range Not Satisfiable")
    if end >= size:
        end = size - 1
    if start > end:
        raise HTTPException(416, "Invalid range")
    return start, end, True


async def _tg_byte_iter(doc: Document, start: int, end: int) -> AsyncGenerator[bytes, None]:
    await _ensure_tg()
    assert _TG is not None

    loc = InputDocumentFileLocation(
        id=doc.id,
        access_hash=doc.access_hash,
        file_reference=doc.file_reference,
        thumb_size="",
    )

    base = start - (start % CHUNK)
    offset = base
    to_send = end - start + 1
    first = True

    while to_send > 0:
        last_exc = None
        for attempt in range(_RETRIES):
            try:
                resp = await _TG(
                    GetFileRequest(
                        location=loc,
                        offset=offset,
                        limit=CHUNK,
                        precise=True,
                        cdn_supported=True,
                    )
                )
                orig = getattr(resp, "bytes", b"")
                if not orig:
                    return
                buf = orig

                if first and start > base:
                    cut = start - base
                    buf = buf[cut:] if cut < len(buf) else b""
                    first = False

                if len(buf) > to_send:
                    buf = buf[:to_send]

                if buf:
                    yield buf
                    to_send -= len(buf)

                offset += len(orig)
                break
            except FloodWaitError as e:
                last_exc = e
                if TG_FLOODWAITS_TOTAL:
                    with suppress(Exception):
                        TG_FLOODWAITS_TOTAL.labels(op="GetFile").inc()
                await _TG.connect()
                await _asyncio.sleep(getattr(e, "seconds", 3))
            except _RPCError as e:
                last_exc = e
                if TG_RPC_ERRORS_TOTAL:
                    with suppress(Exception):
                        TG_RPC_ERRORS_TOTAL.labels(op="GetFile").inc()
                await _TG.connect()
                await _asyncio.sleep(_BACKOFF_BASE * (2 ** attempt))
            except (ConnectionError, OSError) as e:
                last_exc = e
                await _TG.connect()
                await _asyncio.sleep(_BACKOFF_BASE * (2 ** attempt))
        else:
            if last_exc:
                raise last_exc
            return


# строгий резак диапазона (safety)
async def _range_guard(start: int | None, end: int | None, agen: AsyncGenerator[bytes, None]):
    if start is None or end is None:
        async for chunk in agen:
            if chunk:
                yield chunk
        return
    total = end - start + 1
    sent = 0
    async for chunk in agen:
        if not chunk:
            continue
        remain = total - sent
        if remain <= 0:
            break
        if len(chunk) > remain:
            chunk = chunk[:remain]
        sent += len(chunk)
        yield chunk


def _filename_from(title: Optional[str], artists: Optional[List[str]], mime: Optional[str]) -> str:
    base = title or ""
    if artists:
        a = ", ".join(artists)
        base = f"{a} - {base}" if base else a
    base = base or "track"
    safe = "".join(c for c in base if c.isalnum() or c in " .,_-").strip()
    ext = ""
    if mime and "/" in mime:
        mt = mime.split("/", 1)[1].lower()
        if mt == "mpeg":
            ext = ".mp3"
        elif mt in {"wav", "x-wav"}:
            ext = ".wav"
        else:
            ext = f".{mt}"
    return (safe or "track") + ext


# --- auth helpers ---
try:
    from app.api.users import _verify_webapp_init_data  # type: ignore
except Exception:
    def _verify_webapp_init_data(_: str):  # fallback
        return {}


def _maybe_user_id(req: Request) -> Optional[int]:
    # 1) заголовок
    init_data = req.headers.get("x-telegram-init-data")
    # 2) либо query-параметр init (для <audio> без заголовков)
    if not init_data:
        init_data = req.query_params.get("init")
    if init_data:
        try:
            u = _verify_webapp_init_data(init_data)
            return int(u["id"])
        except Exception:
            return None
    # dev/debug
    if os.environ.get("ALLOW_DEBUG_HEADERS", "0").lower() in {"1", "true", "yes"}:
        x = req.headers.get("x-debug-user-id")
        try:
            return int(x) if x else None
        except Exception:
            return None
    return None


async def _log_play(pool: asyncpg.Pool, user_id: int, track_id: str):
    try:
        await pool.execute(
            "insert into history(user_id, track_id, action) values ($1, $2::uuid, 'play')",
            user_id, track_id
        )
    except Exception:
        pass


# --- endpoints ---

@router.get("/stream/{track_id}")
async def stream_track(track_id: str, request: Request):
    pool: asyncpg.Pool = request.app.state.pool
    if not pool:
        raise HTTPException(503, "DB pool not ready")
    t = await _db_get_track(pool, track_id)

    uid = _maybe_user_id(request)
    if uid:
        _asyncio.create_task(_log_play(pool, uid, t["id"]))

    doc = await _get_document(t["chat_username"], t["tg_msg_id"])
    size = int(getattr(doc, "size", 0) or t.get("size_bytes") or 0)
    if size <= 0:
        raise HTTPException(500, "Unknown file size")
    mime = t.get("mime") or (getattr(doc, "mime_type", None) or "application/octet-stream")

    r = request.headers.get("range")
    start, end, partial = _parse_range(r, size)

    ev: EventLog | None = getattr(request.app.state, "eventlog", None)
    chat_username = t["chat_username"]
    if STREAM_START_TOTAL:
        with suppress(Exception):
            STREAM_START_TOTAL.labels(chat=chat_username, partial=str(partial).lower(), mime=mime).inc()
    if ev:
        await ev.send(
            "stream",
            f"▶️ <b>stream</b> id=<code>{t['id']}</code> chat=<code>{chat_username}</code>\n"
            f"bytes=<code>{start}-{end}</code> of <code>{size}</code> mime=<code>{mime}</code>"
        )

    msg_id = t["tg_msg_id"]
    total_sent = 0

    async def body():
        nonlocal total_sent
        try:
            agen = _range_guard(start, end, _tg_byte_iter(doc, start, end))
            async for chunk in agen:
                if chunk:
                    total_sent += len(chunk)
                    yield chunk
        except FloodWaitError as e:
            log.warning("TG FloodWait on %s/%s: %s", chat_username, msg_id, getattr(e, "seconds", None))
            raise HTTPException(status_code=429, detail=f"Telegram rate limit, wait {getattr(e,'seconds',3)}s")
        except _RPCError as e:
            log.error("TG RPCError on %s/%s: %r", chat_username, msg_id, e)
            raise HTTPException(status_code=502, detail=f"Telegram RPC error: {e.__class__.__name__}")
        except (ConnectionError, OSError) as e:
            log.error("TG network error on %s/%s: %r", chat_username, msg_id, e)
            raise HTTPException(status_code=502, detail="Telegram network error")
        except Exception:
            log.exception("Unexpected error streaming %s/%s", chat_username, msg_id)
            raise HTTPException(status_code=500, detail="Unexpected error")
        finally:
            if STREAM_BYTES_TOTAL and total_sent:
                with suppress(Exception):
                    STREAM_BYTES_TOTAL.labels(chat=chat_username).inc(total_sent)

    headers = {
        "Accept-Ranges": "bytes",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-transform",
        "Content-Encoding": "identity",
    }
    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        headers["Content-Length"] = str(end - start + 1)
        return StreamingResponse(body(), status_code=206, media_type=mime, headers=headers)
    else:
        headers["Content-Length"] = str(size)
        return StreamingResponse(body(), status_code=200, media_type=mime, headers=headers)


@router.get("/download/{track_id}")
async def download_track(track_id: str, request: Request):
    pool: asyncpg.Pool = request.app.state.pool
    if not pool:
        raise HTTPException(503, "DB pool not ready")
    t = await _db_get_track(pool, track_id)

    uid = _maybe_user_id(request)
    if uid:
        _asyncio.create_task(_log_play(pool, uid, t["id"]))

    doc = await _get_document(t["chat_username"], t["tg_msg_id"])
    size = int(getattr(doc, "size", 0) or t.get("size_bytes") or 0)
    if size <= 0:
        raise HTTPException(500, "Unknown file size")
    mime = t.get("mime") or (getattr(doc, "mime_type", None) or "application/octet-stream")
    fname = _filename_from(t.get("title"), t.get("artists"), mime)

    r = request.headers.get("range")
    start, end, partial = _parse_range(r, size)

    ev: EventLog | None = getattr(request.app.state, "eventlog", None)
    chat_username = t["chat_username"]
    if DOWNLOAD_START_TOTAL:
        with suppress(Exception):
            DOWNLOAD_START_TOTAL.labels(chat=chat_username, mime=mime).inc()
    if ev:
        await ev.send(
            "download",
            f"⬇️ <b>download</b> id=<code>{t['id']}</code> chat=<code>{chat_username}</code>\n"
            f"bytes=<code>{start}-{end}</code> of <code>{size}</code> mime=<code>{mime}</code>\n"
            f"file=<code>{fname}</code>"
        )

    msg_id = t["tg_msg_id"]

    async def body():
        try:
            agen = _range_guard(start, end, _tg_byte_iter(doc, start, end))
            async for chunk in agen:
                if chunk:
                    yield chunk
        except FloodWaitError as e:
            log.warning("TG FloodWait on %s/%s: %s", chat_username, msg_id, getattr(e, "seconds", None))
            raise HTTPException(status_code=429, detail=f"Telegram rate limit, wait {getattr(e,'seconds',3)}s")
        except _RPCError as e:
            log.error("TG RPCError on %s/%s: %r", chat_username, msg_id, e)
            raise HTTPException(status_code=502, detail=f"Telegram RPC error: {e.__class__.__name__}")
        except (ConnectionError, OSError) as e:
            log.error("TG network error on %s/%s: %r", chat_username, msg_id, e)
            raise HTTPException(status_code=502, detail="Telegram network error")
        except Exception:
            log.exception("Unexpected error streaming %s/%s", chat_username, msg_id)
            raise HTTPException(status_code=500, detail="Unexpected error")

    headers = {
        "Accept-Ranges": "bytes",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-transform",
        "Content-Encoding": "identity",
        "Content-Disposition": f'attachment; filename="{fname}"',
    }
    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        headers["Content-Length"] = str(end - start + 1)
        return StreamingResponse(body(), status_code=206, media_type=mime, headers=headers)
    else:
        headers["Content-Length"] = str(size)
        return StreamingResponse(body(), status_code=200, media_type=mime, headers=headers)


# --- resilient full download (без Range) ---
@router.get("/download2/{track_id}")
async def download_track_resilient(track_id: str, request: Request):
    async with request.app.state.pool.acquire() as con:
        t = await con.fetchrow(
            """
            select id::text, tg_msg_id, chat_username, title, artists, mime, size_bytes
            from tracks where id=$1::uuid
        """,
            track_id,
        )
    if not t:
        raise HTTPException(404, "Track not found")

    await _ensure_tg()
    assert _TG is not None
    doc = await _get_document(t["chat_username"], t["tg_msg_id"])
    total = int(t["size_bytes"] or 0)
    if total <= 0:
        raise HTTPException(500, "Unknown file size")

    title = t["title"] or "track"
    artists = ", ".join(t["artists"] or [])
    ext = ".mp3" if (t["mime"] or "").endswith("mpeg") else ""
    filename = f"{artists + ' - ' if artists else ''}{title}{ext}".strip().replace("/", "_")

    async def generator():
        offset = 0
        chunk = 512 * 1024
        retries = 0
        while offset < total:
            try:
                async for data in _TG.iter_download(doc, offset=offset, chunk_size=chunk, request_size=chunk):
                    if not data:
                        break
                    offset += len(data)
                    yield data
                if offset >= total:
                    break
                raise RuntimeError("short read")
            except Exception:
                retries += 1
                if retries > 5:
                    raise
                await _asyncio.sleep(0.5 * retries)

    headers = {
        "Accept-Ranges": "bytes",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-transform",
        "Content-Encoding": "identity",
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Type": t["mime"] or "application/octet-stream",
        "Content-Length": str(total),
    }
    return StreamingResponse(generator(), headers=headers, status_code=200)


@router.head("/stream/{track_id}")
async def head_stream(track_id: str, request: Request):
    pool = request.app.state.pool
    if not pool:
        raise HTTPException(503, "DB pool not ready")
    t = await _db_get_track(pool, track_id)

    uid = _maybe_user_id(request)
    if uid:
        _asyncio.create_task(_log_play(pool, uid, t["id"]))

    doc = await _get_document(t["chat_username"], t["tg_msg_id"])
    size = int(getattr(doc, "size", 0) or t.get("size_bytes") or 0)
    if size <= 0:
        raise HTTPException(500, "Unknown file size")
    mime = t.get("mime") or (getattr(doc, "mime_type", None) or "application/octet-stream")

    headers = {
        "Accept-Ranges": "bytes",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-transform",
        "Content-Encoding": "identity",
        "Content-Length": str(size),
        "Content-Type": mime,
    }
    return Response(status_code=200, headers=headers, media_type=mime)


async def close_tg():
    global _TG
    async with _TG_LOCK:
        if _TG is not None:
            with suppress(Exception):
                await _TG.disconnect()
            _TG = None


@router.get("/stream/by-msg/{msg_id}")
async def stream_by_msg(
    msg_id: int,
    request: Request,
    chat: str = Query(..., description="username канала, можно с @"),
):
    log.error("### OGMA DEBUG ENTER stream_by_msg chat=%s msg_id=%s", chat, msg_id)
    # 1. нормализуем имя канала
    chat_username = (chat or "").strip().lstrip("@").lower()
    if not chat_username:
        raise HTTPException(
            status_code=400,
            detail="Query 'chat' is required (username канала без @)",
        )

    # 2. пытаемся зайти в канал (если юзер-сессия). Если нельзя зайти -> 404, а не 500
    try:
        await _ensure_join(chat_username)
    except HTTPException as e:
        # если _ensure_join внутри уже вернуло HTTPException (e.g. сессии нет) — прокинем как есть
        raise e
    except Exception as e:
        # приватный канал / нет доступа и т.п.
        raise HTTPException(
            status_code=404,
            detail=f"Cannot access chat '{chat_username}': {e.__class__.__name__}",
        )

    # 3. достаём сам документ из телеги
    try:
        doc = await _get_document(chat_username, msg_id)
    except HTTPException as e:
        # _get_document уже делает 404/502 → просто пробрасываем
        raise e
    except _RPCError as e:
        # Ошибки Telegram уровня RPC (например CHAT_WRITE_FORBIDDEN, CHANNEL_PRIVATE...)
        raise HTTPException(
            status_code=404,
            detail=f"Telegram RPC access error: {e.__class__.__name__}",
        )
    except Exception as e:
        # Любое иное неожиданное — отдаём 502, чтобы фронт понимал "у телеги чихнуло"
        raise HTTPException(
            status_code=502,
            detail=f"Telegram upstream error: {e.__class__.__name__}",
        )

    # 4. валидируем размер/миме
    size = int(getattr(doc, "size", 0) or 0)
    if size <= 0:
        mt = getattr(doc, "mime_type", "unknown")
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported/unknown Telegram file size (mime={mt})",
        )

    mime = getattr(doc, "mime_type", None) or "application/octet-stream"

    # 5. поддерживаем Range
    r = request.headers.get("range")
    start, end, partial = _parse_range(r, size)

    async def body():
        try:
            agen = _range_guard(start, end, _tg_byte_iter(doc, start, end))
            async for chunk in agen:
                if chunk:
                    yield chunk
        except FloodWaitError as e:
            log.warning(
                "TG FloodWait on %s/%s: %s",
                chat_username,
                msg_id,
                getattr(e, "seconds", None),
            )
            raise HTTPException(
                status_code=429,
                detail=f"Telegram rate limit, wait {getattr(e,'seconds',3)}s",
            )
        except _RPCError as e:
            log.error(
                "TG RPCError on %s/%s: %r",
                chat_username,
                msg_id,
                e,
            )
            raise HTTPException(
                status_code=502,
                detail=f"Telegram RPC error: {e.__class__.__name__}",
            )
        except (ConnectionError, OSError) as e:
            log.error(
                "TG network error on %s/%s: %r",
                chat_username,
                msg_id,
                e,
            )
            raise HTTPException(
                status_code=502,
                detail="Telegram network error",
            )
        except Exception as e:
            log.exception(
                "Unexpected error streaming %s/%s: %r",
                chat_username,
                msg_id,
                e,
            )
            raise HTTPException(
                status_code=404,
                detail="File is no longer available from Telegram",
            )

    headers = {
        "Accept-Ranges": "bytes",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-transform",
        "Content-Encoding": "identity",
    }

    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        headers["Content-Length"] = str(end - start + 1)

        log.error("### OGMA DEBUG stream_by_msg ACTIVE code is running for chat=%s msg_id=%s", chat_username, msg_id)

        return StreamingResponse(
            body(),
            status_code=206,
            media_type=mime,
            headers=headers,
        )
    else:
        headers["Content-Length"] = str(size)

        log.error("### OGMA DEBUG stream_by_msg ACTIVE code is running for chat=%s msg_id=%s", chat_username, msg_id)

        return StreamingResponse(
            body(),
            status_code=200,
            media_type=mime,
            headers=headers,
        )


@router.head("/stream/by-msg/{msg_id}")
async def head_stream_by_msg(
    msg_id: int,
    request: Request,
    chat: str = Query(..., description="username канала, можно с @"),
):
    chat_username = (chat or "").strip().lstrip("@").lower()
    if not chat_username:
        raise HTTPException(
            status_code=400,
            detail="Query 'chat' is required (username канала без @)",
        )

    # HEAD тоже лучше проверить доступ к каналу, чтобы фронт мог заранее понять 404
    try:
        await _ensure_join(chat_username)
    except Exception as e:
        raise HTTPException(
            status_code=404,
            detail=f"Cannot access chat '{chat_username}': {e.__class__.__name__}",
        )

    await _ensure_tg()

    try:
        doc = await _get_document(chat_username, msg_id)
    except HTTPException as e:
        raise e
    except _RPCError as e:
        raise HTTPException(
            status_code=404,
            detail=f"Telegram RPC access error: {e.__class__.__name__}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Telegram upstream error: {e.__class__.__name__}",
        )

    size = int(getattr(doc, "size", 0) or 0)
    if size <= 0:
        raise HTTPException(
            status_code=500,
            detail="Unknown file size",
        )

    mime = getattr(doc, "mime_type", None) or "application/octet-stream"

    headers = {
        "Accept-Ranges": "bytes",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-transform",
        "Content-Encoding": "identity",
        "Content-Length": str(size),
        "Content-Type": mime,
    }
    return Response(status_code=200, headers=headers, media_type=mime)