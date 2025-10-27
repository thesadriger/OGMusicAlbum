# /home/ogma/ogma/app/bot/export_forum_topics.py
#!/usr/bin/env python3
from __future__ import annotations

import os
import html
import asyncio
from typing import Optional, List, Tuple

import asyncpg
from telegram import Bot
from telegram.constants import ParseMode
from telegram.error import TelegramError, TimedOut, RetryAfter, BadRequest
from telegram.request import HTTPXRequest


# ───────────────── config ─────────────────
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
PG_DSN = os.environ.get("PG_DSN", "postgresql://ogma:ogma_pass@127.0.0.1:5432/ogma")
FORUM_CHAT_ID = int(os.environ["FORUM_CHAT_ID"])  # обязателен
PUBLIC_BASE = (os.environ.get("PUBLIC_BASE") or "https://ogmusicalbum.online").rstrip(
    "/"
)
SQL_DELETE_USER = "DELETE FROM users WHERE telegram_id=$1;"

TG_MAX = 4000  # запас к 4096


def esc(s: Optional[str]) -> str:
    return html.escape(s or "")


def make_stream_url(
    chat_username: Optional[str], msg_id: Optional[int]
) -> Optional[str]:
    if not chat_username or not msg_id:
        return None
    return f"{PUBLIC_BASE}/api/stream/by-msg/{msg_id}?chat={chat_username}"


def make_tg_link(chat_username: Optional[str], msg_id: Optional[int]) -> Optional[str]:
    if not chat_username or not msg_id:
        return None
    return f"https://t.me/{chat_username}/{msg_id}"


# ───────────────── SQL ─────────────────
SQL_USERS = """
SELECT telegram_id, username, name, created_at, is_premium
FROM users
ORDER BY telegram_id;
"""

SQL_COUNTS = """
SELECT
  (SELECT COUNT(*) FROM playlists p WHERE p.user_id = $1) AS playlists,
  (SELECT COUNT(*) FROM favorites f WHERE f.user_id = $1) AS favorites,
  (SELECT COALESCE(SUM(seconds),0) FROM listening_seconds ls WHERE ls.user_id = $1) AS listen_seconds
;
"""

SQL_LAST_PLAY = """
SELECT
  t.title,
  array_to_string(t.artists, ', ') AS artists,
  t.chat_username,
  t.tg_msg_id,
  h.ts AS played_at
FROM history h
JOIN tracks t ON t.id = h.track_id
WHERE h.user_id = $1 AND h.action='play'
ORDER BY h.ts DESC
LIMIT 1;
"""

SQL_PLAYLISTS = """
SELECT id, title, is_public, handle
FROM playlists
WHERE user_id = $1
ORDER BY created_at;
"""

SQL_PLAYLIST_ITEMS = """
SELECT
  pi.position,
  t.title,
  array_to_string(t.artists, ', ') AS artists,
  t.chat_username,
  t.tg_msg_id
FROM playlist_items pi
JOIN tracks t ON t.id = pi.track_id
WHERE pi.playlist_id = $1
ORDER BY pi.position;
"""

SQL_TOP_TRACKS_7D = """
SELECT t.title,
       array_to_string(t.artists, ', ') AS artists,
       SUM(ls.seconds)::int AS sec
FROM listening_seconds ls
JOIN tracks t ON t.id = ls.track_id
WHERE ls.user_id = $1
  AND ls.day >= CURRENT_DATE - 7
GROUP BY t.title, t.artists
ORDER BY sec DESC
LIMIT 15;
"""

SQL_TOP_ARTISTS_7D = """
SELECT a.artist,
       SUM(ls.seconds)::int AS sec
FROM listening_seconds ls
JOIN tracks t ON t.id = ls.track_id
CROSS JOIN LATERAL unnest(t.artists) AS a(artist)
WHERE ls.user_id = $1
  AND ls.day >= CURRENT_DATE - 7
GROUP BY a.artist
ORDER BY sec DESC
LIMIT 15;
"""

SQL_UI_PREFS_MAYBE = "SELECT * FROM user_ui_prefs WHERE user_id=$1"

SQL_GET_TOPIC = (
    "SELECT forum_chat_id, thread_id, title FROM forum_topics WHERE user_id=$1;"
)
SQL_INS_TOPIC = """
INSERT INTO forum_topics (user_id, forum_chat_id, thread_id, title)
VALUES ($1,$2,$3,$4)
ON CONFLICT (user_id) DO UPDATE
  SET forum_chat_id=EXCLUDED.forum_chat_id,
      thread_id=EXCLUDED.thread_id,
      title=EXCLUDED.title,
      updated_at=now();
"""

