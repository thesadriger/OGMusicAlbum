#!/usr/bin/env python3
import os
import asyncio
import asyncpg
import httpx
from dotenv import load_dotenv
from typing import List, Dict, Any

BATCH = 1000  # сколько документов отправлять за один POST

load_dotenv("/home/ogma/ogma/stream/.env")  # берем PG_DSN, MEILI_HOST, MEILI_KEY

PG_DSN     = os.environ["PG_DSN"]
MEILI_HOST = os.environ["MEILI_HOST"].rstrip("/")
MEILI_KEY  = os.environ.get("MEILI_KEY", "")

HEADERS = {"Authorization": f"Bearer {MEILI_KEY}"} if MEILI_KEY else {}

SQL = """
SELECT
  id::text,
  title,
  artists,
  hashtags,
  duration_s,
  mime,
  size_bytes,
  created_at,
  chat_username,
  tg_msg_id,
  caption
FROM tracks
ORDER BY created_at NULLS LAST, id
"""

def to_doc(r: asyncpg.Record) -> Dict[str, Any]:
    return {
        "id": r["id"],
        "title": r["title"],
        "artists": r["artists"] or [],
        "hashtags": r["hashtags"] or [],
        "duration_s": r["duration_s"],
        "mime": r["mime"],
        "size_bytes": r["size_bytes"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "chat_username": r["chat_username"],
        "tg_msg_id": r["tg_msg_id"],
        "caption": r["caption"],
    }

async def push_batch(client: httpx.AsyncClient, batch: List[Dict[str, Any]]) -> None:
    if not batch:
        return
    # idempotent upsert; primaryKey объявим в первом вызове
    resp = await client.post(
        "/indexes/tracks/documents?primaryKey=id",
        headers=HEADERS,
        json=batch,
        timeout=60.0,
    )
    resp.raise_for_status()

async def main():
    pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=4)
    async with pool.acquire() as con, httpx.AsyncClient(base_url=MEILI_HOST) as client:
        docs: List[Dict[str, Any]] = []
        sent = 0
        async with con.transaction():
            # потоково читаем курсором без OFFSET
            async for row in con.cursor(SQL, prefetch=BATCH):
                docs.append(to_doc(row))
                if len(docs) >= BATCH:
                    await push_batch(client, docs)
                    sent += len(docs)
                    print(f"sent {sent} docs...")
                    docs.clear()
        if docs:
            await push_batch(client, docs)
            sent += len(docs)
            print(f"sent {sent} docs (final)")

    await pool.close()

if __name__ == "__main__":
    asyncio.run(main())