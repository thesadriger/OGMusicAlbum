#!/usr/bin/env python3
import base64
import os
import re
import time
from typing import List, Tuple, Optional

from dotenv import load_dotenv; load_dotenv()
from telethon.sync import TelegramClient
from telethon import errors
from telethon.utils import get_display_name
from telethon.tl.types import DocumentAttributeAudio
import psycopg2, psycopg2.extras, datetime as dt  # dt для отметки времени
import meilisearch

API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
PHONE = os.environ["TELEGRAM_PHONE"]
SESSION = os.getenv("TELETHON_SESSION", "ogma_indexer")
SOURCE = os.getenv("SOURCE_CHAT", "@OGMA_archive")

PG_DSN = os.environ["PG_DSN"]
MEILI_HOST = os.environ["MEILI_HOST"]
MEILI_KEY = os.environ["MEILI_KEY"]


def log(*a):
    print(time.strftime("[%Y-%m-%d %H:%M:%S]"), *a, flush=True)


HASHTAG_RE = re.compile(r"#([\w\d_]+)", re.U)
SPLIT_ARTISTS_RE = re.compile(r"\s*(?:,|feat\.?|ft\.?)\s*", re.I)


def caption_title_artist(text: str) -> Tuple[Optional[str], List[str]]:
    if not text:
        return (None, [])
    line1 = text.strip().splitlines()[0]
    if " - " in line1:
        title, artist = line1.split(" - ", 1)
        artists = [a for a in SPLIT_ARTISTS_RE.split(artist) if a]
        return (title.strip(), [a.strip() for a in artists])
    return (None, [])


def extract_hashtags(text: str) -> List[str]:
    if not text:
        return []
    tags = []
    for m in HASHTAG_RE.finditer(text):
        raw = m.group(1)
        if raw:
            tags.append("#" + raw)
    return list(dict.fromkeys(tags))  # уникально, порядок сохраняем


conn = psycopg2.connect(PG_DSN)
conn.autocommit = True


def heartbeat(last_msg_id: int | None, last_error: str | None = None):
    with conn.cursor() as cur:
        # ВАРИАНТ 1 (рекомендуется): использовать SQL-функцию из 006_indexer_status.sql
        # cur.execute("SELECT public.upsert_indexer_heartbeat(%s, %s, %s, %s)",
        #             (last_msg_id, last_error, os.getenv('SOURCE_CHAT'), os.getenv('TELETHON_SESSION', 'ogma_indexer')))
        # ВАРИАНТ 2: оставить прямой upsert, если функции ещё нет
        cur.execute(
            """
            INSERT INTO indexer_status (id, last_msg_id, last_ts, last_error, source_chat, session_name)
            VALUES (1, %s, now(), %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
              last_msg_id  = EXCLUDED.last_msg_id,
              last_ts      = EXCLUDED.last_ts,
              last_error   = EXCLUDED.last_error,
              source_chat  = COALESCE(EXCLUDED.source_chat, indexer_status.source_chat),
              session_name = COALESCE(EXCLUDED.session_name, indexer_status.session_name)
            """,
            (last_msg_id, last_error, os.getenv('SOURCE_CHAT'), os.getenv('TELETHON_SESSION', 'ogma_indexer')),
        )


