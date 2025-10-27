#!/usr/bin/env python3
from __future__ import annotations

import os
import html
import logging
from typing import Optional, Dict

import asyncpg
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.constants import ParseMode
from telegram.ext import (
    Application, CommandHandler, ContextTypes, AIORateLimiter, CallbackQueryHandler
)
import psycopg2, psycopg2.extras, time

# ------------------------
# Конфиг / окружение
# ------------------------
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
PG_DSN = os.environ.get("PG_DSN") or os.environ.get("DATABASE_URL") or \
         "postgresql://ogma:ogma_pass@127.0.0.1:5432/ogma"
conn = psycopg2.connect(PG_DSN); conn.autocommit = True

# Админы: можно добавить через переменную окружения ADMIN_IDS="566676200,123,..."
ADMIN_IDS = {566676200}
_env_admins = os.environ.get("ADMIN_IDS")
if _env_admins:
    for x in _env_admins.split(","):
        x = x.strip()
        if x.isdigit():
            ADMIN_IDS.add(int(x))

def is_admin(user_id: Optional[int]) -> bool:
    try:
        return int(user_id) in ADMIN_IDS
    except Exception:
        return False

# ID или username телеграм-группы (с включёнными темами) для пользовательских тем
FORUM_CHAT_ID = os.environ.get("FORUM_CHAT_ID")
if FORUM_CHAT_ID:
    try:
        FORUM_CHAT_ID = int(FORUM_CHAT_ID)
    except ValueError:
        # Можно задать username группы (строка)
        pass
else:
    raise RuntimeError("FORUM_CHAT_ID is not set (укажите ID группы с форумом)")

# Username телеграм-канала/группы, где хранятся аудиофайлы (OGMA_archive)
ARCHIVE_USERNAME = os.environ.get("ARCHIVE_USERNAME", "OGMA_archive")

# Пул подключений к БД сохраняем в application.bot_data[POOL_KEY]
POOL_KEY = "pg_pool"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger("ogma.bot")

# ------------------------
# Утилиты форматирования
# ------------------------
DEFAULT_PERIOD = "7d"
DEFAULT_LIMIT = 10

PERIOD_LABELS = {
    "24h": "24 ч",
    "7d":  "7 д",
    "30d": "30 д",
    "all": "всё",
}

def bot_heartbeat(last_error: str | None = None):
    with conn.cursor() as cur:
        cur.execute("""
            insert into bot_status (id, last_update_ts, last_error)
            values (1, now(), %s)
            on conflict (id) do update set
              last_update_ts = excluded.last_update_ts,
              last_error     = excluded.last_error
        """, (last_error,))
        

def esc(s: Optional[str]) -> str:
    return html.escape(s or "")

def parse_args(text: str) -> tuple[str, int]:
    """
    Разбор аргументов команд: /cmd [period] [limit]
    period: all | 24h | 7d | 30d (по умолчанию 7d)
    limit: целое 1..50 (по умолчанию 10)
    """
    parts = [p for p in (text or "").strip().split() if p]
    args = parts[1:]
    period = DEFAULT_PERIOD
    limit = DEFAULT_LIMIT

    if len(args) >= 1:
        p = args[0].lower()
        if p in {"all", "24h", "7d", "30d"}:
            period = p
        else:
            try:
                limit = max(1, min(50, int(p)))
            except Exception:
                pass

    if len(args) >= 2:
        try:
            limit = max(1, min(50, int(args[1])))
        except Exception:
            pass

    return period, limit

def parse_user_args(text: str) -> tuple[str, str, int]:
    """
    /user <@username|username|telegram_id> [period] [limit]
    """
    parts = [p for p in (text or "").strip().split() if p]
    args = parts[1:]
    if not args:
        raise ValueError("Укажите username или numeric id: /user @nick [period] [limit]")

    target = args[0]
    period = DEFAULT_PERIOD
    limit = DEFAULT_LIMIT

    if len(args) >= 2:
        p = args[1].lower()
        if p in {"all", "24h", "7d", "30d"}:
            period = p
        else:
            try:
                limit = max(1, min(50, int(p)))
            except Exception:
                pass

    if len(args) >= 3:
        try:
            limit = max(1, min(50, int(args[2])))
        except Exception:
            pass

    return target, period, limit

def parse_target_user(text: str) -> str:
    """
    Парсим аргумент команды для указания пользователя.
    /create_user_topic <@username|username|telegram_id>
    """
    parts = [p for p in (text or "").strip().split() if p]
    if len(parts) < 2:
        raise ValueError("Укажите username или ID пользователя.")
    return parts[1]

def where_period_sql(period: str) -> str:
    """Фрагмент WHERE для listening_seconds (колонка day) по периоду."""
    if period == "all":
        return ""
    if period == "24h":
        return "AND ls.day >= CURRENT_DATE - 1"
    if period == "30d":
        return "AND ls.day >= CURRENT_DATE - 30"
    # по умолчанию 7 дней
    return "AND ls.day >= CURRENT_DATE - 7"

