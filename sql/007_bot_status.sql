CREATE TABLE IF NOT EXISTS public.bot_status (
  id               int          PRIMARY KEY DEFAULT 1,
  last_update_ts   timestamptz  NOT NULL    DEFAULT now(),
  last_error       text         NULL
);

COMMENT ON TABLE  public.bot_status IS 'Live status (heartbeat) of Telegram bot';
COMMENT ON COLUMN public.bot_status.last_update_ts IS 'Timestamp of the latest successful update/heartbeat';
COMMENT ON COLUMN public.bot_status.last_error IS 'Last error if any; NULL on healthy heartbeat';

CREATE INDEX IF NOT EXISTS bot_status_last_update_idx
  ON public.bot_status (last_update_ts DESC);