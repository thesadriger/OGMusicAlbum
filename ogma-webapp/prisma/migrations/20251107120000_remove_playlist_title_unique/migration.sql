-- Drop per-owner playlist title uniqueness to align with API behaviour
ALTER TABLE "playlists" DROP CONSTRAINT IF EXISTS "playlists_user_title_unique";