SQL_GET_POST = (
    "SELECT message_id FROM forum_topic_posts WHERE user_id=$1 AND post_type=$2;"
)
SQL_UPSERT_POST = """
INSERT INTO forum_topic_posts (user_id, post_type, message_id)
VALUES ($1,$2,$3)
ON CONFLICT (user_id, post_type) DO UPDATE SET message_id=EXCLUDED.message_id;
"""


# ─────────────── render helpers ───────────────
async def build_profile_text(
    con: asyncpg.Connection, uid: int, username: Optional[str], name: Optional[str]
) -> str:
    counts = await con.fetchrow(SQL_COUNTS, uid)
    last = await con.fetchrow(SQL_LAST_PLAY, uid)

    lines = []
    title = f"Профиль пользователя {('@'+username) if username else '(без username)'}"
    lines.append(f"<b>{esc(title)}</b>")
    lines.append(f"ID: <code>{uid}</code>")
    if name:
        lines.append(f"Имя: {esc(name)}")
    lines.append("")
    lines.append(f"Плейлистов: <b>{counts['playlists']}</b>")
    lines.append(f"Избранное (в \"Мой плейлист\"): <b>{counts['favorites']}</b>")
    lines.append(f"Секунд прослушивания (всего): <b>{counts['listen_seconds']}</b>")

    if last:
        su = make_stream_url(last["chat_username"], last["tg_msg_id"])
        tu = make_tg_link(last["chat_username"], last["tg_msg_id"])
        tail = []
        if su:
            tail.append(f'<a href="{esc(su)}">▶️ stream</a>')
        if tu:
            tail.append(f'<a href="{esc(tu)}">TG</a>')
        tail_txt = ("  " + " | ".join(tail)) if tail else ""
        lines.append("")
        lines.append("<i>Последнее воспроизведение:</i>")
        lines.append(f"• {esc(last['title'])} — {esc(last['artists'])}{tail_txt}")

    return "\n".join(lines)[:TG_MAX]


async def build_playlists_text(con: asyncpg.Connection, uid: int) -> List[str]:
    pls = await con.fetch(SQL_PLAYLISTS, uid)
    if not pls:
        return ["<b>Плейлисты</b>\nУ пользователя пока нет плейлистов."]

    header = ["<b>Плейлисты</b>"]
    chunks: List[str] = []
    cur = "\n".join(header) + "\n"

    for p in pls:
        line_pl = f"\n<b>{esc(p['title'])}</b>  {'(публичный)' if p['is_public'] else '(приватный)'}"
        handle = p.get("handle")
        if handle:
            line_pl += f"  <code>/{esc(handle)}</code>"

        if len(cur) + len(line_pl) > TG_MAX:
            chunks.append(cur)
            cur = ""

        cur += line_pl + "\n"

        items = await con.fetch(SQL_PLAYLIST_ITEMS, p["id"])
        if not items:
            cur += "  — нет треков\n"
            continue

        for it in items:
            su = make_stream_url(it["chat_username"], it["tg_msg_id"])
            tu = make_tg_link(it["chat_username"], it["tg_msg_id"])
            tail = []
            if su:
                tail.append(f'<a href="{esc(su)}">▶️</a>')
            if tu:
                tail.append(f'<a href="{esc(tu)}">TG</a>')
            tail_txt = (" " + " ".join(tail)) if tail else ""
            line_tr = f"  {it['position']:>2}. {esc(it['title'])} — {esc(it['artists'])}{tail_txt}\n"

            if len(cur) + len(line_tr) > TG_MAX:
                chunks.append(cur)
                cur = ""
            cur += line_tr

    if cur.strip():
        chunks.append(cur)
    return chunks or ["<b>Плейлисты</b>\n—"]


