-- enum
DO $$ BEGIN
  CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- новые колонки в playlists
ALTER TABLE "public"."playlists"
  ADD COLUMN IF NOT EXISTS "is_private" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "listened_seconds_total" integer NOT NULL DEFAULT 0;

-- таблица заявок
DO $$ BEGIN
  CREATE TABLE "public"."playlist_access_requests" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "playlist_id" uuid NOT NULL,
    "requester_id" bigint NOT NULL,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "playlist_access_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "playlist_access_requests_playlist_id_fkey"
      FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE CASCADE,
    CONSTRAINT "playlist_access_requests_requester_id_fkey"
      FOREIGN KEY ("requester_id") REFERENCES "public"."users"("telegram_id") ON DELETE CASCADE
  );
EXCEPTION
  WHEN duplicate_table THEN NULL;
END $$;

-- уникальность (playlist_id, requester_id)
DO $$ BEGIN
  CREATE UNIQUE INDEX "playlist_access_requests_unique"
    ON "public"."playlist_access_requests" ("playlist_id", "requester_id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;