from __future__ import annotations
import asyncio, os, json, unicodedata
from typing import Dict, List, Tuple, Optional
from contextlib import suppress
import httpx
import argparse

# ---------------- helpers ----------------
def _to_int(x, default=0):
    try:
        return int(str(x).strip())
    except Exception:
        return default

def _norm(s: str) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s).strip().lower()
    s = s.replace("—", "-").replace("–", "-")
    while "  " in s:
        s = s.replace("  ", " ")
    return s

def _load_envfile(path: str) -> None:
    """Лояльно подмешиваем переменные из файла (если читается)."""
    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().split(" #", 1)[0].strip()
                if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                    v = v[1:-1]
                os.environ.setdefault(k, v)
    except Exception:
        pass

# ---------------- config/state ----------------
STATE_PATH = os.environ.get("TELEGRAM_TOPICS_STATE", "/var/lib/ogma/telegram_topics.json")
ENVFILE = "/etc/ogma/ogma-api.env"

CANONICAL = {
    "visits","search","stream","download","errors","db","tg-gateway","infra","alerts","cache"
}

def _load_state() -> Dict[str, int]:
    try:
        with open(STATE_PATH, "r") as f:
            data = json.load(f)
        out: Dict[str, int] = {}
        if isinstance(data, dict):
            for k, v in data.items():
                with suppress(Exception):
                    out[str(k)] = int(v)
        return out
    except Exception:
        return {}

def _save_state(d: Dict[str, int]) -> None:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)

def _banner(text: str) -> str:
    return f"{(' ' + text + ' '):=^70}"

# ---------------- Telethon client ----------------
_TG = None
_TG_LOCK = asyncio.Lock()

async def _ensure_tg():
    """Пробуем: (1) реюзнутый клиент из app.api.stream_gateway; (2) локальный по API_ID/HASH/SESSION."""
    global _TG
    # 1) клиент из приложения (если модуль доступен и переменные заданы)
    with suppress(Exception):
        from app.api.stream_gateway import _ensure_tg as _ensure_tg_app, _TG as _TG_app  # type: ignore
        await _ensure_tg_app()
        if _TG_app is not None:
            _TG = _TG_app
            return
    # 2) создаём свой
    api_id = _to_int(os.environ.get("TELEGRAM_API_ID"))
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    session = os.environ.get("TELEGRAM_SESSION")
    if not (api_id and api_hash and session):
        raise RuntimeError("No Telethon client. Provide TELEGRAM_API_ID/HASH/SESSION or run with --api-id/--api-hash/--session.")
    from telethon import TelegramClient
    async with _TG_LOCK:
        if _TG is None:
            client = TelegramClient(session, api_id, api_hash)
            await client.connect()
            ok = False
            with suppress(Exception):
                ok = await client.is_user_authorized()
            if not ok:
                raise RuntimeError("Telethon session not authorized. Авторизуйте TELEGRAM_SESSION.")
            _TG = client

# ---------------- Forum topics ops ----------------
async def list_all_topics(chat_id: int) -> List[Tuple[int, str]]:
    await _ensure_tg()
    assert _TG is not None
    peer = await _TG.get_entity(chat_id)
    from telethon.tl.functions.channels import GetForumTopics
    topics: List[Tuple[int, str]] = []
    offset_date = 0
    offset_id = 0
    offset_topic = 0
    while True:
        res = await _TG(GetForumTopics(
            channel=peer, q="", offset_date=offset_date,
            offset_id=offset_id, offset_topic=offset_topic, limit=100
        ))
        lst = getattr(res, "topics", []) or []
        if not lst:
            break
        for t in lst:
            topics.append((int(t.id), t.title or ""))
        offset_topic = int(lst[-1].id)
        if len(lst) < 100:
            break
    return topics

async def _bot_delete_topic(bot_token: str, chat_id: int, topic_id: int) -> bool:
    """Удаляем тему через Bot API. Если нельзя — пытаемся закрыть."""
    if not (bot_token and chat_id):
        return False
    async with httpx.AsyncClient(timeout=20.0) as http:
        r = await http.post(
            f"https://api.telegram.org/bot{bot_token}/deleteForumTopic",
            data={"chat_id": chat_id, "message_thread_id": topic_id},
        )
        if r.status_code == 200 and r.json().get("ok", False):
            return True
        with suppress(Exception):
            await http.post(
                f"https://api.telegram.org/bot{bot_token}/closeForumTopic",
                data={"chat_id": chat_id, "message_thread_id": topic_id},
            )
    return False

