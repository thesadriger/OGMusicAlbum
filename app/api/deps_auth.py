# app/api/deps_auth.py
from typing import Optional
from fastapi import Header, HTTPException, Request
from .auth_webapp import verify_init_data  # из твоего файла

async def get_current_user(
    request: Request,
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
    x_tg_init: Optional[str] = Header(None, alias="X-Telegram-Init-Data"),
) -> int:
    # 1) DEV/прокси: X-User-Id
    if x_user_id:
        try:
            return int(x_user_id)
        except ValueError:
            pass

    # 2) WebApp: X-Telegram-Init-Data (или тот же заголовок от <audio/>)
    if x_tg_init:
        user = verify_init_data(x_tg_init, max_age_sec=24 * 3600)
        return int(user["id"])

    # 3) (опционально) cookie ogma_sid — если у тебя есть привязка sid→user, добавь тут.

    raise HTTPException(status_code=401, detail="No auth")