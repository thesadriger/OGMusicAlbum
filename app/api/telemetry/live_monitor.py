from __future__ import annotations
import asyncio, json, os, time, logging
from contextlib import suppress
from typing import Any, Dict, Optional, Tuple, List, DefaultDict
from collections import defaultdict

import httpx
from fastapi import FastAPI

try:
    import psutil  # для топов по сервисам
except Exception:
    psutil = None  # graceful degrade

STATE_PATH  = os.environ.get("TELEGRAM_TOPICS_STATE", "/var/lib/ogma/telegram_topics.json")
BOT_TOKEN   = os.environ.get("TELEGRAM_LOG_BOT_TOKEN") or os.environ.get("TELEMETRY_BOT_TOKEN")
CHAT_ID     = os.environ.get("TELEGRAM_LOG_CHAT_ID")
PROM_URL    = (os.environ.get("PROM_URL") or "http://127.0.0.1:9090").rstrip("/")
ENABLED     = (os.environ.get("TELEMETRY_LIVE_ENABLED", "1").lower() in {"1","true","yes"})

# Сообщение 1 — агрегированная инфра, апдейт раз в 1с
INTERVAL_S  = max(1, int(os.environ.get("TELEMETRY_LIVE_INTERVAL", "1")))
TOPIC_NAME  = "infra"
LIVE_KEY    = "infra_live_msg_id"

# Сообщение 2 — топ сервисов
PROCS_ENABLED      = (os.environ.get("TELEMETRY_PROCS_ENABLED", "1").lower() in {"1","true","yes"})
PROCS_INTERVAL_S   = max(2, int(os.environ.get("TELEMETRY_PROCS_INTERVAL", "3")))
PROCS_TOPN         = max(3, int(os.environ.get("TELEMETRY_PROCS_TOPN", "5")))
PROCS_NET_EVERY_S  = max(3, int(os.environ.get("TELEMETRY_PROCS_NET_EVERY", "5")))
PROCS_KEY          = "infra_procs_msg_id"

log = logging.getLogger("ogma.live")

# ── кэш последнего отправленного текста, чтобы не слать лишние editMessageText
_LAST_INFRA_TEXT: str = ""
_LAST_PROCS_TEXT: str = ""

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

async def _prom_query(c: httpx.AsyncClient, q: str) -> Optional[float]:
    r = await c.get(f"{PROM_URL}/api/v1/query", params={"query": q}, timeout=5.0)
    r.raise_for_status()
    data = r.json()
    if data.get("status") != "success":
        return None
    res = data["data"]["result"]
    if not res:
        return None
    v = res[0]["value"][1]
    try:
        return float(v)
    except Exception:
        return None

async def _ensure_topic(http: httpx.AsyncClient) -> int:
    state = _load_state()
    topic_id = state.get(TOPIC_NAME)
    if topic_id:
        return int(topic_id)
    r = await http.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/createForumTopic",
        data={"chat_id": CHAT_ID, "name": TOPIC_NAME},
        timeout=10.0,
    )
    r.raise_for_status()
    topic_id = int(r.json()["result"]["message_thread_id"])
    state[TOPIC_NAME] = topic_id
    _save_state(state)
    return topic_id

async def _ensure_live_msg(http: httpx.AsyncClient, key: str, title: str) -> int:
    state = _load_state()
    msg_id = state.get(key)
    if msg_id:
        return int(msg_id)
    topic_id = await _ensure_topic(http)
    r = await http.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
        data={
            "chat_id": CHAT_ID,
            "message_thread_id": topic_id,
            "text": title,
            "disable_notification": True,
        },
        timeout=10.0,
    )
    r.raise_for_status()
    msg_id = int(r.json()["result"]["message_id"])
    state[key] = msg_id
    _save_state(state)
    if key == LIVE_KEY:
        with suppress(Exception):
            await http.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/pinChatMessage",
                data={"chat_id": CHAT_ID, "message_id": msg_id, "disable_notification": True},
                timeout=10.0,
            )
    return msg_id

