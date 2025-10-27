from __future__ import annotations
import os, glob, stat, time, json, re, html, sys
from typing import Iterable, List, Tuple, Dict, Optional
import httpx

# ---- env helpers ----
_num = re.compile(r"\s*([0-9]+)")
def _env_int(name: str, default: int) -> int:
    s = os.environ.get(name, "")
    if not s: return default
    m = _num.match(str(s))
    return int(m.group(1)) if m else default
def _env_str(name: str, default: str) -> str:
    return str(os.environ.get(name, default)).strip()
def _env_list(name: str, default: str) -> List[str]:
    raw = _env_str(name, default)
    return [p.strip() for p in raw.split(":") if p.strip()]

STATE_PATH = _env_str("TELEGRAM_TOPICS_STATE", "/var/lib/ogma/telegram_topics.json")
BOT_TOKEN  = _env_str("TELEGRAM_LOG_BOT_TOKEN", "") or _env_str("TELEMETRY_BOT_TOKEN", "") or _env_str("BOT_TOKEN","")
CHAT_ID    = _env_str("TELEGRAM_LOG_CHAT_ID", "") or _env_str("CHAT_ID","")
TOPIC_NAME = _env_str("TELEMETRY_CACHE_TOPIC", "cache")
PATHS      = _env_list("TELEMETRY_CACHE_PATHS", "/var/log/*.gz:/var/log/*.[0-9]:/home/ogma/.cache/pip:/var/tmp")
MAX_MB     = _env_int("TELEMETRY_CACHE_MAX_MB", 45)
MIN_AGE_S  = _env_int("TELEMETRY_CACHE_MIN_AGE_S", 0)  # дампим всё по запросу
SILENT     = _env_str("TELEMETRY_CACHE_SILENT", "1").lower() in {"1","true","yes","on"}
DRY_RUN    = _env_str("DRY_RUN","0").lower() in {"1","true","yes","on"}

def _load_topics() -> Dict[str,int]:
    try:
        with open(STATE_PATH,"r") as f:
            data = json.load(f)
        return {k:int(v) for k,v in data.items() if str(v).isdigit()}
    except Exception:
        return {}
def _save_topics(m: Dict[str,int]) -> None:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp,"w") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)
def _ensure_topic(http: httpx.Client, name: str) -> int:
    topics = _load_topics()
    if name in topics:
        return int(topics[name])
    r = http.post(f"https://api.telegram.org/bot{BOT_TOKEN}/createForumTopic",
                  data={"chat_id": CHAT_ID, "name": name}, timeout=30.0)
    r.raise_for_status()
    tid = int(r.json()["result"]["message_thread_id"])
    topics[name] = tid
    _save_topics(topics)
    return tid

def _iter_paths() -> Iterable[str]:
    for part in PATHS:
        matches = glob.glob(part)
        if not matches:
            if os.path.exists(part):
                yield part
        else:
            for m in matches:
                yield m

def _walk(root: str) -> Iterable[str]:
    if os.path.isfile(root):
        yield root; return
    for base, dirs, files in os.walk(root):
        if base.startswith(("/proc","/sys","/dev")):
            continue
        for fn in files:
            yield os.path.join(base, fn)

def _candidates() -> List[Tuple[str,int,float]]:
    now = time.time()
    out: List[Tuple[str,int,float]] = []
    limit = MAX_MB * 1024 * 1024
    for root in _iter_paths():
        if not os.path.exists(root): continue
        for p in _walk(root):
            try:
                st = os.lstat(p)
                if not stat.S_ISREG(st.st_mode):
                    continue
                if (now - st.st_mtime) < MIN_AGE_S:
                    continue
                size = int(st.st_size)
                if size <= 0 or size > limit:
                    continue
                out.append((p, size, st.st_mtime))
            except Exception:
                continue
    out.sort(key=lambda t: t[2])  # старые первыми
    return out

def _human(n: int) -> str:
    for unit in ("B","KB","MB","GB"):
        if n < 1024 or unit=="GB":
            return f"{n:.0f} {unit}" if unit=="B" else f"{n/1024:.1f} {unit}" if unit=="KB" else f"{n/(1024*1024):.1f} {unit}" if unit=="MB" else f"{n/(1024*1024*1024):.2f} {unit}"
        n //= 1024
    return f"{n} B"

def main() -> int:
    if not (BOT_TOKEN and CHAT_ID):
        print("ERR: BOT_TOKEN/CHAT_ID not set", file=sys.stderr)
        return 2
    files = _candidates()
    total = sum(sz for _,sz,_ in files)
    print(f"Found {len(files)} files, total ~ {_human(total)}")
    if DRY_RUN or not files:
        for p,sz,_ in files[:50]:
            print(f" - {p} ({_human(sz)})")
        return 0
    with httpx.Client(timeout=120.0) as http:
        topic_id = _ensure_topic(http, TOPIC_NAME)
        sent = 0
        for path, size, _ in files:
            name = os.path.basename(path)
            cap = f"cache dump: <code>{html.escape(path)}</code>  ({size//1024} KB)"
            for attempt in range(5):
                try:
                    with open(path, "rb") as f:
                        r = http.post(
                            f"https://api.telegram.org/bot{BOT_TOKEN}/sendDocument",
                            data={
                                "chat_id": CHAT_ID,
                                "message_thread_id": topic_id,
                                "caption": cap,
                                "parse_mode": "HTML",
                                "disable_notification": SILENT,
                            },
                            files={"document": (name, f)},
                        )
                    if r.status_code == 429:
                        retry = int(r.json().get("parameters", {}).get("retry_after", 1))
                        time.sleep(retry + 0.5); continue
                    r.raise_for_status()
                    os.remove(path)
                    sent += 1
                    # лёгкий троттлинг
                    time.sleep(0.25)
                    break
                except Exception as e:
                    if attempt == 4:
                        print(f"FAIL: {path}: {e}", file=sys.stderr)
                    time.sleep(1.0)
        print(f"Sent {sent} files, freed ~ {_human(total)} (gross).")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
