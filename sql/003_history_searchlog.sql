-- enum на всякий случай
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_action') THEN
    CREATE TYPE user_action AS ENUM ('play','search','save');
  END IF;
END$$;

-- история уже есть, просто добавим поле q для 'search' (если нет)
ALTER TABLE history ADD COLUMN IF NOT EXISTS q text;

-- лог текстов поисков (для аналитики/рекомендаций)
CREATE TABLE IF NOT EXISTS search_log (
  user_id   bigint REFERENCES users(telegram_id) ON DELETE CASCADE,
  q         text NOT NULL,
  ts        timestamptz NOT NULL DEFAULT now()
);

-- индексы
CREATE INDEX IF NOT EXISTS history_user_ts_idx ON history(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS search_log_user_ts_idx ON search_log(user_id, ts DESC);