def _fmt_bytes_per_s(v: Optional[float]) -> str:
    if v is None: return "n/a"
    for unit in ("B/s","KB/s","MB/s","GB/s","TB/s"):
        if abs(v) < 1024.0: return f"{v:.1f} {unit}"
        v /= 1024.0
    return f"{v:.1f} PB/s"

def _fmt_bytes(v: Optional[float]) -> str:
    if v is None: return "n/a"
    for unit in ("B","KB","MB","GB","TB"):
        if abs(v) < 1024.0: return f"{v:.1f} {unit}"
        v /= 1024.0
    return f"{v:.1f} PB"

# ---------- Сообщение №1: общая инфра ----------
async def _build_infra_text(http: httpx.AsyncClient) -> str:
    cpu = await _prom_query(http, '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)')
    load1 = await _prom_query(http, "node_load1")
    mem_used_pct = await _prom_query(http, "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100")
    mem_total = await _prom_query(http, "node_memory_MemTotal_bytes")
    mem_avail = await _prom_query(http, "node_memory_MemAvailable_bytes")
    disk_used_pct = await _prom_query(http, '100 - (node_filesystem_avail_bytes{mountpoint="/",fstype=~"ext4|xfs"} * 100 / node_filesystem_size_bytes{mountpoint="/",fstype=~"ext4|xfs"})')
    disk_size = await _prom_query(http, 'node_filesystem_size_bytes{mountpoint="/",fstype=~"ext4|xfs"}')
    disk_avail = await _prom_query(http, 'node_filesystem_avail_bytes{mountpoint="/",fstype=~"ext4|xfs"}')
    rx = await _prom_query(http, 'sum(rate(node_network_receive_bytes_total{device!~"lo"}[1m]))')
    tx = await _prom_query(http, 'sum(rate(node_network_transmit_bytes_total{device!~"lo"}[1m]))')

    used_mem = (mem_total - mem_avail) if (mem_total and mem_avail) else None
    text = (
        "⚙️ <b>Infra — live</b>\n"
        f"CPU: <code>{(cpu or 0):.1f}%</code>  |  load1: <code>{(load1 or 0):.2f}</code>\n"
        f"RAM: <code>{(mem_used_pct or 0):.1f}%</code> "
        f"({ _fmt_bytes(used_mem) } / { _fmt_bytes(mem_total) })\n"
        f"Disk /: <code>{(disk_used_pct or 0):.1f}%</code> "
        f"({ _fmt_bytes((disk_size - disk_avail) if (disk_size and disk_avail) else None) } / { _fmt_bytes(disk_size) })\n"
        f"Net: ⬇ { _fmt_bytes_per_s(rx) }   ⬆ { _fmt_bytes_per_s(tx) }\n"
        f"<i>updated: {time.strftime('%H:%M:%S')}</i>"
    )
    return text

async def _edit_text(http: httpx.AsyncClient, msg_id: int, text: str, key_to_clear: str) -> bool:
    """Редактирует текст. Возвращает True, если итоговое состояние ок (в т.ч. 'message is not modified')."""
    r = await http.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/editMessageText",
        data={
            "chat_id": CHAT_ID,
            "message_id": msg_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
        timeout=10.0,
    )
    if r.status_code == 200:
        return True
    # разбор 400
    with suppress(Exception):
        jr = r.json()
        desc = str(jr.get("description","")).lower()
        if "message is not modified" in desc:
            return True
        if "message to edit not found" in desc:
            s = _load_state(); s.pop(key_to_clear, None); _save_state(s)
            return False
    r.raise_for_status()
    return True  # на всякий

async def _tick_infra(http: httpx.AsyncClient):
    global _LAST_INFRA_TEXT
    await _ensure_topic(http)
    msg_id = await _ensure_live_msg(http, LIVE_KEY, "🟢 Infra — live…")
    text = await _build_infra_text(http)
    if text == _LAST_INFRA_TEXT:
        return
    ok = await _edit_text(http, msg_id, text, LIVE_KEY)
    if ok:
        _LAST_INFRA_TEXT = text

