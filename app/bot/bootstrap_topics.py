#!/usr/bin/env python3
from __future__ import annotations

import os
import html
import asyncio as aio
from typing import Any, Dict, List, Optional, Tuple

import asyncpg
from telegram import Bot
from telegram.constants import ParseMode
from telegram.error import RetryAfter, TimedOut, NetworkError, TelegramError

PG_DSN           = os.environ.get("PG_DSN") or "postgresql://ogma:ogma_pass@127.0.0.1:5432/ogma"
BOT_TOKEN        = os.environ["TELEGRAM_BOT_TOKEN"]
FORUM_CHAT_ID    = os.environ["FORUM_CHAT_ID"]        # ID/username служебной группы с включёнными темами
ARCHIVE_USERNAME = os.environ.get("ARCHIVE_USERNAME", "OGMA_archive")  # канал с аудио

# лимиты, чтобы не ловить флад
PAUSE = 0.35         # сек между вызовами API
CONCURRENCY = 3      # одновременных пользователей

def esc(s: Optional[str]) -> str:
    return html.escape(s or "")

# ---------- SQL ----------
SQL_ALL_USERS = """
SELECT u.telegram_id AS user_id,
       u.username,
       COALESCE(NULLIF(u.name,''), '') AS name
FROM users u
ORDER BY u.telegram_id;
"""

SQL_USER_TOPICS_GET = "SELECT * FROM user_topics WHERE user_id=$1;"
SQL_USER_TOPICS_UPSERT = """
INSERT INTO user_topics(user_id, topic_id, topic_name, profile_msg_id, playlists_msg_id, backgrounds_msg_id)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (user_id) DO UPDATE
   SET topic_id=$2, topic_name=$3, profile_msg_id=$4, playlists_msg_id=$5, backgrounds_msg_id=$6, updated_at=now();
"""

SQL_PROFILE = """
SELECT telegram_id AS user_id,
       username,
       COALESCE(NULLIF(name,''),'') AS name,
       profile_bg_id,
       track_bg_id
FROM users WHERE telegram_id=$1;
"""

SQL_PLAYLISTS = """
SELECT p.id::text  AS playlist_id,
       p.name      AS playlist_name,
       COALESCE(p.is_public, false) AS is_public
FROM playlists p
WHERE p.user_id=$1
ORDER BY p.name;
"""

SQL_PLAYLIST_TRACKS = """
SELECT pt.playlist_id::text,
       t.id::text           AS track_id,
       t.title,
       array_to_string(t.artists, ', ') AS artists,
       t.chat_username,
       t.tg_msg_id
FROM playlist_tracks pt
JOIN tracks t ON t.id = pt.track_id
WHERE pt.playlist_id = ANY($1::uuid[])
ORDER BY t.created_at NULLS LAST, t.title;
"""

SQL_BG_NAME = "SELECT name FROM backgrounds WHERE id=$1;"

# ---------- helpers ----------
def topic_name_for(username: Optional[str], user_id: int) -> str:
    if username:
        return f"{username}"
    return f"user_{user_id}"

def link_to_archive(chat_username: Optional[str], msg_id: Optional[int]) -> str:
    cu = (chat_username or ARCHIVE_USERNAME).lstrip("@")
    if not msg_id:
        return ""
    return f"https://t.me/{cu}/{msg_id}"

def render_profile_row(u: Dict[str, Any]) -> str:
    uname = f"@{u['username']}" if u.get("username") else "—"
    return (f"<b>Профиль</b>\n"
            f"ID: <code>{u['user_id']}</code>\n"
            f"Username: {esc(uname)}\n"
            f"Имя: {esc(u.get('name',''))}")

async def resolve_bg(pool: asyncpg.Pool, bg_id: Optional[int]) -> str:
    if not bg_id:
        return "по умолчанию"
    try:
        row = await pool.fetchrow(SQL_BG_NAME, bg_id)
        if row and row["name"]:
            return f"{row['name']} (id={bg_id})"
        return f"id={bg_id}"
    except Exception:
        return f"id={bg_id}"

async def render_backgrounds(pool: asyncpg.Pool, user_id: int) -> str:
    row = await pool.fetchrow(SQL_PROFILE, user_id)
    if not row:
        return "<b>Фоны</b>\nнет данных"
    profile_bg = await resolve_bg(pool, row["profile_bg_id"])
    track_bg   = await resolve_bg(pool, row["track_bg_id"])
    return (f"<b>Фоны</b>\n"
            f"• Профиль: {esc(profile_bg)}\n"
            f"• Активный трек: {esc(track_bg)}")

