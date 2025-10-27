from __future__ import annotations
import asyncio as _aio
import logging, os, time, json, html, re
from collections import deque
from contextlib import suppress
from typing import Deque, Optional, List, Dict

import httpx
from fastapi import FastAPI

# --- настройки через env ---
STATE_PATH   = os.environ.get("TELEGRAM_TOPICS_STATE", "/var/lib/ogma/telegram_topics.json")
BOT_TOKEN    = os.environ.get("TELEGRAM_LOG_BOT_TOKEN") or os.environ.get("TELEMETRY_BOT_TOKEN")
CHAT_ID      = os.environ.get("TELEGRAM_LOG_CHAT_ID")
ENABLED      = (os.environ.get("TELEMETRY_CONSOLE_ENABLED","1").lower() in {"1","true","yes"})
TOPIC_NAME   = os.environ.get("TELEMETRY_CONSOLE_TOPIC","logs").strip() or "logs"
LEVEL_NAME   = os.environ.get("TELEMETRY_CONSOLE_LEVEL","INFO").upper()
FLUSH_EVERY  = max(1, int(os.environ.get("TELEMETRY_LOGS_FLUSH_S","2")))          # как часто редактировать msg
KEEP_LINES   = max(10, int(os.environ.get("TELEMETRY_LOGS_KEEP","50")))           # сколько строк держать в буфере
DROP_RE      = os.environ.get("TELEMETRY_CONSOLE_DROP", r"GET /metrics")          # regex для отбрасываемых строк

LIVE_KEY     = f"{TOPIC_NAME}_msg_id"  # message_id «живого» сообщения

# --- утилиты состояния топиков ---
def _load_state() -> Dict[str, int]:
    try:
        with open(STATE_PATH, "r") as f:
            data = json.load(f)
        out: Dict[str,int] = {}
        for k,v in (data.items() if isinstance(data, dict) else []):
            try: out[k] = int(v)
            except Exception: pass
        return out
    except Exception:
        return {}

def _save_state(s: Dict[str,int]) -> None:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)

async def _ensure_topic_and_message(http: httpx.AsyncClient) -> int:
    """Гарантирует существование темы TOPIC_NAME и одного «живого» сообщения."""
    topics = _load_state()
    topic_id = topics.get(TOPIC_NAME)
    if not topic_id:
        r = await http.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/createForumTopic",
            data={"chat_id": CHAT_ID, "name": TOPIC_NAME},
            timeout=15.0,
        )
        r.raise_for_status()
        topic_id = int(r.json()["result"]["message_thread_id"])
        topics[TOPIC_NAME] = topic_id
        _save_state(topics)

    live_msg_id = topics.get(LIVE_KEY)
    if not live_msg_id:
        r = await http.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            data={
                "chat_id": CHAT_ID,
                "message_thread_id": topic_id,
                "text": "🧾 Console logs — live…",
                "disable_notification": True,
            },
            timeout=15.0,
        )
        r.raise_for_status()
        live_msg_id = int(r.json()["result"]["message_id"])
        topics[LIVE_KEY] = live_msg_id
        _save_state(topics)

    return topic_id

# --- logging.Handler, который кладёт строки в очередь ---
class _TopicQueueHandler(logging.Handler):
    def __init__(self, q: _aio.Queue[str], level: int, drop_re: Optional[re.Pattern[str]]):
        super().__init__(level)
        self.q = q
        self.drop_re = drop_re
        fmt = logging.Formatter(fmt="%(asctime)s %(levelname)s %(name)s: %(message)s",
                                datefmt="%H:%M:%S")
        self.setFormatter(fmt)

    def emit(self, record: logging.LogRecord):
        try:
            msg = self.format(record)
            if self.drop_re and self.drop_re.search(msg):
                return
            if len(msg) > 800:
                msg = msg[:800] + "…"
            # без блокировок — если переполнено, молча отбрасываем
            try:
                self.q.put_nowait(msg)
            except _aio.QueueFull:
                pass
        except Exception:
            pass

