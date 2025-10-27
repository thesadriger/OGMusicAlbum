# /home/ogma/ogma/app/api/me_send.py
from __future__ import annotations

import os
import tempfile
import asyncio as _asyncio
from dataclasses import dataclass
from typing import Optional

import asyncpg
from fastapi import APIRouter, HTTPException, Request, BackgroundTasks
from pydantic import BaseModel, Field

from telethon import TelegramClient, types
from telethon.errors import RPCError
from telethon.tl.types import Document

from app.api.stream_gateway import (  # реюзим готовые хелперы
    _get_document,
    _db_get_track,
    _filename_from,
    _ensure_tg,
    _maybe_user_id,
)

router = APIRouter()

# --- отдельный бот-клиент ---
_BOT: Optional[TelegramClient] = None

async def _ensure_bot():
    """Ленивый запуск Telethon-бота в отдельной сессии."""
    global _BOT
    if _BOT is not None:
        return
    api_id = int(os.environ["TELEGRAM_API_ID"])
    api_hash = os.environ["TELEGRAM_API_HASH"]
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not bot_token:
        raise HTTPException(500, "TELEGRAM_BOT_TOKEN is not set")

    # можно хранить сессию на диске, чтобы избежать лимитов логина
    sess_path = os.environ.get("TELEGRAM_BOT_SESSION", "/home/ogma/ogma/stream/ogma_bot.session")
    _BOT = TelegramClient(sess_path, api_id, api_hash)
    await _BOT.start(bot_token=bot_token)


# ----- модель запроса -----
class SendReq(BaseModel):
    # либо chat+msg_id (желательно), либо track_id (fallback)
    chat: Optional[str] = Field(default=None, description="username канала без @")
    msg_id: Optional[int] = None
    track_id: Optional[str] = None


@dataclass
class TrackMeta:
    chat_username: str
    msg_id: int
    title: Optional[str]
    artists: list[str]
    mime: Optional[str]
    size_bytes: Optional[int]


async def _resolve_track_meta(pool: asyncpg.Pool, body: SendReq) -> TrackMeta:
    if body.chat and body.msg_id:
        chat_username = body.chat.lstrip("@")
        # подтянем документ, а заодно выясним mime/size
        doc: Document = await _get_document(chat_username, int(body.msg_id))
        return TrackMeta(
            chat_username=chat_username,
            msg_id=int(body.msg_id),
            title=None,
            artists=[],
            mime=getattr(doc, "mime_type", None),
            size_bytes=getattr(doc, "size", None),
        )

    if body.track_id:
        t = await _db_get_track(pool, body.track_id)
        return TrackMeta(
            chat_username=t["chat_username"],
            msg_id=int(t["tg_msg_id"]),
            title=t.get("title"),
            artists=t.get("artists") or [],
            mime=t.get("mime"),
            size_bytes=t.get("size_bytes"),
        )

    raise HTTPException(400, "Provide chat+msg_id or track_id")


async def _try_forward(user_id: int, meta: TrackMeta) -> bool:
    """Пробуем переслать исходное сообщение ботом (если бот видит канал)."""
    await _ensure_bot()
    assert _BOT is not None
    try:
        await _BOT.forward_messages(
            entity=user_id,
            messages=meta.msg_id,
            from_peer=meta.chat_username,
        )
        return True
    except RPCError:
        return False
    except Exception:
        return False


async def _download_via_user(doc: Document, dst_path: str):
    """Качаем оригинал через пользовательскую сессию (user session)."""
    await _ensure_tg()  # из stream_gateway
    from app.api.stream_gateway import _TG  # type: ignore
    assert _TG is not None
    # iter_download в файл
    async with await _TG.download_media(doc, file=dst_path) as _:
        pass


async def _bot_send_file(user_id: int, file_path: str, meta: TrackMeta):
    """Загрузка файла ботом в личку пользователю с красивыми атрибутами аудио."""
    await _ensure_bot()
    assert _BOT is not None

    attrs = []
    title = meta.title or None
    performer = (", ".join(meta.artists)) if meta.artists else None

    # если это аудиофайл — добавим метаданные
    if (meta.mime or "").startswith("audio/"):
        attrs = [types.DocumentAttributeAudio(
            duration=0,  # если понадобится — можно проставить из БД
            title=title,
            performer=performer,
        )]

    caption = None
    if title or performer:
        caption = f"{performer + ' — ' if performer else ''}{title or ''}".strip(" —")

    await _BOT.send_file(
        entity=user_id,
        file=file_path,
        caption=caption or "",
        attributes=attrs,
        force_document=False,  # пусть телеграм распознает как музыку
    )


async def _send_track_to_user(pool: asyncpg.Pool, user_id: int, meta: TrackMeta):
    """Главная фонова задача: forward или reupload."""
    # 1) пробуем переслать
    ok = await _try_forward(user_id, meta)
    if ok:
        return

    # 2) если переслать нельзя — качаем юзер-сессией и грузим ботом
    doc = await _get_document(meta.chat_username, meta.msg_id)
    # проверка лимита 2ГБ
    size = int(getattr(doc, "size", 0) or meta.size_bytes or 0)
    if size > 2 * 1024 * 1024 * 1024:
        raise HTTPException(413, "File is larger than Telegram limit (2GB)")

    # временный файл с читабельным именем
    fname = _filename_from(meta.title, meta.artists, meta.mime)
    tmp_dir = os.environ.get("OGMA_TMP", "/tmp/ogma_slices")
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_path = os.path.join(tmp_dir, f"{fname}")

    try:
        await _download_via_user(doc, tmp_path)
        await _bot_send_file(user_id, tmp_path, meta)
    finally:
        # по желанию можно хранить сутки — пока удаляем сразу
        try:
            os.remove(tmp_path)
        except Exception:
            pass


@router.post("/me/send")
async def me_send(req: Request, body: SendReq, background: BackgroundTasks):
    user_id = _maybe_user_id(req)
    if not user_id:
        raise HTTPException(401, "Unauthorized (no Telegram init data)")

    pool: asyncpg.Pool = req.app.state.pool
    if not pool:
        raise HTTPException(503, "DB pool not ready")

    meta = await _resolve_track_meta(pool, body)

    # запускаем в фоне, чтобы не держать HTTP
    background.add_task(_send_track_to_user, pool, int(user_id), meta)

    return {"ok": True}