"""Shared helpers for resolving the acting user from an incoming FastAPI request.
Every step is explicitly documented so fellow developers immediately see why
it exists and how the control flow moves from one branch to another."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
from typing import Optional

from fastapi import Request

# --- Configuration -----------------------------------------------------------------
# Dedicated knobs are kept at module level, making it effortless to reuse the logic
# from both HTTP APIs and streaming gateways without creating import cycles.
_JWT_SECRET = os.environ.get("API_JWT_SECRET") or ""
_BOT_TOKEN = (
    os.environ.get("TELEGRAM_BOT_TOKEN")
    or os.environ.get("BOT_TOKEN")
    or ""
)
_DEBUG_ALLOWED = (os.environ.get("ALLOW_DEBUG_HEADERS") or "").lower() in {"1", "true", "yes", "on"}


def _parse_jwt_hs256(token: str) -> Optional[dict]:
    """Parse a HS256 JWT string. Returns payload when signature matches."""
    try:
        head_b64, payload_b64, sig_b64 = token.split(".")
    except ValueError:
        return None

    try:
        header = json.loads(base64.urlsafe_b64decode(head_b64 + "=" * (-len(head_b64) % 4)))
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
    except Exception:
        return None

    if not isinstance(header, dict) or header.get("alg") != "HS256":
        return None

    mac = hmac.new(_JWT_SECRET.encode(), msg=f"{head_b64}.{payload_b64}".encode(), digestmod=hashlib.sha256).digest()
    expected = base64.urlsafe_b64encode(mac).rstrip(b"=").decode()
    if not hmac.compare_digest(expected, sig_b64):
        return None

    exp = payload.get("exp")
    if isinstance(exp, (int, float)) and time.time() > float(exp):
        return None

    return payload if isinstance(payload, dict) else None


def _extract_jwt_uid(token: Optional[str]) -> Optional[int]:
    """Pull uid/sub from JWT payload and convert to int when possible."""
    if not token or not _JWT_SECRET:
        return None
    payload = _parse_jwt_hs256(token)
    if not payload:
        return None
    candidate = payload.get("uid") or payload.get("sub")
    if isinstance(candidate, int):
        return candidate
    if isinstance(candidate, str) and candidate.isdigit():
        return int(candidate)
    return None


def _verify_tg_initdata(raw: Optional[str]) -> Optional[int]:
    """Validate Telegram initData and return Telegram user id when possible."""
    if not raw or not _BOT_TOKEN:
        return None

    params = urllib.parse.parse_qs(raw, keep_blank_values=True)
    single = {k: v[-1] for k, v in params.items()}
    given_hash = single.pop("hash", None)
    if not given_hash:
        return None

    data_check_string = "\n".join(f"{k}={single[k]}" for k in sorted(single))
    secret = hmac.new(b"WebAppData", _BOT_TOKEN.encode(), hashlib.sha256).digest()
    mac = hmac.new(secret, msg=data_check_string.encode(), digestmod=hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, given_hash):
        return None

    auth_date = single.get("auth_date")
    if auth_date and auth_date.isdigit():
        ts = int(auth_date)
        if ts < time.time() - 24 * 3600:
            return None

    try:
        user_blob = json.loads(single.get("user", "{}"))
    except Exception:
        user_blob = {}

    if isinstance(user_blob, dict):
        cand = user_blob.get("id")
        if isinstance(cand, int):
            return cand
        if isinstance(cand, str) and cand.isdigit():
            return int(cand)
    return None


def _looks_like_localhost(request: Request) -> bool:
    """Cheap heuristic: treat loopback connections as safe for debug headers."""
    client = request.client
    host = (client.host if client else "") or ""
    host = host.split("%")[0]
    return host in {"127.0.0.1", "::1", "localhost"}


def resolve_user_id(request: Request) -> Optional[int]:
    """Return telegram/user id for the incoming request or ``None`` if absent."""
    # 1) Explicit service headers always win because other routers already use them.
    x_uid = request.headers.get("x-user-id")
    if x_uid and x_uid.isdigit():
        return int(x_uid)

    # 2) Bearer tokens (API JWT) behave the same way as in playlist APIs.
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        uid = _extract_jwt_uid(auth.split(None, 1)[1].strip())
        if uid is not None:
            return uid

    # 3) Signed cookies reuse the same JWT parser, so mini-app and SPA share state.
    cookie = request.cookies.get("ogma_session")
    uid = _extract_jwt_uid(cookie)
    if uid is not None:
        return uid

    # 4) Telegram WebApp init data (header or query parameter) → verifies signature.
    init_data = request.headers.get("x-telegram-init-data") or request.query_params.get("init")
    uid = _verify_tg_initdata(init_data)
    if uid is not None:
        return uid

    # 5) Developer shortcut: honor explicit debug id locally or when enabled via env.
    debug_id = request.headers.get("x-debug-user-id")
    if debug_id and debug_id.isdigit() and (_DEBUG_ALLOWED or _looks_like_localhost(request)):
        return int(debug_id)

    return None


__all__ = ["resolve_user_id"]
