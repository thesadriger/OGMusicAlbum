from __future__ import annotations
import os, json
from typing import Dict, List, Optional
import httpx

STATE_PATH_DEFAULT = "/var/lib/ogma/telegram_topics.json"

class TelegramForumManager:
    def __init__(self, bot_token: str, chat_id: str | int, state_path: Optional[str] = None):
        self._bot_token = bot_token
        self._chat_id = int(chat_id)
        self._base = f"https://api.telegram.org/bot{bot_token}"
        self._state_path = state_path or os.environ.get("TELEGRAM_TOPICS_STATE", STATE_PATH_DEFAULT)
        self._topics: Dict[str,int] = {}

    async def _load_state(self):
        try:
            with open(self._state_path, "r", encoding="utf-8") as f:
                self._topics = {k:int(v) for k,v in json.load(f).items()}
        except Exception:
            self._topics = {}

    async def _save_state(self):
        try:
            os.makedirs(os.path.dirname(self._state_path), exist_ok=True)
            with open(self._state_path, "w", encoding="utf-8") as f:
                json.dump(self._topics, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    async def ensure_topics(self, names: List[str]) -> Dict[str,int]:
        await self._load_state()
        async with httpx.AsyncClient(timeout=10.0) as cl:
            for name in names:
                if name in self._topics:
                    continue
                r = await cl.post(f"{self._base}/createForumTopic", data={
                    "chat_id": self._chat_id,
                    "name": name[:128],
                })
                data = r.json()
                # если это канал/нет прав — ok:false → пропустим, не роняем приложение
                if not data.get("ok"):
                    continue
                thread_id = int(data["result"]["message_thread_id"])
                self._topics[name] = thread_id
            await self._save_state()
        return self._topics

    def get_thread(self, name: str) -> Optional[int]:
        return self._topics.get(name)

    async def send(self, topic: str, text: str, parse_mode: Optional[str] = "HTML"):
        thread_id = self.get_thread(topic)
        data = {
            "chat_id": self._chat_id,
            "text": text[:4096],
            "disable_web_page_preview": True,
        }
        if parse_mode:
            data["parse_mode"] = parse_mode
        if thread_id:
            data["message_thread_id"] = thread_id
        async with httpx.AsyncClient(timeout=10.0) as cl:
            await cl.post(f"{self._base}/sendMessage", data=data)