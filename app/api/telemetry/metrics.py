from __future__ import annotations

from prometheus_client import Counter, Gauge, REGISTRY

# -------- helper: idempotent get-or-create -----------------------------------
def _get_or_create(metric_cls, name: str, documentation: str, labelnames=(), **kwargs):
    """
    Возвращает уже зарегистрированную метрику (если есть), иначе создаёт новую.
    Это спасает от падений при двойном импорте/горячих рестартах.
    """
    try:
        if "registry" not in kwargs:
            kwargs["registry"] = REGISTRY
        return metric_cls(name, documentation, labelnames, **kwargs)
    except ValueError:
        # метрика уже была зарегистрирована — вернуть существующий инстанс
        return REGISTRY._names_to_collectors[name]

# -------- business metrics ----------------------------------------------------
# Visits + Active users
VISITS_TOTAL = _get_or_create(
    Counter, "ogma_visits_by_source_user_total", "Visits by source and user", ["source", "user"]
)
# «поджечь» серию, чтобы она появилась в /metrics сразу после старта
try:
    VISITS_TOTAL.labels(source="init", user="init").inc(0)
except Exception:
    pass

USERS_ACTIVE = _get_or_create(
    Gauge, "ogma_users_active", "Active users (set from app)", ["source"]
)

# Search / Stream / Download
SEARCH_REQUESTS_TOTAL = _get_or_create(
    Counter, "ogma_search_requests_total", "Search requests", ["user"]
)
STREAM_BYTES_TOTAL = _get_or_create(
    Counter, "ogma_stream_bytes_total", "Streamed bytes", ["chat_id"]
)
DOWNLOAD_BYTES_TOTAL = _get_or_create(
    Counter, "ogma_download_bytes_total", "Downloaded bytes", ["user", "resource"]
)

# Errors
ERRORS_TOTAL = _get_or_create(
    Counter, "ogma_errors_total", "HTTP errors total", ["path", "status_code"]
)

# -------- convenience API -----------------------------------------------------
def mark_visit(source: str = "web", user: str = "anon") -> None:
    """
    Инкрементирует ogma_visits_total независимо от фактической схемы меток
    у уже зарегистрированного счётчика (избегаем ValueError: Incorrect label names).
    """
    try:
        names = tuple(getattr(VISITS_TOTAL, "_labelnames", ()))
        if not names:
            # счётчик без меток
            VISITS_TOTAL.inc()
            return

        # ожидаемая схема
        if set(names) == {"source", "user"} and len(names) == 2:
            VISITS_TOTAL.labels(source=source, user=user).inc()
            return

        # любая другая схема — заполним детерминистически
        values = []
        for n in names:
            if n == "source":
                values.append(source)
            elif n == "user":
                values.append(user)
            else:
                values.append("n/a")
        VISITS_TOTAL.labels(*values).inc()
    except Exception:
        # метрики не должны ломать обработку запросов
        pass


def set_active_users(source: str, count: int) -> None:
    try:
        USERS_ACTIVE.labels(source=source).set(count)
    except Exception:
        pass


def inc_search(user: str = "anon") -> None:
    try:
        SEARCH_REQUESTS_TOTAL.labels(user=user).inc()
    except Exception:
        pass


def add_stream_bytes(chat_id: str, n_bytes: int) -> None:
    if n_bytes > 0:
        try:
            STREAM_BYTES_TOTAL.labels(chat_id=chat_id).inc(n_bytes)
        except Exception:
            pass


def add_download_bytes(user: str, resource: str, n_bytes: int) -> None:
    if n_bytes > 0:
        try:
            DOWNLOAD_BYTES_TOTAL.labels(user=user, resource=resource).inc(n_bytes)
        except Exception:
            pass


def mark_error(path: str, status_code: int) -> None:
    try:
        ERRORS_TOTAL.labels(path=path, status_code=str(status_code)).inc()
    except Exception:
        pass