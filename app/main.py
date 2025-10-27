from fastapi import FastAPI
from app.metrics import setup_metrics
# app/main.py
import os, time, asyncpg, asyncio
from fastapi import FastAPI
from starlette.responses import JSONResponse
from prometheus_fastapi_instrumentator import Instrumentator
from prometheus_client import Counter, Gauge

from app.api import playlists
from app.api.users import _get_pool
from app.api.telegram_logger import TelegramHandler

app = FastAPI()


# --- OGMA metrics ---
setup_metrics(app)
# --- OGMA metrics ---
setup_metrics(app)
app.include_router(playlists.router, prefix="/api")

PG_DSN = os.getenv("PG_DSN", "postgresql://ogma:ogma@127.0.0.1:5433/ogma")

# === ВАЖНО: инициализируем Prometheus middleware ЗДЕСЬ ===
Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)

# --- Prometheus кастомные ---
REQUESTS_TOTAL = Counter("ogma_requests_total", "Total API requests", ["path", "method", "status"])
DB_POOL_SIZE   = Gauge("ogma_db_pool_size", "asyncpg pool size")
DB_POOL_USED   = Gauge("ogma_db_pool_used", "asyncpg pool used")
START_TS = time.time()
UPTIME_GAUGE   = Gauge("ogma_uptime_seconds", "Process uptime in seconds")

SEARCH_RPM = Gauge("ogma_search_rpm", "Search queries per minute")
NEW_PLAYLISTS_24H = Gauge("ogma_new_playlists_24h", "New playlists in last 24h")
INDEXER_LAG_MIN = Gauge("ogma_indexer_lag_min", "Indexer lag in minutes since last_ts")

async def _refresh_indexer_metrics(pool):
    async with pool.acquire() as con:
        row = await con.fetchrow("select last_ts from indexer_status where id=1")
        if row and row["last_ts"]:
            lag_min = max(0.0, (time.time() - row["last_ts"].timestamp()) / 60.0)
            INDEXER_LAG_MIN.set(lag_min)

async def _metrics_refresher():
    while True:
        try:
            pool = getattr(app.state, "pool", None)
            if pool:
                async with pool.acquire() as con:
                    rpm = await con.fetchval("""
                        select coalesce(count(*),0)::float
                        from search_log
                        where ts > now() - interval '1 minute'
                    """)
                    SEARCH_RPM.set(rpm or 0.0)

                    pl = await con.fetchval("""
                        select coalesce(count(*),0)::float
                        from playlists
                        where created_at > now() - interval '24 hours'
                    """)
                    NEW_PLAYLISTS_24H.set(pl or 0.0)

                # после агрегатов — обновляем лаг индексатора
                await _refresh_indexer_metrics(pool)
        except Exception:
            pass
        await asyncio.sleep(15)

@app.on_event("startup")
async def _start_metrics_task():
    app.state._m_task = asyncio.create_task(_metrics_refresher())

@app.on_event("shutdown")
async def _stop_metrics_task():
    t = getattr(app.state, "_m_task", None)
    if t:
        t.cancel()

@app.on_event("startup")
async def startup():
    # пул БД (с мягким retry, чтобы не падать при временном оффлайне БД)
    retries = int(os.getenv("PG_POOL_INIT_RETRIES", "10"))
    delay = float(os.getenv("PG_POOL_INIT_DELAY", "2.0"))
    for attempt in range(1, retries + 1):
        try:
            app.state.pool = await asyncpg.create_pool(PG_DSN, min_size=2, max_size=10, command_timeout=5)
            break
        except Exception:
            app.state.pool = None
            if attempt == retries:
                break
            await asyncio.sleep(delay)

    # Логгер в ТГ (по желанию — только в проде)
    chat_id = os.getenv("TELEGRAM_LOG_CHAT_ID")
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    if chat_id and bot_token:
        import logging
        h = TelegramHandler(bot_token=bot_token, chat_id=chat_id)
        h.setLevel(os.getenv("TELEGRAM_LOG_LEVEL", "WARNING"))
        logging.getLogger("uvicorn.error").addHandler(h)
        logging.getLogger("uvicorn.access").addHandler(h)
        logging.getLogger().addHandler(h)

@app.on_event("shutdown")
async def shutdown():
    pool = getattr(app.state, "pool", None)
    if pool:
        await pool.close()

@app.middleware("http")
async def metrics_middleware(request, call_next):
    resp = None
    try:
        resp = await call_next(request)
        return resp
    finally:
        path = request.url.path
        method = request.method
        status = getattr(resp, "status_code", 500)
        REQUESTS_TOTAL.labels(path=path, method=method, status=status).inc()
        pool = getattr(app.state, "pool", None)
        if pool:
            try:
                DB_POOL_SIZE.set(pool._maxsize)
                used = sum(1 for h in pool._holders if h._in_use)
                DB_POOL_USED.set(used)
            except Exception:
                pass
        UPTIME_GAUGE.set(time.time() - START_TS)

# Health endpoints
@app.get("/health/live")
async def live():
    return JSONResponse({"status": "ok", "uptime_sec": int(time.time() - START_TS)})

@app.get("/health/ready")
async def ready():
    # Берём пул напрямую из app.state
    pool = getattr(app.state, "pool", None)
    if not pool:
        return JSONResponse({"status": "degraded", "error": "db pool not initialized"}, status_code=503)

    try:
        async with pool.acquire() as con:
            await con.fetchval("SELECT 1")
        return JSONResponse({"status": "ok"})
    except Exception as e:
        return JSONResponse({"status": "degraded", "error": str(e)}, status_code=503)