async def build_backgrounds_text(con: asyncpg.Connection, uid: int) -> str:
    try:
        prefs = await con.fetch(SQL_UI_PREFS_MAYBE, uid)
    except Exception:
        prefs = []

    lines = ["<b>Фоны/обложки</b>"]
    if not prefs:
        lines.append("Пока нет сохранённых настроек фона в БД.")
        return "\n".join(lines)

    shown = 0
    for r in prefs:
        pairs = "  ".join(
            f"{esc(str(k))}: <code>{esc(str(v))}</code>" for k, v in dict(r).items()
        )
        lines.append(f"• {pairs}")
        shown += 1
        if len("\n".join(lines)) > TG_MAX:
            break
    if shown == 0:
        lines.append("Пока нет сохранённых настроек фона в БД.")
    return "\n".join(lines)[:TG_MAX]


async def build_stats_text(con: asyncpg.Connection, uid: int) -> str:
    top_tr = await con.fetch(SQL_TOP_TRACKS_7D, uid)
    top_ar = await con.fetch(SQL_TOP_ARTISTS_7D, uid)
    lines = ["<b>Статистика за 7 дней</b>"]

    lines.append("\n<i>Треки по секундам</i>")
    if not top_tr:
        lines.append("— данных пока нет")
    else:
        for i, r in enumerate(top_tr, 1):
            lines.append(
                f"{i:>2}. {esc(r['title'])} — {esc(r['artists'])}  <code>{r['sec']}s</code>"
            )
            if len("\n".join(lines)) > TG_MAX:
                break

    lines.append("\n<i>Артисты по секундам</i>")
    if not top_ar:
        lines.append("— данных пока нет")
    else:
        for i, r in enumerate(top_ar, 1):
            lines.append(f"{i:>2}. {esc(r['artist'])}  <code>{r['sec']}s</code>")
            if len("\n".join(lines)) > TG_MAX:
                break
    return "\n".join(lines)[:TG_MAX]


# ─────────────── forum topics/posts ───────────────
async def ensure_user_topic(
    bot: Bot,
    con: asyncpg.Connection,
    uid: int,
    username: Optional[str],
    name: Optional[str],
) -> Tuple[int, str]:
    """Возвращает (thread_id, актуальный_заголовок). Если темы нет — создаёт."""
    # желаемый заголовок с эмодзи
    base = (
        f"👤 @{username}"
        if username
        else (f"👤 {(name or '').strip()[:24]} — id{uid}" if name else f"👤 id{uid}")
    )
    desired_title = base[:128]

    row = await con.fetchrow(SQL_GET_TOPIC, uid)
    if row:
        thread_id = int(row["thread_id"])
        current_title = row["title"] or ""
        # если отличается — переименуем тему
        if current_title != desired_title:
            try:
                await bot.edit_forum_topic(
                    FORUM_CHAT_ID, message_thread_id=thread_id, name=desired_title
                )
                await con.execute(
                    SQL_INS_TOPIC, uid, FORUM_CHAT_ID, thread_id, desired_title
                )
            except TelegramError:
                pass  # не критично — просто продолжим со старым заголовком
        return thread_id, desired_title

    # создаём новую тему
    for attempt in range(3):
        try:
            ft = await bot.create_forum_topic(FORUM_CHAT_ID, name=desired_title)
            thread_id = int(ft.message_thread_id)
            await con.execute(
                SQL_INS_TOPIC, uid, FORUM_CHAT_ID, thread_id, desired_title
            )
            return thread_id, desired_title
        except RetryAfter as e:
            await asyncio.sleep(int(getattr(e, "retry_after", 3)) + 1)
        except TimedOut:
            await asyncio.sleep(3 * (attempt + 1))
        except TelegramError as e:
            raise RuntimeError(f"Не удалось создать тему для пользователя {uid}: {e}")
    raise RuntimeError(f"Не удалось создать тему для пользователя {uid}: таймаут")


async def upsert_post(
    bot: Bot,
    con: asyncpg.Connection,
    uid: int,
    thread_id: int,
    post_type: str,
    text: str,
):
    assert post_type in {"profile", "playlists", "backgrounds", "stats"}
    row = await con.fetchrow(SQL_GET_POST, uid, post_type)

    if row:
        msg_id = int(row["message_id"])
        for attempt in range(2):
            try:
                await bot.edit_message_text(
                    chat_id=FORUM_CHAT_ID,
                    message_id=msg_id,
                    text=text,
                    parse_mode=ParseMode.HTML,
                    disable_web_page_preview=True,
                )
                return
            except BadRequest as e:
                # сообщение могли удалить -> попробуем отправить заново
                break
            except TelegramError:
                await asyncio.sleep(1 + attempt)

    # отправляем заново
    for attempt in range(3):
        try:
            sent = await bot.send_message(
                chat_id=FORUM_CHAT_ID,
                message_thread_id=thread_id,
                text=text,
                parse_mode=ParseMode.HTML,
                disable_web_page_preview=True,
            )
            await con.execute(SQL_UPSERT_POST, uid, post_type, int(sent.message_id))
            return
        except RetryAfter as e:
            await asyncio.sleep(int(getattr(e, "retry_after", 3)) + 1)
        except BadRequest as e:
            # если темы больше нет — выполняем требование: удаляем пользователя целиком
            if "message thread not found" in str(e).lower():
                await con.execute(SQL_DELETE_USER, uid)
                print(f"[del] удалён пользователь {uid}: тема {thread_id} отсутствует")
                return
            raise
        except TimedOut:
            await asyncio.sleep(2)


