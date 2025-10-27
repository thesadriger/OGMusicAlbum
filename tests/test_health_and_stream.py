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
