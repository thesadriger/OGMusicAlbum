#!/usr/bin/env bash
set -euo pipefail
sudo systemctl restart ogma-api
sleep 1
curl -sS --max-time 3 http://127.0.0.1:8080/api/health || true
# убираем возможные зависания Vite на порт 5173
sudo fuser -k 5173/tcp 2>/dev/null || true
npm run dev -- --host 0.0.0.0 --port 5173 >/tmp/vite.log 2>&1 &
sleep 2
echo "---- Vite ----"; sed -n '1,30p' /tmp/vite.log
