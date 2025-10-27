import os, requests, pytest
BASE = os.environ.get('BASE', 'http://127.0.0.1:5190')

def test_health_ok():
    r = requests.get(f'{BASE}/api/health', timeout=5)
    assert r.status_code == 200
    js = r.json()
    assert 'postgres' in js and 'meili' in js

@pytest.mark.skipif(not os.environ.get('TEST_STREAM_ID'), reason='no TEST_STREAM_ID set')
def test_range_exact_1024():
    sid = os.environ['TEST_STREAM_ID']
    r = requests.get(f'{BASE}/api/stream/{sid}', headers={'Range':'bytes=0-1023'}, timeout=30)
    assert r.status_code == 206
    cl = int(r.headers['Content-Length']); assert cl == 1024
    assert len(r.content) == 1024

@pytest.mark.skipif(not os.environ.get('TEST_STREAM_ID'), reason='no TEST_STREAM_ID set')
def test_range_middle_4k():
    sid = os.environ['TEST_STREAM_ID']
    r = requests.get(f'{BASE}/api/stream/{sid}', headers={'Range':'bytes=1048576-1052671'}, timeout=60)
    assert r.status_code == 206
    cl = int(r.headers['Content-Length']); assert cl == 4096
    assert len(r.content) == 4096
