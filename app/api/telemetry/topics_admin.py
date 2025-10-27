from __future__ import annotations
import asyncio
import os
import re
import unicodedata
from typing import Dict, List, Tuple

import httpx
from fastapi import APIRouter, Request, HTTPException

from app.api.stream_gateway import _ensure_tg, _TG

router = APIRouter()

CHAT_ID_RAW = os.environ.get("TELEGRAM_LOG_CHAT_ID", "") or "0"
try:
    CHAT_ID = int(CHAT_ID_RAW)
except Exception:
    CHAT_ID = 0

BOT_TOKEN = os.environ.get("TELEGRAM_LOG_BOT_TOKEN") or os.environ.get("TELEMETRY_BOT_TOKEN")

CANONICAL = {
    "visits","search","stream","download","errors","db","tg-gateway","infra","alerts","cache"
}

def _norm_title(s: str) -> str:
    # Унификация: NFKC + lower + вырезаем “шум”, коллапс пробелов
    t = unicodedata.normalize("NFKC", s).strip().lower()
    t = re.sub(r"\s+", " ", t)
    # Берём «базу» до разделителей — чтобы “infra — live/services” маппилось в “infra”
    base = re.split(r"[–—\-:/|]+", t)[0].strip()
    return base if base in CANONICAL else t

async def _list_all_topics(chat_id: int) -> List[Tuple[int, str]]:
    """Возвращает [(topic_id, title), ...]"""
    if chat_id == 0:
        raise RuntimeError("CHAT_ID not set")
    await _ensure_tg()
    assert _TG is not None

    # Telethon: channels.GetForumTopics пагинация по offset_topic
    from telethon.tl.functions.channels import GetForumTopics
    topics: List[Tuple[int,str]] = []
    offset_topic = 0
    entity = await _TG.get_entity(chat_id)
    while True:
        resp = await _TG(GetForumTopics(
            channel=entity,
            offset_date=None,
            offset_id=0,
            offset_topic=offset_topic,
            limit=100,
            q=None
        ))
        batch = resp.topics or []
        for it in batch:
            # у объекта тема: .id и .title
            topics.append((int(it.id), getattr(it, "title", "") or ""))
        if len(batch) < 100:
            break
        offset_topic = int(batch[-1].id)
    return topics

def _find_duplicates(topics: List[Tuple[int,str]]) -> Dict[str, List[Tuple[int,str]]]:
    buckets: Dict[str, List[Tuple[int,str]]] = {}
    for tid, title in topics:
        key = _norm_title(title)
        buckets.setdefault(key, []).append((tid, title))
    # Оставляем все ключи, где >1 или где ключ канонический, но названия у экземпляров разные (“infra”, “infra — live”, …)
    return {k:v for k,v in buckets.items() if len(v) > 1 and (k in CANONICAL or True)}

async def _delete_topic(topic_id: int) -> bool:
    if not (BOT_TOKEN and CHAT_ID):
        return False
    async with httpx.AsyncClient(timeout=15.0) as http:
        r = await http.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/deleteForumTopic",
            data={"chat_id": CHAT_ID, "message_thread_id": topic_id}
        )
        try:
            j = r.json()
        except Exception:
            j = {}
        return bool(j.get("ok"))

def _choose_keeper(items: List[Tuple[int,str]]) -> Tuple[int,str]:
    # Сохраняем «старую» (минимальный id) — как правило, первая созданная.
    return sorted(items, key=lambda x: x[0])[0]

def _only_local(req: Request):
    host = (req.client.host if req.client else "")
    if host not in {"127.0.0.1", "::1"}:
        raise HTTPException(403, "local only")

@router.get("/topics/report")
async def topics_report(request: Request):
    _only_local(request)
    topics = await _list_all_topics(CHAT_ID)
    dups = _find_duplicates(topics)
    keepers = {k:_choose_keeper(v)[0] for k,v in dups.items()}
    return {
        "total": len(topics),
        "duplicates": {k: [{"id":tid,"title":title} for tid,title in v] for k,v in dups.items()},
        "keepers": keepers,
    }

@router.post("/topics/cleanup")
async def topics_cleanup(request: Request, apply: bool = False):
    _only_local(request)
    if not (BOT_TOKEN and CHAT_ID):
        raise HTTPException(400, "BOT_TOKEN/CHAT_ID missing")
    topics = await _list_all_topics(CHAT_ID)
    dups = _find_duplicates(topics)
    plan = {}
    for k, items in dups.items():
        keep = _choose_keeper(items)[0]
        to_delete = [tid for tid,_ in items if tid != keep]
        plan[k] = {"keep": keep, "delete": to_delete}
    if not apply:
        return {"ok": True, "dry_run": True, "plan": plan}
    deleted = []
    for k, p in plan.items():
        for tid in p["delete"]:
            ok = await _delete_topic(tid)
            deleted.append({"topic_id": tid, "ok": ok})
            await asyncio.sleep(0.3)  # чуть притормаживаем, чтобы не ловить rate limit
    return {"ok": True, "deleted": deleted}
