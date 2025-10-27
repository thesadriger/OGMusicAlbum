#/home/ogma/ogma/app/bot/forum_watcher.py
#!/usr/bin/env python3
from __future__ import annotations
import os, re, asyncio, asyncpg
from typing import Optional, Tuple

from telegram import Update
from telegram.constants import ChatType
from telegram.ext import (
    Application, AIORateLimiter, CommandHandler, MessageHandler, filters, ContextTypes
)
from telegram.error import Forbidden, BadRequest

PG_DSN        = os.environ.get("PG_DSN", "postgresql://ogma:ogma_pass@127.0.0.1:5432/ogma")
BOT_TOKEN     = os.environ["TELEGRAM_BOT_TOKEN"]
FORUM_CHAT_ID = int(os.environ["FORUM_CHAT_ID"])
ADMIN_IDS     = {int(x) for x in (os.environ.get("ADMIN_IDS","").split(",") if os.environ.get("ADMIN_IDS") else [])}

# SQL helpers
SQL_FIND_USER_BY_THREAD = """
SELECT user_id FROM forum_topics WHERE forum_chat_id=$1 AND thread_id=$2 LIMIT 1;
"""
SQL_SET_TOPIC_TITLE = """
UPDATE forum_topics SET title=$1, updated_at=now() WHERE forum_chat_id=$2 AND thread_id=$3;
"""
SQL_DELETE_USER = "DELETE FROM users WHERE telegram_id=$1;"

SQL_FIND_PLAYLIST = """
SELECT id FROM playlists
WHERE (id::text = $1) OR (handle IS NOT NULL AND lower(handle)=lower($1))
AND user_id=$2
LIMIT 1;
"""
SQL_UPDATE_HANDLE = "UPDATE playlists SET handle=$1, updated_at=now() WHERE id=$2;"
SQL_UPDATE_TITLE  = "UPDATE playlists SET title=$1, updated_at=now() WHERE id=$2;"

SQL_TRACK_BY_MSG = "SELECT id FROM tracks WHERE chat_username=$1 AND tg_msg_id=$2 LIMIT 1;"

SQL_ADD_ITEM = """
INSERT INTO playlist_items (playlist_id, track_id, position)
VALUES ($1,$2, COALESCE((SELECT max(position)+1 FROM playlist_items WHERE playlist_id=$1), 1))
ON CONFLICT (playlist_id, track_id) DO NOTHING;
"""
SQL_RM_ITEM_BY_POS = "DELETE FROM playlist_items WHERE playlist_id=$1 AND position=$2;"
SQL_RM_ITEM_BY_TRACK = "DELETE FROM playlist_items WHERE playlist_id=$1 AND track_id=$2;"

def is_admin(uid: Optional[int]) -> bool:
    return bool(uid and (uid in ADMIN_IDS))

async def get_user_id_by_thread(con: asyncpg.Connection, thread_id: int) -> Optional[int]:
    row = await con.fetchrow(SQL_FIND_USER_BY_THREAD, FORUM_CHAT_ID, thread_id)
    return int(row["user_id"]) if row else None

