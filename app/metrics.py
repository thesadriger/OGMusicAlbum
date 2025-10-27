# app/metrics.py
import os
import time
import threading
from collections import deque
from typing import Deque, Tuple

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from prometheus_client import (
    Counter,
    Histogram,
    Gauge,
    REGISTRY,
    CollectorRegistry,
    multiprocess,
    generate_latest,
    CONTENT_TYPE_LATEST,
)

# ---------- Multi-process aware registry ----------
def _get_registry():
    """
    Если PROMETHEUS_MULTIPROC_DIR установлен (uvicorn с несколькими воркерами),
    собираем сводку через CollectorRegistry + MultiProcessCollector.
    Иначе используем глобальный REGISTRY.
    """
    if os.getenv("PROMETHEUS_MULTIPROC_DIR"):
        reg = CollectorRegistry()
        multiprocess.MultiProcessCollector(reg)
        return reg
    return REGISTRY


# ---------- OGMA metrics ----------
REQ_TOTAL = Counter(
    "ogma_http_requests_total",
    "Total HTTP requests",
    ["method", "path", "status"],
)

REQ_DURATION = Histogram(
    "ogma_http_request_duration_seconds",
    "Request duration (seconds)",
    ["path"],
    buckets=(0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0),
)

ERRORS_TOTAL = Counter(
    "ogma_http_errors_total",
    "HTTP errors (4xx/5xx)",
    ["path", "status"],
)

ACTIVE_USERS = Gauge(
    "ogma_active_users",
    "Active users in the last N minutes",
    ["window"],  # используем label window="5m"
)

# Опционально — учёт объёма стриминга (можешь лейбелы поменять под себя)
STREAM_BYTES = Counter(
    "ogma_stream_bytes_total",
    "Bytes streamed to clients",
    ["stream_id"],
)


# ---------- Helpers ----------
def _normalize_path(raw: str) -> str:
    """
    Обрезаем query и оставляем первые 1–2 сегмента пути,
    чтобы агрегировать похожие эндпоинты.
    """
    path = raw.split("?", 1)[0]
    if not path or path == "/":
        return "/"
    parts = [p for p in path.split("/") if p]
    # например: /api/search/tracks -> /api/search
    if len(parts) >= 2:
        return f"/{parts[0]}/{parts[1]}"
    return f"/{parts[0]}"


class PromMetricsMiddleware(BaseHTTPMiddleware):
    """
    - Считает REQ_TOTAL, REQ_DURATION, ERRORS_TOTAL
    - Поддерживает оценку активных пользователей за окно (по X-User-Id или IP)
    """

    def __init__(self, app, active_window_seconds: int = 300):
        super().__init__(app)
        self.window = active_window_seconds
        self._visits: Deque[Tuple[float, str]] = deque()
        self._lock = threading.Lock()
        self._cleaner_started = False

    def _ensure_cleaner(self):
        if self._cleaner_started:
            return
        self._cleaner_started = True

        def cleaner():
            while True:
                cutoff = time.time() - self.window
                with self._lock:
                    while self._visits and self._visits[0][0] < cutoff:
                        self._visits.popleft()
                    # точное количество уникальных пользователей в окне
                    current = len({uid for _, uid in self._visits})
                    ACTIVE_USERS.labels(window="5m").set(current)
                time.sleep(5)

        t = threading.Thread(target=cleaner, daemon=True)
        t.start()

    async def dispatch(self, request: Request, call_next):
        self._ensure_cleaner()

        method = request.method.upper()
        path = _normalize_path(request.url.path)
        user_id = request.headers.get("X-User-Id") or (request.client.host if request.client else "unknown")

        start = time.perf_counter()
        status = "500"
        try:
            response: Response = await call_next(request)
            status = str(response.status_code)
            return response
        finally:
            dur = time.perf_counter() - start
            REQ_TOTAL.labels(method=method, path=path, status=status).inc()
            REQ_DURATION.labels(path=path).observe(dur)
            if status.startswith(("4", "5")):
                ERRORS_TOTAL.labels(path=path, status=status).inc()

            now = time.time()
            with self._lock:
                self._visits.append((now, str(user_id)))


def setup_metrics(app) -> None:
    """
    Подключает middleware и регистрирует /metrics.
    Вызови из main.py сразу после создания FastAPI():
        from app.metrics import setup_metrics
        app = FastAPI(...)
        setup_metrics(app)
    """
    # Middleware — первым, чтобы захватывать всё
    app.add_middleware(PromMetricsMiddleware)

    registry = _get_registry()

    async def metrics_endpoint(_request: Request):
        # generate_latest сам соберёт multiprocess-метрики, если registry корректный
        data = generate_latest(registry)
        return Response(content=data, media_type=CONTENT_TYPE_LATEST)

    # скрываем из OpenAPI/Swagger
    app.add_api_route("/metrics", metrics_endpoint, include_in_schema=False)