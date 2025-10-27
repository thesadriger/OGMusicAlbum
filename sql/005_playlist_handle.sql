-- /home/ogma/ogma/sql/005_playlist_handle.sql  (FIX)
BEGIN;

-- 1) handle-колонка
ALTER TABLE public.playlists
  ADD COLUMN IF NOT EXISTS handle text;

-- 2) нормализация handle (@срезаем, trim, lower; пустые -> NULL)
CREATE OR REPLACE FUNCTION public.normalize_playlist_handle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.handle IS NOT NULL THEN
    NEW.handle := btrim(lower(regexp_replace(NEW.handle, '^\s*@', '', '')));
    IF NEW.handle = '' THEN
      NEW.handle := NULL;
    END IF;
  END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_normalize_playlist_handle ON public.playlists;
CREATE TRIGGER trg_normalize_playlist_handle
BEFORE INSERT OR UPDATE OF handle ON public.playlists
FOR EACH ROW EXECUTE FUNCTION public.normalize_playlist_handle();

-- 3) CHECK-валидация формата (через DO, т.к. IF NOT EXISTS у ADD CONSTRAINT нет)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'playlists_handle_valid'
      AND conrelid = 'public.playlists'::regclass
  ) THEN
    ALTER TABLE public.playlists
      ADD CONSTRAINT playlists_handle_valid
      CHECK (handle IS NULL OR handle ~ '^[a-z0-9_]{3,32}$');
  END IF;
END$$;

-- 4) Глобальная уникальность без учёта регистра
CREATE UNIQUE INDEX IF NOT EXISTS playlists_handle_unique_idx
  ON public.playlists ((lower(handle)));

-- 5) Ускорение prefix-поиска (опционально)
CREATE INDEX IF NOT EXISTS playlists_handle_like_idx
  ON public.playlists (handle text_pattern_ops);

COMMIT;