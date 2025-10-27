from fastapi import APIRouter
router = APIRouter()

@router.get("/health")
async def health():
    # Лёгкий, моментальный ответ для DEV
    return {"ok": True}