# ---------- Сообщение №2: топ сервисов ----------
_prev_cpu_tot: Optional[float] = None
_prev_proc_cpu: Dict[int, float] = {}
_prev_proc_io: Dict[int, Tuple[int,int]] = {}  # pid -> (read_bytes, write_bytes)
_last_net_sample: float = 0.0
_conn_count: Dict[int, int] = {}  # pid -> established count

def _unit_of_pid(pid: int) -> str:
    """Пытаемся сопоставить PID к systemd unit из /proc/<pid>/cgroup; fallback на имя процесса."""
    if not psutil:
        return f"pid:{pid}"
    name = None
    try:
        with open(f"/proc/{pid}/comm","r") as f:
            name = f.read().strip()
    except Exception:
        name = None
    try:
        with open(f"/proc/{pid}/cgroup","r") as f:
            for line in f:
                if "/system.slice/" in line and ".service" in line:
                    seg = line.split("/system.slice/")[1].strip()
                    seg = seg.split(".service")[0] + ".service"
                    return seg
    except Exception:
        pass
    return name or f"pid:{pid}"

def _agg_top_services(now: float) -> Dict[str, Any]:
    global _prev_cpu_tot, _prev_proc_cpu, _prev_proc_io, _last_net_sample, _conn_count
    out: DefaultDict[str, Dict[str, float]] = defaultdict(lambda: {"cpu":0.0,"rd":0.0,"wr":0.0,"conns":0.0})
    if not psutil:
        return {"cpu": [], "rd": [], "wr": [], "conns": []}

    cpu_times = psutil.cpu_times()
    cpu_tot = float(sum(cpu_times))
    delta_tot = None if _prev_cpu_tot is None else max(1e-6, cpu_tot - _prev_cpu_tot)

    for p in psutil.process_iter(attrs=["pid"]):
        pid = p.info["pid"]
        try:
            if not psutil.pid_exists(pid):
                continue
            pt = psutil.Process(pid)
            cput = pt.cpu_times()
            proc_tot = float(cput.user + cput.system)
            prev_proc = _prev_proc_cpu.get(pid)
            d_cpu = (proc_tot - prev_proc) if prev_proc is not None else 0.0
            _prev_proc_cpu[pid] = proc_tot

            try:
                io = pt.io_counters()
                r_cur, w_cur = int(io.read_bytes), int(io.write_bytes)
            except Exception:
                r_cur, w_cur = 0, 0
            r_prev, w_prev = _prev_proc_io.get(pid, (r_cur, w_cur))
            d_r, d_w = max(0, r_cur - r_prev), max(0, w_cur - w_prev)
            _prev_proc_io[pid] = (r_cur, w_cur)

            unit = _unit_of_pid(pid)
            if delta_tot is not None and d_cpu >= 0:
                out[unit]["cpu"] += (d_cpu / delta_tot) * 100.0
            out[unit]["rd"] += float(d_r)
            out[unit]["wr"] += float(d_w)
        except Exception:
            continue

    _prev_cpu_tot = cpu_tot

    if (now - _last_net_sample) >= PROCS_NET_EVERY_S:
        _conn_count = {}
        with suppress(Exception):
            for c in psutil.net_connections(kind="tcp"):
                if c.status == psutil.CONN_ESTABLISHED and c.pid:
                    _conn_count[c.pid] = _conn_count.get(c.pid, 0) + 1
        _last_net_sample = now

    for pid, cnt in _conn_count.items():
        unit = _unit_of_pid(pid)
        out[unit]["conns"] += float(cnt)

    def topk(key: str) -> List[Tuple[str,float]]:
        items = [(u, v[key]) for u, v in out.items() if v[key] > 0]
        items.sort(key=lambda x: x[1], reverse=True)
        return items[:PROCS_TOPN]

    return {"cpu": topk("cpu"), "rd": topk("rd"), "wr": topk("wr"), "conns": topk("conns")}