# ─────────────── main export ───────────────
async def _init_bot() -> Bot:
    if not BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN не задан")
    # длинные таймауты для systemd-окружения (иногда IPv6/маршрутизация)
    req = HTTPXRequest(
        connect_timeout=20.0,
        read_timeout=60.0,
        write_timeout=20.0,
        pool_timeout=20.0,
        http_version="1.1",
    )
    bot = Bot(BOT_TOKEN, request=req)
    # ручная инициализация с ретраями
    for attempt in range(3):
        try:
            await bot.initialize()
            return bot
        except TimedOut:
            await asyncio.sleep(3 * (attempt + 1))
    # последний шанс — всё равно вернём бот, многие методы работают и без get_me
    return bot


async def export_all(dry_run: bool = False, only_user: Optional[int] = None):
    pool = await asyncpg.create_pool(dsn=PG_DSN, min_size=1, max_size=5)
    async with pool.acquire() as con:
        users = await con.fetch(SQL_USERS)
    if only_user:
        users = [u for u in users if int(u["telegram_id"]) == only_user]

    print(f"[i] пользователей к экспорту: {len(users)}")
    if dry_run:
        for u in users:
            print(f"  - would export user {u['telegram_id']} @{u['username'] or ''}")
        await pool.close()
        return

    bot = await _init_bot()
    try:
        for u in users:
            uid = int(u["telegram_id"])
            uname = u["username"]
            name = u["name"]

            async with pool.acquire() as con:
                try:
                    thread_id, title = await ensure_user_topic(
                        bot, con, uid, uname, name
                    )
                    print(
                        f"[ok] тема готова для {uid} ({title}), thread_id={thread_id}"
                    )
                except RuntimeError as e:
                    print(f"[skip] {uid} @{uname or ''}: {e}")
                    await asyncio.sleep(2)
                    continue

                profile_txt = await build_profile_text(con, uid, uname, name)
                await upsert_post(bot, con, uid, thread_id, "profile", profile_txt)

                playlists_chunks = await build_playlists_text(con, uid)
                await upsert_post(
                    bot, con, uid, thread_id, "playlists", playlists_chunks[0]
                )
                for extra in playlists_chunks[1:]:
                    # дополнительные куски без учёта в forum_topic_posts
                    for attempt in range(3):
                        try:
                            await bot.send_message(
                                chat_id=FORUM_CHAT_ID,
                                message_thread_id=thread_id,
                                text=extra,
                                parse_mode=ParseMode.HTML,
                                disable_web_page_preview=True,
                            )
                            break
                        except RetryAfter as e:
                            await asyncio.sleep(int(getattr(e, "retry_after", 3)) + 1)
                        except TimedOut:
                            await asyncio.sleep(2)

                bgs_txt = await build_backgrounds_text(con, uid)
                await upsert_post(bot, con, uid, thread_id, "backgrounds", bgs_txt)

                stats_txt = await build_stats_text(con, uid)
                await upsert_post(bot, con, uid, thread_id, "stats", stats_txt)

                await asyncio.sleep(0.5)  # лёгкий троттлинг
    finally:
        try:
            await bot.shutdown()
        except Exception:
            pass
        await pool.close()
    print("[✓] экспорт завершён")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(
        description="Экспорт/обновление форум-тем и сообщений по пользователям"
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="ничего не отправлять в Telegram, только показать план",
    )
    ap.add_argument(
        "--user", type=int, help="экспорт только для конкретного user_id (telegram_id)"
    )
    args = ap.parse_args()

    asyncio.run(export_all(dry_run=args.dry_run, only_user=args.user))
