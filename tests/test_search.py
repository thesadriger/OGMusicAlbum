from __future__ import annotations

from pathlib import Path
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.api import search as search_module


class _FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeConnection:
    def __init__(self, rows: list[dict]):
        self._rows = rows

    async def execute(self, *_args, **_kwargs):
        return None

    async def fetch(self, *_args, **_kwargs):
        return self._rows

    def transaction(self):
        return _FakeTransaction()


class _AcquireCtx:
    def __init__(self, connection: _FakeConnection):
        self._connection = connection

    async def __aenter__(self):
        return self._connection

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakePool:
    def __init__(self, rows: list[dict]):
        self._connection = _FakeConnection(rows)

    def acquire(self):
        return _AcquireCtx(self._connection)


def test_search_fallback_sets_cache_headers():
    search_module._cache.clear()

    fake_rows = [
        {
            "id": "1",
            "msgId": 123,
            "chat": "ogma",
            "title": "Song",
            "artists": ["Artist"],
            "hashtags": ["#tag"],
            "duration": 200,
            "mime": "audio/mpeg",
            "created_at": "2024-01-01T00:00:00Z",
        }
    ]

    app = FastAPI()
    app.include_router(search_module.router, prefix="/api")
    app.state.pool = _FakePool(fake_rows)

    client = TestClient(app)

    response = client.get("/api/search", params={"q": "Song"})

    assert response.status_code == 200
    assert response.headers.get("Cache-Control") == f"public, max-age={search_module.SEARCH_TTL}"
    assert response.headers.get("Vary") == "Accept-Encoding"

    payload = response.json()
    assert payload["hits"] == fake_rows
    assert payload["limit"] == 20
    assert payload["offset"] == 0
    assert payload["estimatedTotalHits"] is None