def fmt_header(title: str, period: str, limit: int) -> str:
    period_label = {"all": "за всё время", "24h": "за 24 часа", 
                    "7d": "за 7 дней", "30d": "за 30 дней"}[period]
    return f"<b>{esc(title)}</b>\n<i>{period_label}, top {limit}</i>\n"

# ------------------------
# SQL-запросы (статистика прослушиваний)
# ------------------------
TOP_TRACKS_SQL = """
SELECT t.id::text AS track_id,
       t.title,
       array_to_string(t.artists, ', ') AS artists,
       SUM(ls.seconds)::int AS seconds_total
FROM listening_seconds ls
JOIN tracks t ON t.id = ls.track_id
WHERE 1=1
  {PERIOD}
GROUP BY t.id, t.title, t.artists
ORDER BY seconds_total DESC
LIMIT $1;
"""

TOP_ARTISTS_SQL = """
SELECT a.artist,
       SUM(ls.seconds)::int AS seconds_total
FROM listening_seconds ls
JOIN tracks t ON t.id = ls.track_id
CROSS JOIN LATERAL unnest(t.artists) AS a(artist)
WHERE 1=1
  {PERIOD}
GROUP BY a.artist
ORDER BY seconds_total DESC
LIMIT $1;
"""

TOP_LISTENERS_SQL = """
SELECT u.telegram_id AS user_id,
       COALESCE(u.username,'—') AS username,
       COALESCE(NULLIF(u.name,''),'') AS name,
       SUM(ls.seconds)::int AS seconds_total
FROM listening_seconds ls
JOIN users u ON u.telegram_id = ls.user_id
WHERE 1=1
  {PERIOD}
GROUP BY u.telegram_id, u.username, u.name
ORDER BY seconds_total DESC
LIMIT $1;
"""

ME_TRACKS_SQL = """
SELECT t.id::text AS track_id,
       t.title,
       array_to_string(t.artists, ', ') AS artists,
       SUM(ls.seconds)::int AS seconds_total
FROM listening_seconds ls
JOIN tracks t ON t.id = ls.track_id
WHERE ls.user_id = $1
  {PERIOD}
GROUP BY t.id, t.title, t.artists
ORDER BY seconds_total DESC
LIMIT $2;
"""

ME_ARTISTS_SQL = """
SELECT a.artist,
       SUM(ls.seconds)::int AS seconds_total
FROM listening_seconds ls
JOIN tracks t ON t.id = ls.track_id
CROSS JOIN LATERAL unnest(t.artists) AS a(artist)
WHERE ls.user_id = $1
  {PERIOD}
GROUP BY a.artist
ORDER BY seconds_total DESC
LIMIT $2;
"""

# ------------------------
# Inline-кнопки (для разделов статистики)
# ------------------------
ACTIONS_ALL = [
    ("top_tracks",  "Треки"),
    ("top_artists", "Артисты"),
    ("listeners",   "Слушатели"),  # только для админа
    ("me_tracks",   "Мои треки"),
    ("me_artists",  "Мои артисты"),
]

PERIODS = ["24h", "7d", "30d", "all"]
LIMITS  = [5, 10, 20, 30]

def build_cb(act: str, period: str, limit: int) -> str:
    return f"a={act};p={period};l={limit}"

def parse_cb(data: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for part in (data or "").split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k] = v
    return out

def make_kbd(act: str, period: str, limit: int, admin: bool) -> InlineKeyboardMarkup:
    # Доступные разделы зависят от роли
    actions = [("top_tracks","Треки"), ("top_artists","Артисты")]
    if admin:
        actions.append(("listeners","Слушатели"))
    actions += [("me_tracks","Мои треки"), ("me_artists","Мои артисты")]

    # Разобьём на 2 строки
    row1, row2 = [], []
    for i, (code, label) in enumerate(actions):
        selected = "•" if code == act else ""
        btn = InlineKeyboardButton(
            f"{selected}{label}",
            callback_data=build_cb(code, period, limit)
        )
        (row1 if i < 3 else row2).append(btn)

    row_period = [
        InlineKeyboardButton(
            f"{'•' if p == period else ''}{PERIOD_LABELS[p]}",
            callback_data=build_cb(act, p, limit)
        ) for p in PERIODS
    ]
    row_limit = [
        InlineKeyboardButton(
            f"{'•' if l == limit else ''}{l}",
            callback_data=build_cb(act, period, l)
        ) for l in LIMITS
    ]
    rows = [row1]
    if row2:
        rows.append(row2)
    rows.extend([row_period, row_limit])
    return InlineKeyboardMarkup(rows)

