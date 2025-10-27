#!/usr/bin/env python3
import os, re, asyncio, logging, datetime as dt
from typing import List, Dict

import asyncpg, httpx
from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.errors import FloodWaitError
from telethon.tl.types import DocumentAttributeAudio

load_dotenv("/home/ogma/ogma/stream/.env")  # один .env на всё

PG_DSN = os.environ["PG_DSN"]
API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
PHONE = os.environ.get("TELEGRAM_PHONE")  # для первого логина
SESSION_PATH = os.path.expanduser(os.environ.get(
    "TELEGRAM_SESSION_INDEXER",
    "/home/ogma/ogma/indexer/ogma_indexer.session"
))

CHAT_USERNAMES = [s.strip().lstrip("@")
                  for s in os.environ.get("CHAT_USERNAMES", "OGMA_archive").split(",")
                  if s.strip()]

MEILI_HOST = os.environ["MEILI_HOST"].rstrip("/")
MEILI_KEY  = os.environ.get("MEILI_KEY", "")

BATCH = 200

log = logging.getLogger("ogma.indexer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

HASHTAG_RE = re.compile(r"(#\w+)", re.U)


async def ensure_meili_index(client: httpx.AsyncClient) -> None:
    """
    Гарантируем наличие индекса tracks с primaryKey=id.
    """
    r = await client.get("/indexes/tracks")
    if r.status_code == 404:
        r2 = await client.post("/indexes", json={"uid": "tracks", "primaryKey": "id"})
        r2.raise_for_status()


def parse_hashtags(text: str | None) -> List[str]:
    if not text:
        return []
    tags = [m.group(1) for m in HASHTAG_RE.finditer(text)]
    # удалим дубли, сохраняя порядок
    seen, out = set(), []
    for t in tags:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def split_artists(raw: str | None) -> List[str]:
    if not raw:
        return []
    s = re.sub(r"\s+(feat\.?|featuring|ft\.?)\s+", ",", raw, flags=re.I)
    parts = re.split(r"\s*[,&/]\s*|\s{2,}", s)
    return [p for p in (x.strip() for x in parts) if p]


async def upsert_track(con: asyncpg.Connection, chat: str, msg, meili_docs: List[Dict]):
    if not msg.document:
        return False

    doc = msg.document
    mime = getattr(doc, "mime_type", "") or ""
    # берём только аудио
    is_audio = mime.startswith("audio/") or any(
        isinstance(a, DocumentAttributeAudio) for a in (doc.attributes or [])
    )
    if not is_audio:
        return False

    duration = None
    performer = None
    title = None
    for a in (doc.attributes or []):
        if isinstance(a, DocumentAttributeAudio):
            duration = getattr(a, "duration", None)
            performer = getattr(a, "performer", None)
            title = getattr(a, "title", None)

    caption = msg.message or ""
    hashtags = parse_hashtags(caption)
    artists = split_artists(performer)

    size = getattr(doc, "size", None)
    dc_id = getattr(doc, "dc_id", None)

    created_at = (msg.date or dt.datetime.utcnow()).astimezone(dt.timezone.utc)

    sql = """
    INSERT INTO tracks (
        chat_username, tg_msg_id,
        title, artists, hashtags,
        duration_s, mime, size_bytes,
        caption, created_at,
        tg_document_id, tg_access_hash, tg_file_ref, tg_dc_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (chat_username, tg_msg_id) DO UPDATE SET
        title = EXCLUDED.title,
        artists = EXCLUDED.artists,
        hashtags = EXCLUDED.hashtags,
        duration_s = EXCLUDED.duration_s,
        mime = EXCLUDED.mime,
        size_bytes = EXCLUDED.size_bytes,
        caption = EXCLUDED.caption,
        tg_document_id = EXCLUDED.tg_document_id,
        tg_access_hash = EXCLUDED.tg_access_hash,
        tg_file_ref    = EXCLUDED.tg_file_ref,
        tg_dc_id       = EXCLUDED.tg_dc_id
    RETURNING id::text;
    """

    row = await con.fetchrow(
        sql,
        chat, msg.id,
        title, artists, hashtags,
        duration, mime, size,
        caption, created_at,
        int(doc.id), int(doc.access_hash), bytes(doc.file_reference or b""), int(dc_id or 0)
    )
    track_id = row["id"]

    meili_docs.append({
        "id": track_id,
        "title": title,
        "artists": artists,
        "hashtags": hashtags,
        "duration_s": duration,
        "mime": mime,
        "size_bytes": size,
        "caption": caption,
        "created_at": created_at.isoformat().replace("+00:00", "Z"),
        "chat_username": chat,
        "tg_msg_id": msg.id,
    })
    return True


async def index_chat(pool: asyncpg.Pool, tg: TelegramClient, meili: httpx.AsyncClient, chat: str):
    async with pool.acquire() as con:
        since_id = await con.fetchval(
            "SELECT COALESCE(MAX(tg_msg_id), 0) FROM tracks WHERE chat_username=$1",
            chat
        ) or 0

    log.info("chat=%s since_id=%s → scanning…", chat, since_id)
    total = 0
    batch_docs: List[Dict] = []

    async for msg in tg.iter_messages(chat, reverse=True, min_id=since_id):
        try:
            async with pool.acquire() as con:
                added = await upsert_track(con, chat, msg, batch_docs)
        except FloodWaitError as e:
            log.warning("FloodWait %ss", e.seconds)
            await asyncio.sleep(e.seconds + 1)
            continue

        if added:
            total += 1
            if len(batch_docs) >= BATCH:
                r = await meili.post("/indexes/tracks/documents", json=batch_docs)
                if r.status_code == 401:
                    raise RuntimeError(
                        "Meili 401 Unauthorized — проверь MEILI_KEY в /home/ogma/ogma/stream/.env "
                        "и MEILI_MASTER_KEY у контейнера infra-meili-1."
                    )
                r.raise_for_status()
                batch_docs.clear()

    if batch_docs:
        r = await meili.post("/indexes/tracks/documents", json=batch_docs)
        if r.status_code == 401:
            raise RuntimeError(
                "Meili 401 Unauthorized — проверь MEILI_KEY в /home/ogma/ogma/stream/.env "
                "и MEILI_MASTER_KEY у контейнера infra-meili-1."
            )
        r.raise_for_status()
        batch_docs.clear()

    log.info("chat=%s new/updated: %d", chat, total)
    return total


async def main():
    # PG
    pool = await asyncpg.create_pool(
    dsn=PG_DSN,
    min_size=5,
    max_size=30,                     # если CPU/IO тянут
    statement_cache_size=1000,
    max_inactive_connection_lifetime=300,
    timeout=10,
    server_settings={
        "application_name": "ogma-api",
        "jit": "off"                # tri-gram + LIKE быстрее без JIT на коротких запросах
    },
)

    # Meili (Bearer)
    if not MEILI_KEY:
        log.warning("MEILI_KEY не задан — запросы к Meili вернут 401.")
    meili = httpx.AsyncClient(
        base_url=MEILI_HOST,
        headers={"Authorization": f"Bearer {MEILI_KEY}"} if MEILI_KEY else {},
        timeout=15.0,
    )
    await ensure_meili_index(meili)

    # Telegram
    tg = TelegramClient(SESSION_PATH, API_ID, API_HASH)
    await tg.connect()
    if not await tg.is_user_authorized():
        if not PHONE:
            raise RuntimeError("Telethon session not authorized and TELEGRAM_PHONE is not set")
        print("First-time login: sending code to", PHONE)
        await tg.send_code_request(PHONE)
        code = input("Enter code: ").strip()
        await tg.sign_in(PHONE, code)

    total = 0
    try:
        for chat in CHAT_USERNAMES:
            total += await index_chat(pool, tg, meili, chat)
    finally:
        await tg.disconnect()
        await meili.aclose()
        await pool.close()

    log.info("done. total changed: %d", total)


if __name__ == "__main__":
    asyncio.run(main())