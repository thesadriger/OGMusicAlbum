import os, requests

BASE = os.environ.get('BASE', 'http://127.0.0.1:5190')
def test_health_ok():
    r = requests.get(f'{BASE}/api/health', timeout=5)
    assert r.status_code == 200
    js = r.json()
    assert 'postgres' in js and 'meili' in js

def test_stream_range_smoke():
    sid = os.environ.get('TEST_STREAM_ID')
    if not sid:
        import pytest; pytest.skip('no TEST_STREAM_ID set')
    headers = {'Range': 'bytes=0-1023'}
    r = requests.get(f'{BASE}/api/stream/{sid}', headers=headers, timeout=15)
    assert r.status_code in (200, 206)
    if r.status_code == 206:
        cr = r.headers.get('Content-Range'); cl = r.headers.get('Content-Length')
        assert cr and cr.lower().startswith('bytes ')
        assert cl and int(cl) == 1024
        assert len(r.content) == 1024


def test_search_public_playlists():
    query = os.environ.get('TEST_PUBLIC_PLAYLIST_QUERY') or os.environ.get('TEST_PUBLIC_PLAYLIST_HANDLE')
    if not query:
        import pytest; pytest.skip('no TEST_PUBLIC_PLAYLIST_QUERY/TEST_PUBLIC_PLAYLIST_HANDLE set')

    r = requests.get(f'{BASE}/api/search', params={'q': query}, timeout=10)
    assert r.status_code == 200
    js = r.json()
    assert 'playlists' in js

    playlists = js['playlists']
    assert isinstance(playlists, dict)
    hits = playlists.get('hits') or []
    assert isinstance(hits, list)

    # Все найденные записи должны быть публичными
    assert all(item.get('isPublic') is True for item in hits)

    expected_handle = os.environ.get('TEST_PUBLIC_PLAYLIST_HANDLE')
    if expected_handle:
        norm = expected_handle.lstrip('@').lower()
        assert any((item.get('handle') or '').lower() == norm for item in hits)