# ------------------------
# Рендеры статистических отчётов (как было раньше)
# ------------------------
async def render_top_tracks(pool: asyncpg.Pool, period: str, limit: int) -> str:
    where = where_period_sql(period)
    sql = TOP_TRACKS_SQL.format(PERIOD=where)
    rows = await pool.fetch(sql, limit)
    if not rows:
        return "Данных пока нет."
    out = [fmt_header("Топ треков", period, limit)]
    for i, r in enumerate(rows, 1):
        out.append(f"{i}. {esc(r['title'])} — {esc(r['artists'])}  <code>{r['seconds_total']}s</code>")
    return "\n".join(out)

async def render_top_artists(pool: asyncpg.Pool, period: str, limit: int) -> str:
    where = where_period_sql(period)
    sql = TOP_ARTISTS_SQL.format(PERIOD=where)
    rows = await pool.fetch(sql, limit)
    if not rows:
        return "Данных пока нет."
    out = [fmt_header("Топ артистов", period, limit)]
    for i, r in enumerate(rows, 1):
        out.append(f"{i}. {esc(r['artist'])}  <code>{r['seconds_total']}s</code>")
    return "\n".join(out)

async def render_listeners(pool: asyncpg.Pool, period: str, limit: int) -> str:
    where = where_period_sql(period)
    sql = TOP_LISTENERS_SQL.format(PERIOD=where)
    rows = await pool.fetch(sql, limit)
    if not rows:
        return "Данных пока нет."
    out = [fmt_header("Топ слушателей", period, limit)]
    for i, r in enumerate(rows, 1):
        uname = f"@{r['username']}" if r['username'] and r['username'] != '—' else '—'
        name = r['name'] or ''
        out.append(
            f"{i}. <code>{r['user_id']}</code> {esc(uname)} {esc(name)}  "
            f"<code>{r['seconds_total']}s</code>"
        )
    return "\n".join(out)

async def render_me_tracks(pool: asyncpg.Pool, user_id: int, period: str, limit: int) -> str:
    where = where_period_sql(period)
    sql = ME_TRACKS_SQL.format(PERIOD=where)
    rows = await pool.fetch(sql, user_id, limit)
    if not rows:
        return "Для вашего аккаунта ещё нет данных."
    out = [fmt_header("Ваши треки по секундам", period, limit)]
    for i, r in enumerate(rows, 1):
        out.append(f"{i}. {esc(r['title'])} — {esc(r['artists'])}  <code>{r['seconds_total']}s</code>")
    return "\n".join(out)

async def render_me_artists(pool: asyncpg.Pool, user_id: int, period: str, limit: int) -> str:
    where = where_period_sql(period)
    sql = ME_ARTISTS_SQL.format(PERIOD=where)
    rows = await pool.fetch(sql, user_id, limit)
    if not rows:
        return "Для вашего аккаунта ещё нет данных."
    out = [fmt_header("Ваши артисты по секундам", period, limit)]
    for i, r in enumerate(rows, 1):
        out.append(f"{i}. {esc(r['artist'])}  <code>{r['seconds_total']}s</code>")
    return "\n".join(out)

async def resolve_user_id(pool: asyncpg.Pool, token: str) -> Optional[int]:
    """token = '@nick' | 'nick' | numeric id"""
    t = token.strip()
    if t.startswith("@"):
        t = t[1:]
    if t.isdigit():
        return int(t)
    # Ищем в users по username (нижний регистр)
    row = await pool.fetchrow(
        "SELECT telegram_id FROM users WHERE lower(username)=lower($1) LIMIT 1",
        t
    )
    return int(row["telegram_id"]) if row else None

# ------------------------
# Логика форумных тем для пользователей
# ------------------------
async def get_user_profile_text(pool: asyncpg.Pool, user_row: asyncpg.Record) -> str:
    """Формируем текст для сообщения с информацией о пользователе."""
    uid = user_row["telegram_id"]
    username = user_row.get("username") or ""
    name = user_row.get("name") or ""
    lines = []
    lines.append("<b>Информация о пользователе</b>")
    lines.append(f"ID: <code>{uid}</code>")
    lines.append(f"Username: {esc('@'+username) if username else '—'}")
    lines.append(f"Name: {esc(name)}" if name else "Name: —")
    return "\n".join(lines)

async def get_user_playlists_text(pool: asyncpg.Pool, user_id: int) -> str:
    """Формируем текст для сообщения с плейлистами и треками пользователя."""
    playlists = await pool.fetch(
        "SELECT id, name, COALESCE(is_public, false) AS is_public FROM playlists "
        "WHERE user_id = $1 ORDER BY name",
        user_id
    )
    lines: list[str] = []
    lines.append("<b>Плейлисты и треки</b>")
    if not playlists:
        lines.append("Нет плейлистов.")
        return "\n".join(lines)
    for pl in playlists:
        pname = pl["name"]
        pub = pl["is_public"]
        lines.append(f"\n<b>{esc(pname)}</b> ({'публичный' if pub else 'приватный'})")
        tracks = await pool.fetch(
            "SELECT t.id AS track_id, t.title, array_to_string(t.artists, ', ') AS artists, t.message_id "
            "FROM playlist_tracks pt JOIN tracks t ON pt.track_id = t.id "
            "WHERE pt.playlist_id = $1 "
            "ORDER BY t.title",
            pl["id"]
        )
        if not tracks:
            lines.append(" - <i>пустой плейлист</i>")
        else:
            for tr in tracks:
                title = tr["title"]
                artists = tr["artists"] or ""
                track_id = tr["track_id"]
                msg_id = tr.get("message_id")
                if msg_id:
                    link = f"https://t.me/{ARCHIVE_USERNAME}/{msg_id}"
                    lines.append(f" - <a href=\"{link}\">{esc(title)} — {esc(artists)}</a> <code>{track_id}</code>")
                else:
                    lines.append(f" - {esc(title)} — {esc(artists)} <code>{track_id}</code>")
    return "\n".join(lines)