def upsert_track(row: dict) -> str:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
        insert into tracks (chat_username, tg_msg_id, title, artists, hashtags, duration_s, mime, size_bytes,
                            caption, doc_id, access_hash, file_ref_b64, dc_id)
        values (%(chat_username)s, %(tg_msg_id)s, %(title)s, %(artists)s, %(hashtags)s, %(duration_s)s,
                %(mime)s, %(size_bytes)s, %(caption)s, %(doc_id)s, %(access_hash)s, %(file_ref_b64)s, %(dc_id)s)
        on conflict (chat_username, tg_msg_id) do update set
            title=excluded.title,
            artists=excluded.artists,
            hashtags=excluded.hashtags,
            duration_s=excluded.duration_s,
            mime=excluded.mime,
            size_bytes=excluded.size_bytes,
            caption=excluded.caption,
            doc_id=excluded.doc_id,
            access_hash=excluded.access_hash,
            file_ref_b64=excluded.file_ref_b64,
            dc_id=excluded.dc_id
        returning id;
        """,
            row,
        )
        return cur.fetchone()["id"]


def get_last_msg_id(chat_username: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "select coalesce(max(tg_msg_id),0) from tracks where chat_username=%s",
            (chat_username,),
        )
        (mid,) = cur.fetchone()
        return int(mid or 0)


mc = meilisearch.Client(MEILI_HOST, MEILI_KEY)
idx = mc.index("tracks")
try:
    idx.get_raw_info()
except Exception:
    mc.create_index("tracks", {"primaryKey": "id"})


def meili_doc(row: dict, rec_id: str) -> dict:
    return {
        "id": rec_id,
        "msgId": row["tg_msg_id"],
        "chat": row["chat_username"],
        "title": row["title"],
        "artists": row["artists"],
        "hashtags": row["hashtags"],
        "duration": row["duration_s"],
        "mime": row["mime"],
        "search_blob": " ".join(
            filter(
                None,
                [
                    row["title"] or "",
                    " ".join(row["artists"] or []),
                    " ".join(row["hashtags"] or []),
                    row["caption"] or "",
                ],
            )
        ),
    }


def main():
    log("Login to Telegram…")
    client = TelegramClient(SESSION, API_ID, API_HASH, flood_sleep_threshold=60).start(
        PHONE
    )
    chat_username = SOURCE.lstrip("@")
    entity = client.get_entity(SOURCE)
    log("Source:", get_display_name(entity), f"(@{chat_username})")

    last = get_last_msg_id(chat_username)
    log(f"Continue from msg_id>{last}" if last else "Start from the beginning")

    processed = 0
    last_msg_id_seen = last  # важно: инициализируем до цикла
    try:
        for msg in client.iter_messages(entity, reverse=True, min_id=last):
            if not msg or not msg.document:
                continue
            mime = getattr(msg.document, "mime_type", "") or ""
            is_audio = any(
                isinstance(a, DocumentAttributeAudio) for a in msg.document.attributes
            )
            if not is_audio and not mime.startswith("audio/"):
                continue

            audio_attr = next(
                (
                    a
                    for a in msg.document.attributes
                    if isinstance(a, DocumentAttributeAudio)
                ),
                None,
            )
            duration = int(getattr(audio_attr, "duration", 0) or 0)
            title = getattr(audio_attr, "title", None)
            performer = getattr(audio_attr, "performer", None)

            caption = (msg.message or "").strip()
            cap_title, cap_artists = caption_title_artist(caption)

            if not title and cap_title:
                title = cap_title

            artists: List[str] = []
            if performer:
                artists.append(performer)
            artists += cap_artists
            artists = [a.strip() for a in artists if a and a.strip()]

            hashtags = extract_hashtags(caption)

            row = {
                "chat_username": chat_username,
                "tg_msg_id": msg.id,
                "title": title,
                "artists": artists,
                "hashtags": hashtags,
                "duration_s": duration,
                "mime": mime,
                "size_bytes": getattr(msg.document, "size", None),
                "caption": caption,
                "doc_id": getattr(msg.document, "id", None),
                "access_hash": getattr(msg.document, "access_hash", None),
                "file_ref_b64": base64.b64encode(
                    getattr(msg.document, "file_reference", b"") or b""
                ).decode("ascii"),
                "dc_id": getattr(msg.document, "dc_id", None),
            }
            rec_id = upsert_track(row)
            # гарантируем primary key при первой загрузке индекса
            idx.add_documents([meili_doc(row, rec_id)], primary_key="id")
            processed += 1
            last_msg_id_seen = msg.id

            # heartbeat по мере прогресса (каждые 50 сообщений)
            if processed % 50 == 0:
                heartbeat(last_msg_id_seen, None)
                log(f"Processed {processed}, last msg_id={last_msg_id_seen}")

        # финальный heartbeat по завершении
        heartbeat(last_msg_id_seen, None)
        log(f"Done. Total processed: {processed}")

    except errors.FloodWaitError as e:
        sec = getattr(e, "seconds", 0)
        log(f"FloodWait: {sec}s. Stop.")
        # фиксируем ошибку в статус
        heartbeat(last_msg_id_seen, f"FloodWaitError: {sec}s")

    except Exception as e:
        # любая иная ошибка — фиксируем
        log(f"Indexer error: {e}")
        heartbeat(last_msg_id_seen, f"{type(e).__name__}: {e}")
        raise

    finally:
        client.disconnect()


if __name__ == "__main__":
    main()
