# app/api/telegram_logger.py
from __future__ import annotations
import asyncio as _a
import logging
from typing import Optional, List
import httpx

_MAX_MSG = 3900  # запас до лимита 4096

def _chunk(s: str, n: int):
    for i in range(0, len(s), n):
        yield s[i:i+n]

class TelegramHandler(logging.Handler):
    def __init__(
        self,
        bot_token: str,
        chat_id: str | int,
        *,
        level: int=logging.WARNING,
        batch_secs: float=1.0,
        max_batch: int=8,
    ):
        super().__init__(level)
        self._token = bot_token
        self._chat_id = str(chat_id)
        self._q: _a.Queue[str] = _a.Queue()
        self._task: Optional[_a.Task] = None
        self._batch_secs = batch_secs
        self._max_batch = max_batch
        self._client: Optional[httpx.AsyncClient] = None

    async def start(self):
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=f"https://api.telegram.org/bot{self._token}",
                timeout=10.0,
            )
        if self._task is None:
            self._task = _a.create_task(self._worker(), name="tg-log-worker")

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except _a.CancelledError:
                pass
            self._task = None
        if self._client:
            await self._client.aclose()
            self._client = None

    async def _worker(self):
        assert self._client is not None
        while True:
            try:
                first = await self._q.get()
                batch: List[str] = [first]
                try:
                    with _a.timeout(self._batch_secs):
                        while len(batch) < self._max_batch:
                            batch.append(await self._q.get())
                except Exception:
                    pass  # таймаут

                text = "\n\n".join(batch)
                for part in _chunk(text, _MAX_MSG):
                    await self._client.post(
                        "/sendMessage",
                        data={"chat_id": self._chat_id, "text": part},
                    )
            except Exception:
                # не роняем приложение из-за телеги
                pass

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            # простая маскировка токенов/куков
            for key in ("Authorization", "X-Telegram-Init-Data", "Cookie", "Set-Cookie"):
                msg = msg.replace(key, f"{key}=<redacted>")
            # лог длинный — режем на чанки уже в воркере
            self._q.put_nowait(msg)
        except Exception:
            pass