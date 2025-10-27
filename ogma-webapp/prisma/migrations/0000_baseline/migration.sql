-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Требуется для gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Требуется для GIN ... gin_trgm_ops
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateTable
CREATE TABLE "public"."bot_status" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_update_ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,

    CONSTRAINT "bot_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."indexer_status" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_msg_id" BIGINT,
    "last_ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "source_chat" TEXT,
    "session_name" TEXT,

    CONSTRAINT "indexer_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."indexer_status_history" (
    "hist_id" BIGSERIAL NOT NULL,
    "id" INTEGER NOT NULL,
    "last_msg_id" BIGINT,
    "last_ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "source_chat" TEXT,
    "session_name" TEXT,
    "op" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "indexer_status_history_pkey" PRIMARY KEY ("hist_id")
);

-- CreateTable
CREATE TABLE "public"."playlist_items" (
    "playlist_id" UUID NOT NULL,
    "track_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_items_pkey" PRIMARY KEY ("playlist_id","track_id")
);

-- CreateTable
CREATE TABLE "public"."playlists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'custom',
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "handle" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tracks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tg_msg_id" BIGINT,
    "chat_username" TEXT,
    "title" TEXT,
    "artists" TEXT[],
    "hashtags" TEXT[],
    "duration_s" INTEGER,
    "mime" TEXT,
    "size_bytes" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caption" TEXT,
    "doc_id" BIGINT,
    "access_hash" BIGINT,
    "file_ref_b64" TEXT,
    "dc_id" INTEGER,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_playlist_items" (
    "user_id" BIGINT NOT NULL,
    "track_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "added_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_playlist_items_pkey" PRIMARY KEY ("user_id","track_id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "telegram_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("telegram_id")
);

-- CreateIndex
CREATE INDEX "bot_status_last_update_idx" ON "public"."bot_status"("last_update_ts" DESC);

-- CreateIndex
CREATE INDEX "indexer_status_last_ts_idx" ON "public"."indexer_status"("last_ts" DESC);

-- CreateIndex
CREATE INDEX "indexer_status_history_created_idx" ON "public"."indexer_status_history"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "playlists_handle_key" ON "public"."playlists"("handle" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "playlists_user_title_unique" ON "public"."playlists"("user_id" ASC, "title" ASC);

-- CreateIndex
CREATE INDEX "idx_tracks_artists_gin" ON "public"."tracks" USING GIN ("artists" array_ops);

-- CreateIndex
CREATE INDEX "idx_tracks_caption_trgm" ON "public"."tracks" USING GIN ("caption" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_tracks_chat_msg" ON "public"."tracks"("chat_username" ASC, "tg_msg_id" ASC);

-- CreateIndex
CREATE INDEX "idx_tracks_created_at" ON "public"."tracks"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_tracks_hashtags_gin" ON "public"."tracks" USING GIN ("hashtags" array_ops);

-- CreateIndex
CREATE INDEX "idx_tracks_mime_btree" ON "public"."tracks"("mime" ASC);

-- CreateIndex
CREATE INDEX "idx_tracks_title_trgm" ON "public"."tracks" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "tracks_chat_msg_unique" ON "public"."tracks"("chat_username" ASC, "tg_msg_id" ASC);

-- CreateIndex
CREATE INDEX "user_playlist_added_idx" ON "public"."user_playlist_items"("user_id" ASC, "added_at" DESC);

-- AddForeignKey
ALTER TABLE "public"."playlist_items" ADD CONSTRAINT "playlist_items_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."playlist_items" ADD CONSTRAINT "playlist_items_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."user_playlist_items" ADD CONSTRAINT "user_playlist_items_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."user_playlist_items" ADD CONSTRAINT "user_playlist_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("telegram_id") ON DELETE CASCADE ON UPDATE NO ACTION;

