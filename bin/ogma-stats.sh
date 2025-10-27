#!/usr/bin/env bash
set -euo pipefail
: "${PGPASSWORD:=ogma_pass}"
psql_ogma() { psql -h 127.0.0.1 -U ogma -d ogma -v ON_ERROR_STOP=1 "$@"; }

case "${1:-top}" in
  top)
    psql_ogma -c "
      SELECT u.telegram_id AS user_id, COALESCE(u.username,'—') AS username,
             NULLIF(u.name,'') AS name,
             COUNT(*) AS plays, COUNT(DISTINCT h.track_id) AS unique_tracks, MAX(h.ts) AS last_play
      FROM users u JOIN history h ON h.user_id=u.telegram_id AND h.action='play'
      GROUP BY u.telegram_id, u.username, u.name
      ORDER BY last_play DESC
      LIMIT 50;"
    ;;
  last24)
    psql_ogma -c "
      SELECT u.telegram_id AS user_id, COALESCE(u.username,'—') AS username,
             NULLIF(u.name,'') AS name,
             COUNT(*) AS plays_24h, MAX(h.ts) AS last_play
      FROM users u JOIN history h ON h.user_id=u.telegram_id AND h.action='play'
      WHERE h.ts >= NOW() - INTERVAL '24 hours'
      GROUP BY u.telegram_id, u.username, u.name
      ORDER BY last_play DESC;"
    ;;
  recent)
    psql_ogma -c "
      SELECT h.ts AS played_at, h.user_id AS telegram_id,
             COALESCE(u.username,'—') AS username, NULLIF(u.name,'') AS name, h.track_id
      FROM history h LEFT JOIN users u ON u.telegram_id=h.user_id
      WHERE h.action='play'
      ORDER BY h.ts DESC
      LIMIT 50;"
    ;;
  uniq)
    psql_ogma -c "
      SELECT COUNT(DISTINCT h.user_id) AS unique_listeners
      FROM history h JOIN users u ON u.telegram_id=h.user_id
      WHERE h.action='play';"
    ;;
  export)
    OUT=${2:-/tmp/listeners.csv}
    psql_ogma -c "\copy (
      SELECT u.telegram_id AS user_id, COALESCE(u.username,'—') AS username,
             NULLIF(u.name,'') AS name,
             COUNT(*) AS plays, COUNT(DISTINCT h.track_id) AS unique_tracks, MAX(h.ts) AS last_play
      FROM users u JOIN history h ON h.user_id=u.telegram_id AND h.action='play'
      GROUP BY u.telegram_id, u.username, u.name
      ORDER BY last_play DESC
    ) TO '${OUT}' CSV HEADER"
    echo "CSV: ${OUT}"
    ;;
  *)
    echo "Usage: $0 {top|last24|recent|uniq|export [/path/file.csv]}" >&2
    exit 1
    ;;
esac
