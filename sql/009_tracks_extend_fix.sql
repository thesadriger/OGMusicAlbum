-- 009_tracks_extend_fix.sql
-- Приводим public.tracks к схеме, ожидаемой индексатором Telegram.

BEGIN;

-- 1) Новые колонки, которых нет в действующей таблице
ALTER TABLE IF EXISTS public.tracks
    ADD COLUMN IF NOT EXISTS caption       text,
    ADD COLUMN IF NOT EXISTS doc_id        bigint,
    ADD COLUMN IF NOT EXISTS access_hash   bigint,
    ADD COLUMN IF NOT EXISTS file_ref_b64  text,
    ADD COLUMN IF NOT EXISTS dc_id         integer;

-- 2) Приводим artists/hashtags к массивам text[]
--    Конвертер переносит:
--      - NULL/'' -> NULL
--      - уже-массивный литерал вида {a,b} -> ::text[]
--      - иначе пытаемся разделить по запятой
DO $$
BEGIN
    -- artists -> text[]
    BEGIN
        ALTER TABLE public.tracks
            ALTER COLUMN artists TYPE text[]
            USING (
                CASE
                    WHEN artists IS NULL OR artists = '' THEN NULL
                    WHEN artists ~ '^\{.*\}$' THEN artists::text[]
                    ELSE string_to_array(artists, ',')
                END
            );
    EXCEPTION WHEN datatype_mismatch OR invalid_text_representation THEN
        RAISE NOTICE 'artists: unable to convert some rows automatically; leaving type as is';
    END;

    -- hashtags -> text[]
    BEGIN
        ALTER TABLE public.tracks
            ALTER COLUMN hashtags TYPE text[]
            USING (
                CASE
                    WHEN hashtags IS NULL OR hashtags = '' THEN NULL
                    WHEN hashtags ~ '^\{.*\}$' THEN hashtags::text[]
                    ELSE string_to_array(hashtags, ',')
                END
            );
    EXCEPTION WHEN datatype_mismatch OR invalid_text_representation THEN
        RAISE NOTICE 'hashtags: unable to convert some rows automatically; leaving type as is';
    END;
END$$;

-- 3) Уникальность (chat_username, tg_msg_id) под ON CONFLICT
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tracks_chat_msg_unique'
          AND conrelid = 'public.tracks'::regclass
    ) THEN
        ALTER TABLE public.tracks
            ADD CONSTRAINT tracks_chat_msg_unique
            UNIQUE (chat_username, tg_msg_id);
    END IF;
END$$;

-- 4) Индексы, которые реально нужны
-- 4.1) По источнику/ид сообщения
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_chat_msg') THEN
        CREATE INDEX idx_tracks_chat_msg
            ON public.tracks (chat_username, tg_msg_id);
    END IF;
END$$;

-- 4.2) created_at (у тебя он есть) — для свежих выборок
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_created_at') THEN
        CREATE INDEX idx_tracks_created_at ON public.tracks (created_at DESC);
    END IF;
END$$;

-- 4.3) GIN по массивам (artists[], hashtags[]) и trigram для text-полей
--      Для trigram нужен pg_trgm.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Если колонки действительно text[] (как ожидается) — ставим GIN array_ops.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tracks'
          AND column_name = 'artists' AND udt_name = '_text'
    ) THEN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_artists_gin') THEN
            CREATE INDEX idx_tracks_artists_gin ON public.tracks USING gin (artists);
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tracks'
          AND column_name = 'hashtags' AND udt_name = '_text'
    ) THEN
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_hashtags_gin') THEN
            CREATE INDEX idx_tracks_hashtags_gin ON public.tracks USING gin (hashtags);
        END IF;
    END IF;
END$$;

-- 4.4) Для полнотекстового/подстрочного поиска по text-полям — trigram (gin_trgm_ops)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_title_trgm') THEN
        CREATE INDEX idx_tracks_title_trgm ON public.tracks USING gin (title gin_trgm_ops);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_caption_trgm') THEN
        CREATE INDEX idx_tracks_caption_trgm ON public.tracks USING gin (caption gin_trgm_ops);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_mime_btree') THEN
        CREATE INDEX idx_tracks_mime_btree ON public.tracks (mime);
    END IF;
END$$;

COMMIT;