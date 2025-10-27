from __future__ import annotations
import json, os
from contextlib import suppress
from typing import Any, Dict, Optional
import httpx

STATE_PATH = os.environ.get("TELEGRAM_TOPICS_STATE", "/var/lib/ogma/telegram_topics.json")
BOT_TOKEN  = os.environ.get("TELEGRAM_LOG_BOT_TOKEN") or os.environ.get("TELEMETRY_BOT_TOKEN")
CHAT_ID    = os.environ.get("TELEGRAM_LOG_CHAT_ID")

def _load_state() -> Dict[str, Any]:
    try:
        with open(STATE_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_state(s: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)

async def _ensure_topic(http: httpx.AsyncClient, name: str) -> int:
    st = _load_state()
    tid = st.get(name)
    if tid:
        return int(tid)
    r = await http.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/createForumTopic",
        data={"chat_id": CHAT_ID, "name": name},
        timeout=15.0,
    )
    r.raise_for_status()
    tid = int(r.json()["result"]["message_thread_id"])
    st[name] = tid
    _save_state(st)
    return tid

def _thread_error(resp_json: Dict[str, Any]) -> bool:
    desc = (resp_json.get("description") or "").lower()
    return (
        "message_thread_not_found" in desc
        or ("thread" in desc and ("not found" in desc or "invalid" in desc))
    )

class EventLog:
    def __init__(self, *_, **__):
        self._http: Optional[httpx.AsyncClient] = None

    async def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=15.0)
        return self._http

    async def send(self, topic: str, text: str) -> bool:
        if not (BOT_TOKEN and CHAT_ID):
            return False
        http = await self._client()
        st = _load_state()
        tid = st.get(topic)
        if not tid:
            tid = await _ensure_topic(http, topic)

        data = {
            "chat_id": CHAT_ID,
            "message_thread_id": int(tid),
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
            "disable_notification": True,
        }
        r = await http.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage", data=data)
        if r.status_code == 200 and (r.json().get("ok") is True):
            return True

        j: Dict[str, Any] = {}
        with suppress(Exception):
            j = r.json()
        if r.status_code == 400 and _thread_error(j):
            st = _load_state()
            st.pop(topic, None)
            _save_state(st)
            new_tid = await _ensure_topic(http, topic)
            data["message_thread_id"] = int(new_tid)
            r2 = await http.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage", data=data)
            return (r2.status_code == 200 and (r2.json().get("ok") is True))
        return False

    async def aclose(self):
        if self._http:
            with suppress(Exception):
                await self._http.aclose()
            self._http = None