async def render_playlists(pool: asyncpg.Pool, user_id: int, per_playlist_limit: int = 60) -> Tuple[str, List[str]]:
    pls = await pool.fetch(SQL_PLAYLISTS, user_id)
    if not pls:
        return "<b>Плейлисты и треки</b>\nпока пусто", []
    ids = [p["playlist_id"] for p in pls]
    rows = await pool.fetch(SQL_PLAYLIST_TRACKS, ids)

    # сгруппировать по плейлисту
    tracks_by_pl: Dict[str, List[asyncpg.Record]] = {}
    for r in rows:
        tracks_by_pl.setdefault(r["playlist_id"], []).append(r)

    lines: List[str] = ["<b>Плейлисты и треки</b>"]
    for p in pls:
        name = p["playlist_name"] or "(без названия)"
        scope = "публичный" if p["is_public"] else "приватный"
        lines.append(f"\n<b>{esc(name)}</b> · {scope}")
        tlist = tracks_by_pl.get(p["playlist_id"], [])
        for i, t in enumerate(tlist[:per_playlist_limit], 1):
            link = link_to_archive(t["chat_username"], t["tg_msg_id"])
            tail = f" — <a href=\"{link}\">ссылка</a>" if link else ""
            lines.append(f"{i}. {esc(t['title'])} — {esc(t['artists'])}  <code>{t['track_id']}</code>{tail}")
        extra = max(0, len(tlist) - per_playlist_limit)
        if extra:
            lines.append(f"… и ещё {extra} трек(ов)")

    text = "\n".join(lines)
    # Telegram ограничение 4096 символов; при превышении — честно обрежем
    if len(text) > 4000:
        text = text[:3900] + "\n… обрезано из-за лимита Telegram"
    return text, ids

# ---------- TG I/O с бережной обработкой флад-лимитов ----------
async def _tg_call(coro):
    while True:
        try:
            return await coro
        except RetryAfter as e:
            await aio.sleep(float(getattr(e, "retry_after", 3)))
        except (TimedOut, NetworkError):
            await aio.sleep(1.0)

async def ensure_topic_and_scaffold(bot: Bot, pool: asyncpg.Pool, user: Dict[str, Any]) -> None:
    user_id   = int(user["user_id"])
    username  = user.get("username")
    tname     = topic_name_for(username, user_id)

    row = await pool.fetchrow(SQL_USER_TOPICS_GET, user_id)
    if row:
        topic_id = int(row["topic_id"])
        profile_msg_id    = int(row["profile_msg_id"])
        playlists_msg_id  = int(row["playlists_msg_id"])
        backgrounds_msg_id = int(row["backgrounds_msg_id"])
        # попытка обновить название темы (если изменился username)
        try:
            await _tg_call(bot.edit_forum_topic(chat_id=FORUM_CHAT_ID, message_thread_id=topic_id, name=tname))
            await aio.sleep(PAUSE)
        except TelegramError:
            pass
    else:
        # создать тему
        topic = await _tg_call(bot.create_forum_topic(chat_id=FORUM_CHAT_ID, name=tname))
        topic_id = topic.message_thread_id
        await aio.sleep(PAUSE)
        # создать три сообщения-заглушки
        m1 = await _tg_call(bot.send_message(FORUM_CHAT_ID, "…", message_thread_id=topic_id))
        await aio.sleep(PAUSE)
        m2 = await _tg_call(bot.send_message(FORUM_CHAT_ID, "…", message_thread_id=topic_id))
        await aio.sleep(PAUSE)
        m3 = await _tg_call(bot.send_message(FORUM_CHAT_ID, "…", message_thread_id=topic_id))
        await aio.sleep(PAUSE)
        profile_msg_id, playlists_msg_id, backgrounds_msg_id = m1.message_id, m2.message_id, m3.message_id

        await pool.execute(SQL_USER_TOPICS_UPSERT, user_id, topic_id, tname,
                           profile_msg_id, playlists_msg_id, backgrounds_msg_id)

    # рендерим и обновляем тексты
    profile_row = await pool.fetchrow(SQL_PROFILE, user_id)
    profile_txt = render_profile_row(dict(profile_row) if profile_row else user)
    await _tg_call(bot.edit_message_text(profile_txt, FORUM_CHAT_ID, profile_msg_id,
                                         parse_mode=ParseMode.HTML, disable_web_page_preview=True))
    await aio.sleep(PAUSE)

    playlists_txt, _ = await render_playlists(pool, user_id)
    await _tg_call(bot.edit_message_text(playlists_txt, FORUM_CHAT_ID, playlists_msg_id,
                                         parse_mode=ParseMode.HTML, disable_web_page_preview=True))
    await aio.sleep(PAUSE)

    bgs_txt = await render_backgrounds(pool, user_id)
    await _tg_call(bot.edit_message_text(bgs_txt, FORUM_CHAT_ID, backgrounds_msg_id,
                                         parse_mode=ParseMode.HTML, disable_web_page_preview=True))
    await pool.execute("UPDATE user_topics SET updated_at=now(), topic_name=$2 WHERE user_id=$1", user_id, tname)

async def run(mode: str = "missing", limit: Optional[int] = None, offset: int = 0):
    bot  = Bot(BOT_TOKEN)
    pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=10)

    try:
        users = await pool.fetch(SQL_ALL_USERS)
        if offset: users = users[offset:]
        if limit:  users = users[:limit]
        sem = aio.Semaphore(CONCURRENCY)

        async def worker(u):
            async with sem:
                # пропускать существующих, если mode="missing"
                if mode == "missing":
                    r = await pool.fetchrow(SQL_USER_TOPICS_GET, int(u["user_id"]))
                    if r:
                        return
                await ensure_topic_and_scaffold(bot, pool, dict(u))

        await aio.gather(*(worker(u) for u in users))
    finally:
        await pool.close()

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Bootstrap user topics into forum")
    ap.add_argument("--mode", choices=["missing", "all"], default="missing", help="missing=создавать только отсутствующие темы; all=создавать/обновлять всех")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--offset", type=int, default=0)
    args = ap.parse_args()
    aio.run(run(args.mode, args.limit, args.offset))