async def get_user_backgrounds_text(pool: asyncpg.Pool, user_row: asyncpg.Record) -> str:
    """Формируем текст для сообщения с фонами профиля и трека."""
    profile_bg_id = user_row.get("profile_bg_id")
    track_bg_id = user_row.get("track_bg_id")
    profile_bg_name = user_row.get("profile_bg_name")
    track_bg_name = user_row.get("track_bg_name")
    lines = []
    lines.append("<b>Фоны профиля и трека</b>")
    # Фон профиля
    if profile_bg_id:
        # показываем название, если есть, иначе просто ID
        bg_display = esc(profile_bg_name) if profile_bg_name else "ID"
        lines.append(f"Фон профиля: {bg_display} <code>{profile_bg_id}</code>")
    else:
        lines.append("Фон профиля: по умолчанию")
    # Фон активного трека
    if track_bg_id:
        bg_display = esc(track_bg_name) if track_bg_name else "ID"
        lines.append(f"Фон активного трека: {bg_display} <code>{track_bg_id}</code>")
    else:
        lines.append("Фон активного трека: по умолчанию")
    return "\n".join(lines)

# ------------------------
# Команды для управления темами пользователей
# ------------------------
async def cmd_create_user_topic(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Админ: создать новую тему-форум для пользователя и заполнить её сообщениями."""
    if not is_admin(update.effective_user.id):
        return
    try:
        target = parse_target_user(update.message.text)
    except ValueError as e:
        await update.effective_chat.send_message(str(e))
        return
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    uid = await resolve_user_id(pool, target)
    if not uid:
        await update.effective_chat.send_message("Пользователь не найден.")
        return
    # Получаем информацию о пользователе из БД
    user_row = await pool.fetchrow(
        "SELECT u.telegram_id, u.username, u.name, u.profile_bg_id, u.track_bg_id, "
        "(SELECT name FROM backgrounds WHERE id=u.profile_bg_id) AS profile_bg_name, "
        "(SELECT name FROM backgrounds WHERE id=u.track_bg_id) AS track_bg_name "
        "FROM users u WHERE u.telegram_id = $1",
        uid
    )
    if not user_row:
        await update.effective_chat.send_message("Пользователь не найден.")
        return
    # Проверяем, не создана ли уже тема для этого пользователя
    if await pool.fetchrow("SELECT 1 FROM user_topics WHERE user_id = $1", uid):
        await update.effective_chat.send_message("Тема для этого пользователя уже существует.")
        return
    # Определяем имя темы: используем @username или имя/ID
    username = user_row.get("username") or ""
    topic_name = f"@{username}" if username else (user_row.get("name") or f"User {uid}")
    try:
        topic = await ctx.bot.create_forum_topic(chat_id=FORUM_CHAT_ID, name=topic_name)
    except Exception as e:
        log.error(f"Failed to create topic for user {uid}: {e}")
        await update.effective_chat.send_message(
            "Не удалось создать тему. Убедитесь, что бот – админ группы с правом управления темами."
        )
        return
    topic_id = topic.message_thread_id
    # Формируем тексты сообщений
    profile_text = await get_user_profile_text(pool, user_row)
    playlists_text = await get_user_playlists_text(pool, uid)
    backgrounds_text = await get_user_backgrounds_text(pool, user_row)
    # Отправляем 3 сообщения в новую тему
    try:
        msg1 = await ctx.bot.send_message(FORUM_CHAT_ID, profile_text, 
                                         message_thread_id=topic_id, parse_mode=ParseMode.HTML)
        msg2 = await ctx.bot.send_message(FORUM_CHAT_ID, playlists_text, 
                                         message_thread_id=topic_id, parse_mode=ParseMode.HTML, disable_web_page_preview=True)
        msg3 = await ctx.bot.send_message(FORUM_CHAT_ID, backgrounds_text, 
                                         message_thread_id=topic_id, parse_mode=ParseMode.HTML, disable_web_page_preview=True)
    except Exception as e:
        log.error(f"Failed to send messages for user {uid} topic: {e}")
        await update.effective_chat.send_message("Ошибка: не удалось отправить сообщения в тему.")
        return
    # Сохраняем данные темы и сообщений в БД
    await pool.execute(
        "INSERT INTO user_topics(user_id, topic_id, profile_msg_id, playlists_msg_id, background_msg_id, topic_name) "
        "VALUES($1, $2, $3, $4, $5, $6)",
        uid, topic_id, msg1.message_id, msg2.message_id, msg3.message_id, topic_name
    )
    # Подтверждаем создание
    display_target = target
    if display_target.isdigit():  # если введён numeric id, попробуем показать username или имя
        if user_row.get("username"):
            display_target = "@" + user_row["username"]
        elif user_row.get("name"):
            display_target = user_row["name"]
    confirmation = f"<b>Тема пользователя создана</b>: {esc(display_target)} (id: <code>{uid}</code>)"
    await update.effective_chat.send_message(confirmation, parse_mode=ParseMode.HTML)

async def cmd_update_profile(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Админ: обновить сообщение с профилем пользователя в его теме."""
    if not is_admin(update.effective_user.id):
        return
    try:
        target = parse_target_user(update.message.text)
    except ValueError as e:
        await update.effective_chat.send_message(str(e))
        return
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    uid = await resolve_user_id(pool, target)
    if not uid:
        await update.effective_chat.send_message("Пользователь не найден.")
        return
    # Получаем данные пользователя и темы
    user_topic = await pool.fetchrow(
        "SELECT u.telegram_id, u.username, u.name, u.profile_bg_id, u.track_bg_id, "
        "ut.topic_id, ut.profile_msg_id, ut.topic_name "
        "FROM users u JOIN user_topics ut ON ut.user_id = u.telegram_id "
        "WHERE u.telegram_id = $1",
        uid
    )
    if not user_topic:
        await update.effective_chat.send_message("Тема пользователя не найдена. Сначала создайте тему.")
        return
    # Проверяем, изменился ли username для обновления названия темы
    old_topic_name = user_topic["topic_name"] or ""
    username = user_topic.get("username") or ""
    new_topic_name = f"@{username}" if username else (user_topic.get("name") or f"User {uid}")
    if new_topic_name and new_topic_name != old_topic_name:
        try:
            await ctx.bot.edit_forum_topic(chat_id=FORUM_CHAT_ID, message_thread_id=user_topic["topic_id"], name=new_topic_name)
            await pool.execute("UPDATE user_topics SET topic_name=$1 WHERE user_id=$2", new_topic_name, uid)
        except Exception as e:
            log.warning(f"Failed to edit topic name for user {uid}: {e}")
    # Обновляем текст профиля
    profile_text = await get_user_profile_text(pool, user_topic)
    try:
        await ctx.bot.edit_message_text(chat_id=FORUM_CHAT_ID, 
                                       message_id=user_topic["profile_msg_id"], message_thread_id=user_topic["topic_id"],
                                       text=profile_text, parse_mode=ParseMode.HTML)
    except Exception as e:
        log.error(f"Failed to edit profile message for user {uid}: {e}")
        await update.effective_chat.send_message("Ошибка при обновлении профиля.")
        return
    # Подтверждаем
    display_target = target
    if display_target.isdigit():
        if user_topic.get("username"):
            display_target = "@" + user_topic["username"]
        elif user_topic.get("name"):
            display_target = user_topic["name"]
    await update.effective_chat.send_message(
        f"Информация профиля пользователя {esc(display_target)} обновлена.", parse_mode=ParseMode.HTML
    )

async def cmd_update_playlists(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Админ: обновить сообщение с плейлистами и треками пользователя."""
    if not is_admin(update.effective_user.id):
        return
    try:
        target = parse_target_user(update.message.text)
    except ValueError as e:
        await update.effective_chat.send_message(str(e))
        return
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    uid = await resolve_user_id(pool, target)
    if not uid:
        await update.effective_chat.send_message("Пользователь не найден.")
        return
    topic_row = await pool.fetchrow("SELECT topic_id, playlists_msg_id FROM user_topics WHERE user_id = $1", uid)
    if not topic_row:
        await update.effective_chat.send_message("Тема пользователя не найдена. Сначала создайте тему.")
        return
    playlists_text = await get_user_playlists_text(pool, uid)
    try:
        await ctx.bot.edit_message_text(chat_id=FORUM_CHAT_ID, 
                                       message_id=topic_row["playlists_msg_id"], message_thread_id=topic_row["topic_id"],
                                       text=playlists_text, parse_mode=ParseMode.HTML, disable_web_page_preview=True)
    except Exception as e:
        log.error(f"Failed to edit playlists message for user {uid}: {e}")
        await update.effective_chat.send_message("Ошибка при обновлении плейлистов.")
        return
    # Подтверждаем
    display_target = target
    if display_target.isdigit():
        # Получим username/name для отображения
        user_rec = await pool.fetchrow("SELECT username, name FROM users WHERE telegram_id=$1", uid)
        if user_rec:
            if user_rec.get("username"):
                display_target = "@" + user_rec["username"]
            elif user_rec.get("name"):
                display_target = user_rec["name"]
    await update.effective_chat.send_message(
        f"Плейлисты пользователя {esc(display_target)} обновлены.", parse_mode=ParseMode.HTML
    )

async def cmd_update_backgrounds(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Админ: обновить сообщение с фонами пользователя."""
    if not is_admin(update.effective_user.id):
        return
    try:
        target = parse_target_user(update.message.text)
    except ValueError as e:
        await update.effective_chat.send_message(str(e))
        return
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    uid = await resolve_user_id(pool, target)
    if not uid:
        await update.effective_chat.send_message("Пользователь не найден.")
        return
    user_topic = await pool.fetchrow(
        "SELECT u.telegram_id, u.username, u.name, u.profile_bg_id, u.track_bg_id, "
        "(SELECT name FROM backgrounds WHERE id=u.profile_bg_id) AS profile_bg_name, "
        "(SELECT name FROM backgrounds WHERE id=u.track_bg_id) AS track_bg_name, "
        "ut.topic_id, ut.background_msg_id "
        "FROM users u JOIN user_topics ut ON ut.user_id = u.telegram_id "
        "WHERE u.telegram_id = $1",
        uid
    )
    if not user_topic:
        await update.effective_chat.send_message("Тема пользователя не найдена. Сначала создайте тему.")
        return
    backgrounds_text = await get_user_backgrounds_text(pool, user_topic)
    try:
        await ctx.bot.edit_message_text(chat_id=FORUM_CHAT_ID, 
                                       message_id=user_topic["background_msg_id"], message_thread_id=user_topic["topic_id"],
                                       text=backgrounds_text, parse_mode=ParseMode.HTML, disable_web_page_preview=True)
    except Exception as e:
        log.error(f"Failed to edit backgrounds message for user {uid}: {e}")
        await update.effective_chat.send_message("Ошибка при обновлении фонов.")
        return
    # Подтверждаем
    display_target = target
    if display_target.isdigit():
        if user_topic.get("username"):
            display_target = "@" + user_topic["username"]
        elif user_topic.get("name"):
            display_target = user_topic["name"]
    await update.effective_chat.send_message(
        f"Фоны пользователя {esc(display_target)} обновлены.", parse_mode=ParseMode.HTML
    )

async def cmd_refresh_user(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Админ: обновить сразу все данные пользователя в его теме (профиль, плейлисты, фон)."""
    if not is_admin(update.effective_user.id):
        return
    try:
        target = parse_target_user(update.message.text)
    except ValueError as e:
        await update.effective_chat.send_message(str(e))
        return
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    uid = await resolve_user_id(pool, target)
    if not uid:
        await update.effective_chat.send_message("Пользователь не найден.")
        return
    # Проверяем существование темы
    topic = await pool.fetchrow("SELECT * FROM user_topics WHERE user_id = $1", uid)
    if not topic:
        await update.effective_chat.send_message("Тема пользователя не найдена. Сначала создайте тему.")
        return
    # Получаем все данные пользователя и темы для обновления
    user_topic = await pool.fetchrow(
        "SELECT u.telegram_id, u.username, u.name, u.profile_bg_id, u.track_bg_id, "
        "(SELECT name FROM backgrounds WHERE id=u.profile_bg_id) AS profile_bg_name, "
        "(SELECT name FROM backgrounds WHERE id=u.track_bg_id) AS track_bg_name, "
        "ut.topic_id, ut.profile_msg_id, ut.playlists_msg_id, ut.background_msg_id, ut.topic_name "
        "FROM users u JOIN user_topics ut ON ut.user_id = u.telegram_id "
        "WHERE u.telegram_id = $1",
        uid
    )
    if not user_topic:
        await update.effective_chat.send_message("Пользователь не найден.")
        return
    # Обновляем название темы при необходимости
    old_topic_name = user_topic["topic_name"] or ""
    username = user_topic.get("username") or ""
    new_topic_name = f"@{username}" if username else (user_topic.get("name") or f"User {uid}")
    if new_topic_name and new_topic_name != old_topic_name:
        try:
            await ctx.bot.edit_forum_topic(chat_id=FORUM_CHAT_ID, message_thread_id=user_topic["topic_id"], name=new_topic_name)
            await pool.execute("UPDATE user_topics SET topic_name=$1 WHERE user_id=$2", new_topic_name, uid)
        except Exception as e:
            log.warning(f"Failed to edit topic name for user {uid}: {e}")
    # Обновляем все три сообщения
    profile_text = await get_user_profile_text(pool, user_topic)
    playlists_text = await get_user_playlists_text(pool, uid)
    backgrounds_text = await get_user_backgrounds_text(pool, user_topic)
    try:
        await ctx.bot.edit_message_text(chat_id=FORUM_CHAT_ID,
                                       message_id=user_topic["profile_msg_id"], message_thread_id=user_topic["topic_id"],
                                       text=profile_text, parse_mode=ParseMode.HTML)
        await ctx.bot.edit_message_text(chat_id=FORUM_CHAT_ID,
                                       message_id=user_topic["playlists_msg_id"], message_thread_id=user_topic["topic_id"],
                                       text=playlists_text, parse_mode=ParseMode.HTML, disable_web_page_preview=True)
        await ctx.bot.edit_message_text(chat_id=FORUM_CHAT_ID,
                                       message_id=user_topic["background_msg_id"], message_thread_id=user_topic["topic_id"],
                                       text=backgrounds_text, parse_mode=ParseMode.HTML, disable_web_page_preview=True)
    except Exception as e:
        log.error(f"Failed to refresh all messages for user {uid}: {e}")
        # Continue even if one edit fails, trying others
    # Подтверждение
    display_target = target
    if display_target.isdigit():
        if user_topic.get("username"):
            display_target = "@" + user_topic["username"]
        elif user_topic.get("name"):
            display_target = user_topic["name"]
    await update.effective_chat.send_message(
        f"Все данные пользователя {esc(display_target)} обновлены.", parse_mode=ParseMode.HTML
    )

# ------------------------
# Команды (статистика и пр. из старого бота)
# ------------------------
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    admin = is_admin(user.id)
    act = "top_tracks"
    period = DEFAULT_PERIOD
    limit = DEFAULT_LIMIT
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    text = await render_top_tracks(pool, period, limit)
    await update.effective_chat.send_message(
        text, parse_mode=ParseMode.HTML,
        reply_markup=make_kbd(act, period, limit, admin),
        disable_web_page_preview=True
    )

async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    admin = is_admin(update.effective_user.id)
    base = (
        "<b>OGMusicAlbum — статистика прослушиваний и данные профилей</b>\n\n"
        "Используйте кнопки ниже для просмотра статистики (разделы, период, лимит).\n\n"
        "Полезные команды:\n"
        "• /me_tracks [period] [limit]\n"
        "• /me_artists [period] [limit]\n"
    )
    if admin:
        base += (
            "\n<i>Команды для админа:</i>\n"
            "• /me — показать ваш Telegram ID\n"
            "• /listeners [period] [limit]\n"
            "• /user @username [period] [limit]\n"
            "• /create_user_topic @username — создать тему с данными пользователя\n"
            "• /update_profile @username — обновить информацию профиля\n"
            "• /update_playlists @username — обновить плейлисты и треки\n"
            "• /update_backgrounds @username — обновить фоны профиля/трека\n"
            "• /refresh_user @username — обновить все данные пользователя\n"
        )
    base += (
        "\n<i>period:</i> all | 24h | 7d | 30d (по умолчанию 7d)\n"
        "<i>limit:</i> 1..50 (по умолчанию 10)"
    )
    await update.effective_chat.send_message(base, parse_mode=ParseMode.HTML, disable_web_page_preview=True)

async def cmd_me(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        return
    u = update.effective_user
    text = (
        f"<b>Ваш Telegram ID:</b> <code>{u.id}</code>\n"
        f"<b>username:</b> {esc('@'+u.username) if u.username else '—'}\n"
        f"<b>name:</b> {esc(u.full_name)}"
    )
    await update.effective_chat.send_message(text, parse_mode=ParseMode.HTML)

async def cmd_top_tracks(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    period, limit = parse_args(update.message.text)
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    text = await render_top_tracks(pool, period, limit)
    admin = is_admin(update.effective_user.id)
    await update.effective_chat.send_message(
        text, parse_mode=ParseMode.HTML,
        reply_markup=make_kbd("top_tracks", period, limit, admin)
    )

async def cmd_top_artists(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    period, limit = parse_args(update.message.text)
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    text = await render_top_artists(pool, period, limit)
    admin = is_admin(update.effective_user.id)
    await update.effective_chat.send_message(
        text, parse_mode=ParseMode.HTML,
        reply_markup=make_kbd("top_artists", period, limit, admin)
    )

async def cmd_listeners(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        return
    period, limit = parse_args(update.message.text)
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    text = await render_listeners(pool, period, limit)
    # Здесь admin=True, так как команда только для админа
    await update.effective_chat.send_message(
        text, parse_mode=ParseMode.HTML,
        reply_markup=make_kbd("listeners", period, limit, admin=True)
    )

async def cmd_me_tracks(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    period, limit = parse_args(update.message.text)
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    text = await render_me_tracks(pool, user_id, period, limit)
    admin = is_admin(user_id)
    await update.effective_chat.send_message(
        text, parse_mode=ParseMode.HTML,
        reply_markup=make_kbd("me_tracks", period, limit, admin)
    )

async def cmd_me_artists(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    period, limit = parse_args(update.message.text)
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    text = await render_me_artists(pool, user_id, period, limit)
    admin = is_admin(user_id)
    await update.effective_chat.send_message(
        text, parse_mode=ParseMode.HTML,
        reply_markup=make_kbd("me_artists", period, limit, admin)
    )

async def cmd_user(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Админ: /user @nick [period] [limit] — статистика по пользователю."""
    if not is_admin(update.effective_user.id):
        return
    try:
        target, period, limit = parse_user_args(update.message.text)
    except ValueError as e:
        await update.effective_chat.send_message(str(e))
        return
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    uid = await resolve_user_id(pool, target)
    if not uid:
        await update.effective_chat.send_message("Пользователь не найден.")
        return
    tracks = await render_me_tracks(pool, uid, period, limit)
    artists = await render_me_artists(pool, uid, period, limit)
    header = f"<b>Статистика пользователя</b>: {esc(target)} (id: <code>{uid}</code>)\n"
    text = header + "\n" + tracks + "\n\n" + artists
    await update.effective_chat.send_message(text, parse_mode=ParseMode.HTML, disable_web_page_preview=True)

# ------------------------
# CallbackQuery (инлайн-кнопки статистики)
# ------------------------
async def on_cb(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    if not q:
        return
    await q.answer()
    admin = is_admin(q.from_user.id)
    data = parse_cb(q.data or "")
    act = data.get("a") or "top_tracks"
    period = data.get("p") or DEFAULT_PERIOD
    try:
        limit = int(data.get("l") or DEFAULT_LIMIT)
    except Exception:
        limit = DEFAULT_LIMIT
    limit = max(1, min(50, limit))
    pool: asyncpg.Pool = ctx.bot_data[POOL_KEY]
    # Если неадмин нажмет "Слушатели", переключим на "Треки"
    if act == "listeners" and not admin:
        act = "top_tracks"
    if act == "top_tracks":
        text = await render_top_tracks(pool, period, limit)
    elif act == "top_artists":
        text = await render_top_artists(pool, period, limit)
    elif act == "listeners":
        text = await render_listeners(pool, period, limit)
    elif act == "me_tracks":
        text = await render_me_tracks(pool, q.from_user.id, period, limit)
    elif act == "me_artists":
        text = await render_me_artists(pool, q.from_user.id, period, limit)
    else:
        text = "Неизвестное действие."
    try:
        await q.edit_message_text(text, parse_mode=ParseMode.HTML,
                                   reply_markup=make_kbd(act, period, limit, admin),
                                   disable_web_page_preview=True)
    except Exception:
        # Если редактирование текста не удалось (например, слишком длинное новое сообщение),
        # попробуем обновить только клавиатуру, игнорируя текст.
        try:
            await q.edit_message_reply_markup(reply_markup=make_kbd(act, period, limit, admin))
        except Exception:
            pass

# ------------------------
# Инициализация и запуск бота
# ------------------------
async def on_start(app: Application):
    app.bot_data[POOL_KEY] = await asyncpg.create_pool(dsn=PG_DSN, min_size=1, max_size=5)
    log.info("DB pool ready")

async def on_stop(app: Application):
    pool: asyncpg.Pool = app.bot_data.get(POOL_KEY)
    if pool:
        await pool.close()

def main():
    if not BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is not set")
    application = Application.builder() \
        .token(BOT_TOKEN) \
        .rate_limiter(AIORateLimiter(max_retries=2)) \
        .build()
    # Регистрируем обработчики команд
    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("help", cmd_help))
    application.add_handler(CommandHandler("me", cmd_me))                    # только админ
    application.add_handler(CommandHandler("top_tracks", cmd_top_tracks))
    application.add_handler(CommandHandler("top_artists", cmd_top_artists))
    application.add_handler(CommandHandler("listeners", cmd_listeners))      # только админ
    application.add_handler(CommandHandler("me_tracks", cmd_me_tracks))
    application.add_handler(CommandHandler("me_artists", cmd_me_artists))
    application.add_handler(CommandHandler(["user", "who"], cmd_user))       # только админ
    # Новые команды админа для тем пользователей
    application.add_handler(CommandHandler("create_user_topic", cmd_create_user_topic))   # только админ
    application.add_handler(CommandHandler("update_profile", cmd_update_profile))         # только админ
    application.add_handler(CommandHandler("update_playlists", cmd_update_playlists))     # только админ
    application.add_handler(CommandHandler("update_backgrounds", cmd_update_backgrounds))  # только админ
    application.add_handler(CommandHandler("refresh_user", cmd_refresh_user))             # только админ
    # Callback query (кнопки)
    application.add_handler(CallbackQueryHandler(on_cb))
    # Инициализация пула БД и запуск
    application.post_init = on_start
    application.post_stop = on_stop
    # Зафиксируем heartbeat после успешного старта приложения/пула:
    try:
        bot_heartbeat(None)
    except Exception as e:
        logging.getLogger("ogma.bot").warning(f"bot heartbeat failed on start: {e}")
    application.run_polling(close_loop=False)

if __name__ == "__main__":
    main()