# ---------------- Actions ----------------
async def report(chat_id: int) -> None:
    topics = await list_all_topics(chat_id)
    print(f"Total topics: {len(topics)}")
    by_name: Dict[str, List[Tuple[int, str]]] = {}
    for tid, title in topics:
        by_name.setdefault(_norm(title), []).append((tid, title))
    for key in sorted(by_name.keys()):
        items = by_name[key]
        mark = " [CANON]" if key in CANONICAL else ""
        print("\n" + _banner(f"{key or '[empty]'}{mark}"))
        for tid, title in sorted(items, key=lambda x: x[0]):
            print(f"  id={tid:<12} title={title}")

async def cleanup(chat_id: int, bot_token: str, dry_run: bool = True) -> None:
    topics = await list_all_topics(chat_id)
    state = _load_state()

    groups: Dict[str, List[Tuple[int, str]]] = {}
    for tid, title in topics:
        groups.setdefault(_norm(title), []).append((tid, title))

    keep_ids: set[int] = set()
    to_del: List[Tuple[int, str]] = []

    for key, items in groups.items():
        if key not in CANONICAL:
            for tid, _ in items:
                keep_ids.add(tid)
            continue
        ids_sorted = sorted(items, key=lambda x: x[0])
        preferred_id: Optional[int] = None
        with suppress(Exception):
            preferred_id = int(state.get(key)) if isinstance(state, dict) else None
        winner = preferred_id if preferred_id in [tid for tid, _ in ids_sorted] else ids_sorted[0][0]
        keep_ids.add(winner)
        for tid, title in ids_sorted:
            if tid != winner:
                to_del.append((tid, title))
        state[key] = int(winner)

    existing_ids = {tid for tid, _ in topics}
    for k in list(state.keys()):
        try:
            v = int(state[k])
        except Exception:
            continue
        if v not in existing_ids and _norm(k) in CANONICAL:
            del state[k]

    print(_banner("Duplicates to delete"))
    print(f"count={len(to_del)}")
    for tid, title in sorted(to_del, key=lambda x: x[0]):
        print(f"  DEL id={tid:<12} title={title}")

    if dry_run or not to_del:
        _save_state(state)
        return

    ok, fail = 0, 0
    for tid, title in sorted(to_del, key=lambda x: x[0]):
        if await _bot_delete_topic(bot_token, chat_id, tid):
            ok += 1
        else:
            fail += 1
            print(f"  WARN: can't delete id={tid} ({title})")
    _save_state(state)
    print(_banner("Done"))
    print(f"deleted={ok}, failed={fail}. state synced.")

# ---------------- CLI ----------------
if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="OGMA Telegram forum topics maintenance")
    ap.add_argument("--apply", action="store_true", help="delete duplicates instead of dry-run")
    ap.add_argument("--chat-id", type=int, default=None, help="override TELEGRAM_LOG_CHAT_ID")
    ap.add_argument("--bot-token", type=str, default=None, help="override TELEGRAM_LOG_BOT_TOKEN / TELEMETRY_BOT_TOKEN")
    ap.add_argument("--api-id", type=int, default=None, help="override TELEGRAM_API_ID")
    ap.add_argument("--api-hash", type=str, default=None, help="override TELEGRAM_API_HASH")
    ap.add_argument("--session", type=str, default=None, help="override TELEGRAM_SESSION path")
    args = ap.parse_args()

    # подмешаем env-файл, если можно
    _load_envfile(ENVFILE)

    # CLI overrides -> env
    if args.chat_id is not None:
        os.environ["TELEGRAM_LOG_CHAT_ID"] = str(args.chat_id)
    if args.bot_token:
        os.environ["TELEGRAM_LOG_BOT_TOKEN"] = args.bot_token
    if args.api_id is not None:
        os.environ["TELEGRAM_API_ID"] = str(args.api_id)
    if args.api_hash:
        os.environ["TELEGRAM_API_HASH"] = args.api_hash
    if args.session:
        os.environ["TELEGRAM_SESSION"] = args.session

    CHAT_ID = _to_int(os.environ.get("TELEGRAM_LOG_CHAT_ID", "0"), 0)
    BOT_TOKEN = os.environ.get("TELEGRAM_LOG_BOT_TOKEN") or os.environ.get("TELEMETRY_BOT_TOKEN") or ""

    if CHAT_ID == 0:
        raise RuntimeError("CHAT_ID not set. Pass --chat-id or set TELEGRAM_LOG_CHAT_ID.")
    if args.apply and not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN not set for deletion. Pass --bot-token or set TELEGRAM_LOG_BOT_TOKEN.")

    if args.apply:
        asyncio.run(cleanup(CHAT_ID, BOT_TOKEN, dry_run=False))
    else:
        asyncio.run(report(CHAT_ID))
