-- 004_playlists.sql
-- Плейлисты пользователей + миграция favorites_old (если есть) + совместимость через VIEW favorites

BEGIN;

-- 0) UUID (на всякий случай)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1) Таблица плейлистов
CREATE TABLE IF NOT EXISTS public.playlists (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    bigint      NOT NULL,                      -- users.telegram_id
  title      text        NOT NULL,
  kind       text        NOT NULL DEFAULT 'custom',     -- 'custom' | 'system'
  is_public  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playlists_user_title_uniq UNIQUE (user_id, title)
);

-- FK на users(telegram_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema='public'
      AND table_name='playlists'
      AND constraint_name='playlists_user_fk'
  ) THEN
    ALTER TABLE public.playlists
      ADD CONSTRAINT playlists_user_fk
      FOREIGN KEY (user_id) REFERENCES public.users(telegram_id) ON DELETE CASCADE;
  END IF;
END$$;

-- Индексы
CREATE INDEX IF NOT EXISTS playlists_user_created_idx ON public.playlists (user_id, created_at);
CREATE INDEX IF NOT EXISTS playlists_user_updated_idx ON public.playlists (user_id, updated_at);

-- 2) Таблица элементов плейлистов
CREATE TABLE IF NOT EXISTS public.playlist_items (
  playlist_id uuid        NOT NULL REFERENCES public.playlists(id) ON DELETE CASCADE,
  track_id    uuid        NOT NULL REFERENCES public.tracks(id)    ON DELETE CASCADE,
  position    integer     NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, track_id)
);

CREATE INDEX IF NOT EXISTS playlist_items_playlist_pos_idx ON public.playlist_items (playlist_id, position);
CREATE INDEX IF NOT EXISTS playlist_items_playlist_added_idx ON public.playlist_items (playlist_id, added_at DESC);

-- 2.1) BEFORE INSERT: если position не задан — ставим (max(position)+1)
CREATE OR REPLACE FUNCTION public.fn_playlist_items_set_position()
RETURNS trigger AS $$
BEGIN
  IF NEW.position IS NULL OR NEW.position < 1 THEN
    SELECT COALESCE(MAX(position), 0) + 1 INTO NEW.position
    FROM public.playlist_items
    WHERE playlist_id = NEW.playlist_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_position ON public.playlist_items;
CREATE TRIGGER trg_set_position
BEFORE INSERT ON public.playlist_items
FOR EACH ROW EXECUTE FUNCTION public.fn_playlist_items_set_position();

-- 2.2) AFTER INSERT/DELETE: трогаем updated_at плейлиста
CREATE OR REPLACE FUNCTION public.fn_playlist_touch_updated()
RETURNS trigger AS $$
BEGIN
  UPDATE public.playlists
     SET updated_at = now()
   WHERE id = COALESCE(NEW.playlist_id, OLD.playlist_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_playlist ON public.playlist_items;
CREATE TRIGGER trg_touch_playlist
AFTER INSERT OR DELETE ON public.playlist_items
FOR EACH ROW EXECUTE FUNCTION public.fn_playlist_touch_updated();

-- 3) AFTER INSERT ON users: гарантируем «Мой плейлист»
CREATE OR REPLACE FUNCTION public.ensure_default_playlist_on_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.playlists (user_id, title, kind, is_public, handle)
  VALUES (NEW.telegram_id, 'Мой плейлист', 'system', false, NULL)
  ON CONFLICT (user_id, title) DO UPDATE
    SET kind = 'system',
        is_public = false,
        handle = NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_default_playlist ON public.users;
CREATE TRIGGER trg_users_default_playlist
AFTER INSERT ON public.users
FOR EACH ROW EXECUTE FUNCTION public.ensure_default_playlist_on_user();

-- 4) Разовая миграция из favorites_old -> плейлисты (если favorites_old существует и есть данные)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='favorites_old') THEN
    -- Гарантируем «Мой плейлист» для всех, кто есть в favorites_old
    INSERT INTO public.playlists (user_id, title, kind, is_public, handle)
    SELECT DISTINCT f.user_id, 'Мой плейлист', 'system', false, NULL
    FROM public.favorites_old f
    ON CONFLICT (user_id, title) DO NOTHING;

    -- Перенос элементов в playlist_items
    WITH p AS (
      SELECT id, user_id
      FROM public.playlists
      WHERE lower(title)=lower('Мой плейлист')
    )
    INSERT INTO public.playlist_items (playlist_id, track_id, position, added_at)
    SELECT p.id,
           f.track_id,
           ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY COALESCE(f.created_at, f.ts, now()), f.track_id),
           COALESCE(f.created_at, f.ts, now())
    FROM public.favorites_old f
    JOIN p ON p.user_id = f.user_id
    ON CONFLICT (playlist_id, track_id) DO NOTHING;
  END IF;
END$$;

-- 5) View favorites для обратной совместимости (READ-ONLY)
-- если есть настоящая таблица favorites (а не view), переименуем её в favorites_old,
-- но только если ещё нет favorites_old (чтобы не затирать)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='favorites')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='favorites_old') THEN
    ALTER TABLE public.favorites RENAME TO favorites_old;
  END IF;
END$$;

-- создаём совместимую вьюху
CREATE OR REPLACE VIEW public.favorites AS
SELECT
  p.user_id                          AS user_id,
  i.track_id                         AS track_id,
  i.added_at                         AS created_at,
  i.added_at                         AS ts
FROM public.playlist_items i
JOIN public.playlists p ON p.id = i.playlist_id
WHERE lower(p.title) = lower('Мой плейлист');

COMMIT;