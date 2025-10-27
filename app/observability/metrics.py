import os, time, threading
from collections import deque
from typing import Deque, Tuple, Optional

from prometheus_client import (
    Counter, Histogram, Gauge, CollectorRegistry, CONTENT_TYPE_LATEST, generate_latest,
)
from prometheus_client import multiprocess, PROCESS_COLLECTOR, PLATFORM_COLLECTOR, GC_COLLECTOR
from starlette.responses import Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.applications import Starlette

# --- Registry (multiprocess-aware)
if "PROMETHEUS_MULTIPROC_DIR" in os.environ:
    registry = CollectorRegistry()
if os.environ.get('PROMETHEUS_MULTIPROC_DIR'):
    multiprocess.MultiProcessCollector(registry)
else:
    registry = None  # default registry

# --- Metrics (use default registry so MultiProcessCollector соберёт их сам)
REQS = Counter(
    "ogma_http_requests_total", "HTTP requests",
    ["path", "method", "status"]
)
LAT = Histogram(
    "ogma_http_request_duration_seconds", "HTTP request duration",
    ["path", "method"],
    buckets=(0.05,0.1,0.2,0.3,0.5,0.75,1,1.5,2,3,5,8,13)
)
ERRS = Counter(
    "ogma_errors_total", "Unhandled exceptions",
    ["path","exc"]
)

VISITS = Counter(
    "ogma_visits_total", "User actions",
    ["kind"]  # visits/search/stream/download
)
STREAM_BYTES = Counter(
    "ogma_stream_bytes_total", "Stream bytes by chat",
    ["chat"]
)
ACTIVE = Gauge("ogma_active_users", "Active users in last 5 minutes")

# --- Active users: in-memory sliding window (user_id, ts)
_window: Deque[Tuple[str,float]] = deque()
_seen = set()
_window_seconds = 300

def _gc_window(now: float):
    while _window and now - _window[0][1] > _window_seconds:
        uid,_ts = _window.popleft()
        # возможно таких uid несколько в хвосте, чистим постепенно
        if uid not in (u for u,_ in _window):
            _seen.discard(uid)

def mark_user_active(user_id: Optional[str]):
    if not user_id:
        return
    now = time.time()
    _window.append((user_id, now))
    _seen.add(user_id)
    _gc_window(now)

def active_loop():
    while True:
        now = time.time()
        _gc_window(now)
        ACTIVE.set(len(_seen))
        time.sleep(5)

threading.Thread(target=active_loop, daemon=True).start()

# --- Helpers
def bucket_path(path: str) -> str:
    """
    Грубое бакетирование путей, чтобы не раздувать кардинальность:
    /api/search -> /search, /api/stream/{id} -> /stream, /download/{id} -> /download, etc.
    """
    p = path.lower()
    if "search" in p: return "/search"
    if "stream" in p or "play" in p: return "/stream"
    if "download" in p: return "/download"
    if "playlist" in p: return "/playlists"
    if "user" in p or "auth" in p: return "/users"
    return "/other"

# --- Middleware для таймингов и счётчиков
class PromHTTPMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        p = bucket_path(request.url.path)
        m = request.method.upper()
        uid = request.headers.get("X-User-Id") or request.headers.get("X-Forwarded-User") or request.headers.get("X-Telegram-User")
        mark_user_active(uid)

        start = time.perf_counter()
        try:
            resp = await call_next(request)
            status = str(resp.status_code)
        except Exception as e:
            status = "500"
            ERRS.labels(path=p, exc=type(e).__name__).inc()
            raise
        finally:
            dur = time.perf_counter() - start
            LAT.labels(path=p, method=m).observe(dur)
            REQS.labels(path=p, method=m, status=status).inc()
        return resp

# --- Экспозиция /metrics (Starlette app для монтирования)
metrics_app = Starlette()

@metrics_app.route("/metrics")
async def metrics(_request: Request):
    if registry is not None:
        return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

# --- Вспомогательные инкременты (вызывай из кода там, где нужно)
def visit(kind: str):
    # kind: visits|search|stream|download
    VISITS.labels(kind=kind).inc()

def add_stream_bytes(chat: str, nbytes: int):
    STREAM_BYTES.labels(chat=chat).inc(nbytes)