# --- цикл редактирования «живого» сообщения ---
async def _drain_loop(stop_evt: _aio.Event, q: _aio.Queue[str]):
    if not (BOT_TOKEN and CHAT_ID):
        return
    buf: Deque[str] = deque(maxlen=KEEP_LINES)
    last_sent = 0.0
    async with httpx.AsyncClient(timeout=15.0) as http:
        with suppress(Exception):
            await _ensure_topic_and_message(http)

        while not stop_evt.is_set():
            # ждём новые строки или таймаут флаша
            try:
                item = await _aio.wait_for(q.get(), timeout=FLUSH_EVERY)
                buf.append(item)
            except _aio.TimeoutError:
                pass

            # если давно не обновлялись — отправим текущий хвост
            now = time.time()
            if (now - last_sent) >= FLUSH_EVERY and buf:
                topics = _load_state()
                live_msg_id = topics.get(LIVE_KEY)
                if not live_msg_id:
                    with suppress(Exception):
                        await _ensure_topic_and_message(http)
                    topics = _load_state()
                    live_msg_id = topics.get(LIVE_KEY)
                    if not live_msg_id:
                        await _aio.sleep(1.0)
                        continue

                text_lines = "\n".join(buf)
                # экранируем под HTML и ограничим по длине телеги (4096)
                payload = f"🧾 <b>Console logs</b>\n<code>{html.escape(text_lines)}</code>\n<i>updated: {time.strftime('%H:%M:%S')}</i>"
                if len(payload) > 4096:
                    # грубо обрежем начало кода, сохранив хвост
                    over = len(payload) - 4096 + 3
                    text_cut = html.escape(text_lines)[over:]
                    payload = f"🧾 <b>Console logs</b>\n<code>…{text_cut}</code>\n<i>updated: {time.strftime('%H:%M:%S')}</i>"

                try:
                    r = await http.post(
                        f"https://api.telegram.org/bot{BOT_TOKEN}/editMessageText",
                        data={
                            "chat_id": CHAT_ID,
                            "message_id": live_msg_id,
                            "text": payload,
                            "parse_mode": "HTML",
                            "disable_web_page_preview": True,
                        },
                    )
                    if r.status_code == 400:
                        # возможно, сообщение удалили — создадим заново
                        with suppress(Exception):
                            await _ensure_topic_and_message(http)
                    last_sent = now
                except Exception:
                    # не упадём — подождём и повторим
                    await _aio.sleep(1.0)

# --- API для main.py ---
async def start_console_logs(app: FastAPI):
    if not ENABLED:
        return
    try:
        level = getattr(logging, LEVEL_NAME, logging.INFO)
    except Exception:
        level = logging.INFO

    drop_re = re.compile(DROP_RE) if DROP_RE else None
    q: _aio.Queue[str] = _aio.Queue(maxsize=5000)
    handler = _TopicQueueHandler(q, level, drop_re)

    # важное: пусть uvicorn и httpx пробрасывают в root
    for name in ("uvicorn.error", "uvicorn.access", "httpx"):
        logging.getLogger(name).propagate = True

    root = logging.getLogger()
    root.addHandler(handler)
    # не трогаем root.setLevel, чтобы сохранить текущую политику;
    # но если нужно жёстко поднять уровень — используйте TELEMETRY_CONSOLE_LEVEL

    stop_evt = _aio.Event()
    task = _aio.create_task(_drain_loop(stop_evt, q), name="ogma-console-logs")
    app.state._console_logs_stop_evt = stop_evt
    app.state._console_logs_task = task
    app.state._console_logs_handler = handler

async def stop_console_logs(app: FastAPI):
    handler = getattr(app.state, "_console_logs_handler", None)
    if handler:
        with suppress(Exception):
            logging.getLogger().removeHandler(handler)

    stop_evt = getattr(app.state, "_console_logs_stop_evt", None)
    task = getattr(app.state, "_console_logs_task", None)
    if stop_evt:
        stop_evt.set()
    if task:
        with suppress(Exception):
            await _aio.wait_for(task, timeout=5.0)
