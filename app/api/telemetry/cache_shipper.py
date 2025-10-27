from __future__ import annotations
import asyncio as _aio
import os, time, glob, stat, json, re
from typing import Iterable, List, Optional, Tuple, Dict
from contextlib import suppress

import httpx
from fastapi import FastAPI

STATE_PATH   = os.environ.get("TELEGRAM_TOPICS_STATE", "/var/lib/ogma/telegram_topics.json")
BOT_TOKEN    = os.environ.get("TELEGRAM_LOG_BOT_TOKEN") or os.environ.get("TELEMETRY_BOT_TOKEN")
CHAT_ID      = os.environ.get("TELEGRAM_LOG_CHAT_ID")

# ---- robust env helpers ----
_num = re.compile(r"\s*([0-9]+)")
def _env_int(name: str, default: int) -> int:
    s = os.environ.get(name, "")
    if not s:
        return default
    m = _num.match(str(s))
    return int(m.group(1)) if m else default

def _env_str(name: str, default: str) -> str:
    return str(os.environ.get(name, default)).strip()

def _env_list(name: str, default: str) -> List[str]:
    raw = _env_str(name, default)
    return [p.strip() for p in raw.split(":") if p.strip()]

# === Настройки шиппера ===
ENABLED            = _env_str("TELEMETRY_CACHE_ENABLED", "1").lower() in {"1","true","yes"}
INTERVAL_S         = _env_int("TELEMETRY_CACHE_INTERVAL", 300)
MIN_FREE_MB        = _env_int("TELEMETRY_CACHE_MIN_FREE_MB", 1500)
PATHS              = _env_list("TELEMETRY_CACHE_PATHS", "/var/log/*.gz:/var/log/*.[0-9]:/home/ogma/.cache/pip:/var/tmp")
MAX_MB_PER_FILE    = _env_int("TELEMETRY_CACHE_MAX_MB", 45)
MAX_FILES_PER_RUN  = _env_int("TELEMETRY_CACHE_MAX_FILES", 20)
MIN_AGE_S          = _env_int("TELEMETRY_CACHE_MIN_AGE_S", 300)
TOPIC_NAME         = _env_str("TELEMETRY_CACHE_TOPIC", "cache")

def _load_topics() -> Dict[str,int]:
    try:
        with open(STATE_PATH,"r") as f:
            data = json.load(f)
            out: Dict[str,int] = {}
            for k,v in data.items():
                try:
                    out[k] = int(v)
                except Exception:
                    continue
            return out
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

def _free_mb(path: str = "/") -> int:
    st = os.statvfs(path)
    return int(st.f_bavail * st.f_frsize / (1024*1024))

def _iter_paths() -> Iterable[str]:
    for part in PATHS:
        matches = glob.glob(part)
        if not matches:
            if os.path.exists(part):
                yield part
        else:
            for m in matches:
                yield m

def _walk_files(root: str) -> Iterable[str]:
    if os.path.isfile(root):
        yield root
        return
    for base, dirs, files in os.walk(root):
        if base.startswith(("/proc","/sys","/dev")):
            continue
        for fn in files:
            yield os.path.join(base, fn)

def _file_ok(p: str, now: float) -> Optional[Tuple[str,int]]:
    try:
        st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode):
            return None
        if (now - st.st_mtime) < MIN_AGE_S:
            return None
        size = int(st.st_size)
        mb = size / (1024*1024)
        if mb <= 0 or mb > MAX_MB_PER_FILE:
            return None
        return (p, size)
    except Exception:
        return None

def _collect_candidates() -> List[Tuple[str,int]]:
    now = time.time()
    out: List[Tuple[str,int]] = []
    for root in _iter_paths():
        if not os.path.exists(root):
            continue
        for p in _walk_files(root):
            ok = _file_ok(p, now)
            if ok:
                out.append(ok)
    out.sort(key=lambda x: os.path.getmtime(x[0]))  # старые первыми
    return out

async def _send_file(http: httpx.AsyncClient, topic_id: int, path: str, size: int) -> bool:
    name = os.path.basename(path)
    cap = f"cache: <code>{path}</code>  ({size//1024} KB)"
    try:
        with open(path, "rb") as f:
            r = await http.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendDocument",
                data={
                    "chat_id": CHAT_ID,
                    "message_thread_id": topic_id,
                    "caption": cap,
                    "parse_mode": "HTML",
                    "disable_notification": True,
                },
                files={"document": (name, f)},
                timeout=120.0,
            )
        return r.status_code == 200 and r.json().get("ok", False)
    except Exception:
        return False

async def _run_once(http: httpx.AsyncClient, topic_id: int) -> int:
    sent = 0
    for path, size in _collect_candidates():
        if sent >= MAX_FILES_PER_RUN:
            break
        if await _send_file(http, topic_id, path, size):
            with suppress(Exception):
                os.remove(path)
            sent += 1
    return sent

async def _runner(stop_evt: _aio.Event):
    if not (ENABLED and BOT_TOKEN and CHAT_ID):
        return
    async with httpx.AsyncClient() as http:
        with suppress(Exception):
            topic_id = await _ensure_topic(http, TOPIC_NAME)
        while not stop_evt.is_set():
            try:
                free_now = _free_mb("/")
                if free_now < MIN_FREE_MB:
                    with suppress(Exception):
                        topic_id = await _ensure_topic(http, TOPIC_NAME)
                    sent = await _run_once(http, topic_id)
                else:
                    sent = 0
            except Exception:
                sent = 0
            wait_s = INTERVAL_S if sent == 0 else max(5, INTERVAL_S // 2)
            try:
                await _aio.wait_for(stop_evt.wait(), timeout=wait_s)
            except _aio.TimeoutError:
                pass

# API для main.py
async def start_cache_shipper(app: FastAPI):
    if not ENABLED:
        return
    stop_evt = _aio.Event()
    task = _aio.create_task(_runner(stop_evt), name="ogma-cache-shipper")
    app.state._cache_shipper_stop_evt = stop_evt
    app.state._cache_shipper_task = task

async def stop_cache_shipper(app: FastAPI):
    stop_evt = getattr(app.state, "_cache_shipper_stop_evt", None)
    task = getattr(app.state, "_cache_shipper_task", None)
    if stop_evt:
        stop_evt.set()
    if task:
        with suppress(Exception):
            await _aio.wait_for(task, timeout=5.0)
