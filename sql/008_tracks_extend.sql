-- 008_tracks_extend.sql
-- Расширение схемы tracks под индексатор Telegram

BEGIN;

-- Базовые столбцы под upsert (добавятся только если их ещё нет)
ALTER TABLE IF EXISTS public.tracks
    ADD COLUMN IF NOT EXISTS chat_username  text,
    ADD COLUMN IF NOT EXISTS tg_msg_id      bigint,
    ADD COLUMN IF NOT EXISTS title          text,
    ADD COLUMN IF NOT EXISTS artists        text[],
    ADD COLUMN IF NOT EXISTS hashtags       text[],
    ADD COLUMN IF NOT EXISTS duration_s     integer,
    ADD COLUMN IF NOT EXISTS mime           text,
    ADD COLUMN IF NOT EXISTS size_bytes     bigint,
    ADD COLUMN IF NOT EXISTS caption        text,
    ADD COLUMN IF NOT EXISTS doc_id         bigint,
    ADD COLUMN IF NOT EXISTS access_hash    bigint,
    ADD COLUMN IF NOT EXISTS file_ref_b64   text,
    ADD COLUMN IF NOT EXISTS dc_id          integer;

-- Уникальность сообщения в канале: нужна для ON CONFLICT (chat_username, tg_msg_id)
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

-- Индексы для частых запросов/поиска
-- Быстрый поиск по источнику/ид сообщения
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_chat_msg'
    ) THEN
        CREATE INDEX idx_tracks_chat_msg
            ON public.tracks (chat_username, tg_msg_id);
    END IF;
END$$;

-- Индексы для фильтров/метрик
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_created_at') THEN
        -- если у тебя есть created_at, снимем индекс; иначе — этот блок просто пропустится
        BEGIN
            EXECUTE 'CREATE INDEX idx_tracks_created_at ON public.tracks (created_at DESC)';
        EXCEPTION WHEN undefined_column THEN
            -- silently ignore if no created_at
            NULL;
        END;
    END IF;
END$$;

-- GIN по хэштегам/артистам (если нужно искать по массивам)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_hashtags_gin') THEN
        CREATE INDEX idx_tracks_hashtags_gin ON public.tracks USING gin (hashtags);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_artists_gin') THEN
        CREATE INDEX idx_tracks_artists_gin ON public.tracks USING gin (artists);
    END IF;
END$$;

-- Опционально: полнотекстовый индекс «на будущее».
-- Оставляю отключённым по умолчанию: раскомментируешь при необходимости.
 DO $$
 BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_tracks_search_tsv') THEN
         CREATE INDEX idx_tracks_search_tsv ON public.tracks USING gin (
             to_tsvector('simple',
                 coalesce(title,'') || ' ' ||
                 array_to_string(artists, ' ') || ' ' ||
                 array_to_string(hashtags, ' ') || ' ' ||
                 coalesce(caption,'')
             )
         );
     END IF;
 END$$;

COMMIT;