# /home/ogma/ogma/app/api/auth_webapp.py
import os, hmac, hashlib, time, urllib.parse, json
from fastapi import APIRouter, HTTPException, Response, Request
from pydantic import BaseModel

router = APIRouter()

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
ALLOW_DEBUG = os.environ.get("ALLOW_DEBUG_HEADERS", "0").lower() in {"1", "true", "yes"}
if not BOT_TOKEN and ALLOW_DEBUG:
    # dev-режим: не валим импорт; эндпоинт все равно не нужен вне Telegram
    BOT_TOKEN = "dev_dummy_token"
elif not BOT_TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN is not set for ogma-api")

def _secret_key() -> bytes:
    # Telegram WebApp: secret_key = HMAC_SHA256(key=BOT_TOKEN, msg="WebAppData")
    return hmac.new(BOT_TOKEN.encode(), b"WebAppData", hashlib.sha256).digest()

def verify_init_data(init_data: str, max_age_sec: int = 600):
    items = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
    given_hash = items.pop("hash", "")

    pairs = sorted(items.items(), key=lambda kv: kv[0])
    dcs = "\n".join(f"{k}={v}" for k, v in pairs)

    calc_hash = hmac.new(_secret_key(), dcs.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(given_hash, calc_hash):
        raise HTTPException(status_code=401, detail="Bad initData signature")

    auth_date = int(items.get("auth_date", "0") or 0)
    if auth_date and time.time() - auth_date > max_age_sec:
        raise HTTPException(status_code=401, detail="initData too old")

    user_json = items.get("user")
    user = json.loads(user_json) if user_json else None
    if not user or "id" not in user:
        raise HTTPException(status_code=400, detail="user payload missing")
    return user

async def _ensure_users_table(pool):
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS users (
          telegram_id  BIGINT PRIMARY KEY,
          username     TEXT,
          name         TEXT,
          photo_url    TEXT,
          is_premium   BOOLEAN,
          created_at   TIMESTAMPTZ DEFAULT now(),
          updated_at   TIMESTAMPTZ DEFAULT now()
        );
    """)

async def _upsert_user(pool, user: dict):
    tg_id = int(user["id"])
    username = user.get("username")
    first = user.get("first_name") or ""
    last = user.get("last_name") or ""
    name = (first + " " + last).strip() or None
    photo_url = user.get("photo_url")
    is_premium = user.get("is_premium", None)

    await pool.execute(
        """
        INSERT INTO users(telegram_id, username, name, photo_url, is_premium)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (telegram_id) DO UPDATE SET
            username   = EXCLUDED.username,
            name       = EXCLUDED.name,
            photo_url  = EXCLUDED.photo_url,
            is_premium = EXCLUDED.is_premium,
            updated_at = now();
        """,
        tg_id, username, name, photo_url, is_premium
    )

class InitDataIn(BaseModel):
    init_data: str

@router.post("/auth/webapp")
async def auth_webapp(body: InitDataIn, response: Response, request: Request):
    user = verify_init_data(body.init_data)

    pool = getattr(request.app.state, "pool", None)
    if pool:
        await _ensure_users_table(pool)
        await _upsert_user(pool, user)

    sid = hmac.new(_secret_key(), body.init_data.encode(), hashlib.sha256).hexdigest()[:32]
    response.set_cookie("ogma_sid", sid, httponly=True, max_age=600, samesite="Lax", path="/")

    return {"ok": True, "user": user}