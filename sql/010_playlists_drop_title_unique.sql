-- 010_playlists_drop_title_unique.sql
-- Remove per-user title uniqueness to allow duplicate playlist names.
ALTER TABLE playlists DROP CONSTRAINT IF EXISTS playlists_user_title_uniq;
