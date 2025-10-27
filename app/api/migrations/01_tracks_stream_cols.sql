ALTER TABLE tracks
  ADD COLUMN IF NOT EXISTS tg_document_id  bigint,
  ADD COLUMN IF NOT EXISTS tg_access_hash  bigint,
  ADD COLUMN IF NOT EXISTS tg_file_ref     bytea,
  ADD COLUMN IF NOT EXISTS tg_dc_id        smallint;

CREATE INDEX IF NOT EXISTS idx_tracks_tg_msg ON tracks(tg_msg_id, chat_username);
CREATE INDEX IF NOT EXISTS idx_tracks_doc    ON tracks(tg_document_id);