def _fmt_services_text(agg: Dict[str, Any]) -> str:
    def fmt_lines(title: str, pairs: List[Tuple[str,float]], unit: str) -> str:
        if not pairs:
            return f"<b>{title}</b>\n<i>no data</i>\n"
        lines = [f"<b>{title}</b>"]
        for u, v in pairs:
            if unit == "%":
                lines.append(f"• <code>{u}</code> — <code>{v:.1f}%</code>")
            elif unit == "B/s":
                vv = v
                for lab in ("B/s","KB/s","MB/s","GB/s","TB/s"):
                    if vv < 1024.0:
                        lines.append(f"• <code>{u}</code> — <code>{vv:.1f} {lab}</code>")
                        break
                    vv /= 1024.0
            elif unit == "conns":
                lines.append(f"• <code>{u}</code> — <code>{int(v)}</code> conns")
        return "\n".join(lines) + "\n"

    return (
        "🧰 <b>Infra — services (live)</b>\n"
        + fmt_lines("Top CPU (by unit)", agg.get("cpu", []), "%")
        + fmt_lines("Top Disk Write",    agg.get("wr", []),  "B/s")
        + fmt_lines("Top Disk Read",     agg.get("rd", []),  "B/s")
        + fmt_lines("Top Net (ESTABLISHED conns)", agg.get("conns", []), "conns")
        + f"<i>updated: {time.strftime('%H:%M:%S')}</i>"
    )

async def _tick_procs(http: httpx.AsyncClient):
    global _LAST_PROCS_TEXT
    if not PROCS_ENABLED:
        return
    if psutil is None:
        msg_id = await _ensure_live_msg(http, PROCS_KEY, "🧰 Infra — services (psutil not installed)")
        with suppress(Exception):
            await _edit_text(http, msg_id,
                             "🧰 <b>Infra — services</b>\n<i>psutil is not installed. Install python3-psutil or pip install psutil.</i>",
                             PROCS_KEY)
        return

    msg_id = await _ensure_live_msg(http, PROCS_KEY, "🧰 Infra — services …")
    agg = _agg_top_services(time.time())
    text = _fmt_services_text(agg)
    if text == _LAST_PROCS_TEXT:
        return
    ok = await _edit_text(http, msg_id, text, PROCS_KEY)
    if ok:
        _LAST_PROCS_TEXT = text

# ---------- Runner ----------
async def _runner(stop_evt: asyncio.Event):
    if not (BOT_TOKEN and CHAT_ID and ENABLED):
        return
    async with httpx.AsyncClient(timeout=10.0) as http:
        with suppress(Exception):
            await _tick_infra(http)
        t_last_procs = 0.0
        while not stop_evt.is_set():
            t0 = time.time()
            try:
                await _tick_infra(http)
            except httpx.HTTPStatusError as e:
                retry_after = 1
                with suppress(Exception):
                    retry_after = int(e.response.headers.get("Retry-After", "1"))
                log.warning("infra edit error %s, retry in %ss", e.response.status_code, retry_after)
                await asyncio.sleep(max(1, retry_after))
            except Exception as e:
                log.warning("infra tick failed: %r", e)

            now = time.time()
            if (now - t_last_procs) >= PROCS_INTERVAL_S:
                with suppress(Exception):
                    await _tick_procs(http)
                t_last_procs = now

            elapsed = time.time() - t0
            wait_left = max(0.0, INTERVAL_S - elapsed)
            try:
                await asyncio.wait_for(stop_evt.wait(), timeout=wait_left)
            except asyncio.TimeoutError:
                pass

# API для main.py
async def start_live_monitors(app: FastAPI):
    if not ENABLED:
        return
    stop_evt = asyncio.Event()
    task = asyncio.create_task(_runner(stop_evt), name="ogma-live-monitor")
    app.state._live_monitor_stop_evt = stop_evt
    app.state._live_monitor_task = task

async def stop_live_monitors(app: FastAPI):
    stop_evt = getattr(app.state, "_live_monitor_stop_evt", None)
    task = getattr(app.state, "_live_monitor_task", None)
    if stop_evt:
        stop_evt.set()
    if task:
        with suppress(Exception):
            await asyncio.wait_for(task, timeout=3.0)
