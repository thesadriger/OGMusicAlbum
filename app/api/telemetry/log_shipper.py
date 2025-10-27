from __future__ import annotations
import asyncio as _aio
import logging, os, json, re, time, html
from typing import Optional, Dict
from contextlib import suppress

import httpx
from fastapi import FastAPI

STATE_PATH = os.environ.get("TELEGRAM_TOPICS_STATE", "/var/lib/ogma/telegram_topics.json")
BOT_TOKEN  = os.environ.get("TELEGRAM_LOG_BOT_TOKEN") or os.environ.get("TELEMETRY_BOT_TOKEN")
CHAT_ID    = os.environ.get("TELEGRAM_LOG_CHAT_ID")

# --- env helpers ---
def _env_str(name: str, default: str) -> str:
    return str(os.environ.get(name, default)).strip()

def _env_int(name: str, default: int) -> int:
    try:
        return int(str(os.environ.get(name, default)).strip().split()[0])
    except Exception:
        return default

def _env_bool(name: str, default: bool) -> bool:
    v = _env_str(name, "1" if default else "0").lower()
    return v in {"1","true","yes","on"}

TOPIC_NAME    = _env_str("TELEMETRY_LOGS_TOPIC", "logs")
ENABLED       = _env_bool("TELEMETRY_LOGS_ENABLED", True)
LEVEL_NAME    = _env_str("TELEMETRY_LOGS_LEVEL", "ERROR").upper()
LEVEL         = getattr(logging, LEVEL_NAME, logging.ERROR)
MIN_GAP_MS    = _env_int("TELEMETRY_LOGS_MIN_GAP_MS", 250)   # пауза между сообщениями
SILENT        = _env_bool("TELEMETRY_LOGS_SILENT", True)     # disable_notification
DROP_RE_RAW   = _env_str("TELEMETRY_LOGS_DROP", r'(GET /metrics|HTTP Request: .+ "HTTP/1\.1 200 OK"|uvicorn\.access.* 200 )')
DROP_RE       = re.compile(DROP_RE_RAW) if DROP_RE_RAW else None
MAX_QUEUE     = _env_int("TELEMETRY_LOGS_MAX_QUEUE", 200)
MAX_TEXT      = 4000  # ограничение Telegram

def _load_topics() -> Dict[str,int]:
    try:
        with open(STATE_PATH,"r") as f:
            m = json.load(f)
        return {k:int(v) for k,v in m.items() if isinstance(v,(int,str)) and str(v).isdigit()}
    except Exception:
        return {}

def _save_topics(m: Dict[str,int]) -> None:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp,"w") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)

async def _ensure_topic(http: httpx.AsyncClient, name: str) -> int:
    topics = _load_topics()
    tid = topics.get(name)
    if tid:
        return int(tid)
    r = await http.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/createForumTopic",
        data={"chat_id": CHAT_ID, "name": name},
        timeout=15.0
    )
    r.raise_for_status()
    tid = int(r.json()["result"]["message_thread_id"])
    topics[name] = tid
    _save_topics(topics)
    return tid

def _now_hms() -> str:
    return time.strftime("%H:%M:%S")

def _fmt_record(rec: logging.LogRecord) -> str:
    # Текст с HTML-эскейпом, отдельным преформатированным блоком для traceback
    head = f"🧾 <b>{html.escape(rec.levelname)}</b> <code>{html.escape(rec.name)}</code>  <i>{_now_hms()}</i>"
    msg  = html.escape(rec.getMessage() or "")
    body = f"<code>{msg}</code>" if msg else ""
    tail = ""
    if rec.exc_info:
        try:
            fmt = logging.Formatter()
            exc = fmt.formatException(rec.exc_info)
        except Exception:
            exc = ""
        if exc:
            exc = html.escape(exc)
            if len(exc) > 3500:
                exc = exc[:3500] + "…"
            tail = f"\n<pre><code>{exc}</code></pre>"
    text = f"{head}\n{body}{tail}".strip()
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT-1] + "…"
    return text

class _AsyncTelegramLogHandler(logging.Handler):
    def __init__(self):
        super().__init__(LEVEL)
        self._queue: _aio.Queue[logging.LogRecord] = _aio.Queue(MAX_QUEUE)
        self._task: Optional[_aio.Task] = None
        self._stop_evt = _aio.Event()
        self._topic_id: Optional[int] = None
        self._last_sent = 0.0

    async def start(self):
        if self._task:
            return
        self._stop_evt.clear()
        self._task = _aio.create_task(self._worker(), name="ogma-log-shipper")

    async def stop(self):
        self._stop_evt.set()
        if self._task:
            with suppress(Exception):
                await _aio.wait_for(self._task, timeout=5.0)
        self._task = None

    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno < LEVEL:
            return
        try:
            msg = record.getMessage() or ""
        except Exception:
            msg = ""
        if DROP_RE and DROP_RE.search(msg or ""):
            return
        try:
            self._queue.put_nowait(record)
        except _aio.QueueFull:
            # дропаем самое старое и добавляем новое, чтобы не зависать
            with suppress(Exception):
                self._queue.get_nowait()
            with suppress(Exception):
                self._queue.put_nowait(record)

    async def _worker(self):
        if not (BOT_TOKEN and CHAT_ID):
            return
        async with httpx.AsyncClient(timeout=15.0) as http:
            with suppress(Exception):
                self._topic_id = await _ensure_topic(http, TOPIC_NAME)

            while not self._stop_evt.is_set():
                try:
                    rec = await _aio.wait_for(self._queue.get(), timeout=1.0)
                except _aio.TimeoutError:
                    continue

                # форматирование
                text = _fmt_record(rec)

                # rate-limit: минимальный зазор
                dt = (time.time() - self._last_sent)
                if dt*1000.0 < MIN_GAP_MS:
                    await _aio.sleep((MIN_GAP_MS/1000.0) - dt if dt >= 0 else (MIN_GAP_MS/1000.0))

                # убеждаемся, что тема есть
                if not self._topic_id:
                    with suppress(Exception):
                        self._topic_id = await _ensure_topic(http, TOPIC_NAME)

                # отправка
                for attempt in range(3):
                    try:
                        r = await http.post(
                            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                            data={
                                "chat_id": CHAT_ID,
                                "message_thread_id": self._topic_id,
                                "text": text,
                                "parse_mode": "HTML",
                                "disable_web_page_preview": True,
                                "disable_notification": SILENT,
                            },
                        )
                        if r.status_code == 429:
                            retry = int(r.json().get("parameters", {}).get("retry_after", 1))
                            await _aio.sleep(retry + 0.5)
                            continue
                        r.raise_for_status()
                        self._last_sent = time.time()
                        break
                    except Exception:
                        # небольшая пауза и повтор
                        await _aio.sleep(1.0)

# ---- API для main.py ----
async def start_log_shipper(app: FastAPI):
    if not ENABLED:
        return
    h = _AsyncTelegramLogHandler()
    # поднимаем уровень только для ошибок в корневом логгере
    root = logging.getLogger()
    root.addHandler(h)
    app.state._logs_handler = h
    await h.start()

async def stop_log_shipper(app: FastAPI):
    h: _AsyncTelegramLogHandler | None = getattr(app.state, "_logs_handler", None)
    if h:
        with suppress(Exception):
            await h.stop()
        root = logging.getLogger()
        with suppress(Exception):
            root.removeHandler(h)