async def cmd_in_thread_guard(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> Tuple[Optional[int], Optional[asyncpg.Connection]]:
    if (not update.effective_chat) or (update.effective_chat.id != FORUM_CHAT_ID): return None, None
    mtid = getattr(update.effective_message, "message_thread_id", None)
    if mtid is None: return None, None
    con = await ctx.bot_data["pool"].acquire()
    uid = await get_user_id_by_thread(con, mtid)
    if not uid:
        await ctx.bot_data["pool"].release(con)
        return None, None
    return uid, con

# ——— Админ-команды ———

async def cmd_pl_handle(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id): return
    uid, con = await cmd_in_thread_guard(update, ctx); 
    if not uid: return
    try:
        if len(ctx.args) < 2:
            await update.effective_message.reply_text("usage: /pl_handle <handle|playlist_id> <new_handle>"); return
        key, new_handle = ctx.args[0], ctx.args[1]
        row = await con.fetchrow(SQL_FIND_PLAYLIST, key, uid)
        if not row:
            await update.effective_message.reply_text("плейлист не найден"); return
        await con.execute(SQL_UPDATE_HANDLE, new_handle, row["id"])
        await update.effective_message.reply_text(f"handle обновлён: /{new_handle}")
    finally:
        await ctx.bot_data["pool"].release(con)

async def cmd_pl_rename(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id): return
    uid, con = await cmd_in_thread_guard(update, ctx); 
    if not uid: return
    try:
        if len(ctx.args) < 2:
            await update.effective_message.reply_text("usage: /pl_rename <handle|playlist_id> <new title...>"); return
        key, new_title = ctx.args[0], " ".join(ctx.args[1:])
        row = await con.fetchrow(SQL_FIND_PLAYLIST, key, uid)
        if not row:
            await update.effective_message.reply_text("плейлист не найден"); return
        await con.execute(SQL_UPDATE_TITLE, new_title, row["id"])
        await update.effective_message.reply_text(f"название обновлено: {new_title}")
    finally:
        await ctx.bot_data["pool"].release(con)

def parse_archive_link(s: str) -> Optional[Tuple[str,int]]:
    # ожидаем OGMA_archive/12345 или t.me/OGMA_archive/12345
    m = re.search(r'(?:t\.me/)?([A-Za-z0-9_]+)/(\d+)$', s.strip())
    if not m: return None
    return m.group(1), int(m.group(2))

async def cmd_pl_add(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id): return
    uid, con = await cmd_in_thread_guard(update, ctx); 
    if not uid: return
    try:
        if len(ctx.args) < 2:
            await update.effective_message.reply_text("usage: /pl_add <handle|playlist_id> <OGMA_archive>/<msg_id>"); return
        key, link = ctx.args[0], ctx.args[1]
        row = await con.fetchrow(SQL_FIND_PLAYLIST, key, uid)
        if not row: 
            await update.effective_message.reply_text("плейлист не найден"); return
        parsed = parse_archive_link(link)
        if not parsed:
            await update.effective_message.reply_text("ожидал ссылку формата OGMA_archive/12345"); return
        chat_u, msg_id = parsed
        tr = await con.fetchrow(SQL_TRACK_BY_MSG, chat_u, msg_id)
        if not tr:
            await update.effective_message.reply_text("трек не найден в базе"); return
        await con.execute(SQL_ADD_ITEM, row["id"], tr["id"])
        await update.effective_message.reply_text("трек добавлен")
    finally:
        await ctx.bot_data["pool"].release(con)

async def cmd_pl_rm(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id): return
    uid, con = await cmd_in_thread_guard(update, ctx); 
    if not uid: return
    try:
        if len(ctx.args) < 2:
            await update.effective_message.reply_text("usage: /pl_rm <handle|playlist_id> <position|OGMA_archive>/<msg_id>"); return
        key, what = ctx.args[0], ctx.args[1]
        row = await con.fetchrow(SQL_FIND_PLAYLIST, key, uid)
        if not row: 
            await update.effective_message.reply_text("плейлист не найден"); return
        # позиция?
        if what.isdigit():
            await con.execute(SQL_RM_ITEM_BY_POS, row["id"], int(what))
            await update.effective_message.reply_text("удалено по позиции"); return
        parsed = parse_archive_link(what)
        if not parsed:
            await update.effective_message.reply_text("ожидал позицию или OGMA_archive/12345"); return
        chat_u, msg_id = parsed
        tr = await con.fetchrow(SQL_TRACK_BY_MSG, chat_u, msg_id)
        if not tr:
            await update.effective_message.reply_text("трек не найден в базе"); return
        await con.execute(SQL_RM_ITEM_BY_TRACK, row["id"], tr["id"])
        await update.effective_message.reply_text("удалено по треку")
    finally:
        await ctx.bot_data["pool"].release(con)

async def cmd_set_bg(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    # Заглушка для настройки фонов из панели (структуру хранения определим позже)
    if not is_admin(update.effective_user.id): return
    uid, con = await cmd_in_thread_guard(update, ctx); 
    if not uid: return
    try:
        await update.effective_message.reply_text("OK (заглушка): фон будет сохранён в user_ui_prefs")
    finally:
        await ctx.bot_data["pool"].release(con)

# ——— Сервисные события форума ———

async def on_service_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    # интересуют только сообщения в форуме
    msg = update.effective_message
    if not msg or update.effective_chat.id != FORUM_CHAT_ID: return
    mtid = getattr(msg, "message_thread_id", None)
    if mtid is None: return

    con = await ctx.bot_data["pool"].acquire()
    try:
        # Переименование
        if msg.forum_topic_edited:
            new_name = msg.forum_topic_edited.name
            await con.execute(SQL_SET_TOPIC_TITLE, new_name, FORUM_CHAT_ID, mtid)
            return
        # Удалили тему → удаляем пользователя
        if msg.forum_topic_deleted:
            uid = await get_user_id_by_thread(con, mtid)
            if uid:
                await con.execute(SQL_DELETE_USER, uid)
    finally:
        await ctx.bot_data["pool"].release(con)

# ——— init / run ———

async def on_start(app: Application):
    app.bot_data["pool"] = await asyncpg.create_pool(dsn=PG_DSN, min_size=1, max_size=5)

async def on_stop(app: Application):
    pool = app.bot_data.get("pool")
    if pool: await pool.close()

def main():
    app = Application.builder().token(BOT_TOKEN).rate_limiter(AIORateLimiter()).build()

    # сервисные апдейты форума в нашей группе
    app.add_handler(MessageHandler(
        filters.Chat(FORUM_CHAT_ID) & filters.StatusUpdate.ALL,  # ловим все сервисные
    on_service_message
    ))

    # команды (работают только в теме пользователя)
    app.add_handler(CommandHandler("pl_handle", cmd_pl_handle))
    app.add_handler(CommandHandler("pl_rename", cmd_pl_rename))
    app.add_handler(CommandHandler("pl_add",    cmd_pl_add))
    app.add_handler(CommandHandler("pl_rm",     cmd_pl_rm))
    app.add_handler(CommandHandler("set_bg",    cmd_set_bg))

    app.post_init = on_start
    app.post_stop = on_stop
    app.run_polling(close_loop=False)

if __name__ == "__main__":
    main()