-- sql/006_indexer_status.sql
-- Schema objects for tracking Telegram indexer heartbeat & history
-- Compatible with PostgreSQL 13+

BEGIN;

-- === Base table: current status (single-row by design) ======================
CREATE TABLE IF NOT EXISTS public.indexer_status (
    id              integer PRIMARY KEY DEFAULT 1
        CHECK (id = 1),                                -- single logical row
    last_msg_id     bigint      NULL
        CHECK (last_msg_id IS NULL OR last_msg_id >= 0),
    last_ts         timestamptz NOT NULL DEFAULT now(),-- last heartbeat time
    last_error      text        NULL,                   -- last error (if any)
    source_chat     text        NULL,                   -- e.g. @OGMA_archive
    session_name    text        NULL                    -- Telethon session id
);

COMMENT ON TABLE  public.indexer_status IS
'Live status of the Telegram indexer. Single-row table (id=1).';
COMMENT ON COLUMN public.indexer_status.last_msg_id  IS 'Last processed Telegram message id.';
COMMENT ON COLUMN public.indexer_status.last_ts      IS 'Timestamp of the latest successful heartbeat (or update).';
COMMENT ON COLUMN public.indexer_status.last_error   IS 'Last error message, if any; null on healthy heartbeat.';
COMMENT ON COLUMN public.indexer_status.source_chat  IS 'Telegram source chat @username for context/observability.';
COMMENT ON COLUMN public.indexer_status.session_name IS 'Telethon session name used by the indexer.';

-- Handy time index (helps queries that compute lag, dashboards, etc.)
CREATE INDEX IF NOT EXISTS indexer_status_last_ts_idx
    ON public.indexer_status (last_ts DESC);

-- === History table: immutable append-only log ==============================
CREATE TABLE IF NOT EXISTS public.indexer_status_history (
    hist_id         bigserial    PRIMARY KEY,
    id              integer      NOT NULL,              -- FK-like to indexer_status.id
    last_msg_id     bigint       NULL,
    last_ts         timestamptz  NOT NULL DEFAULT now(),
    last_error      text         NULL,
    source_chat     text         NULL,
    session_name    text         NULL,
    op              text         NOT NULL,              -- 'INSERT' | 'UPDATE'
    created_at      timestamptz  NOT NULL DEFAULT now() -- audit insertion time
);

COMMENT ON TABLE  public.indexer_status_history IS
'Append-only history of indexer_status changes for audits & analysis.';
COMMENT ON COLUMN public.indexer_status_history.op IS
'Operation that produced the row: INSERT or UPDATE trigger.';

-- Fast time-ordered lookups (dashboards / forensics)
CREATE INDEX IF NOT EXISTS indexer_status_history_created_idx
    ON public.indexer_status_history (created_at DESC);

-- Optional: partitioning prep (keep simple index now; can evolve to time partitioning)

-- === Trigger: capture every INSERT/UPDATE into history ======================
CREATE OR REPLACE FUNCTION public.trg_indexer_status_to_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.indexer_status_history(
        id, last_msg_id, last_ts, last_error, source_chat, session_name, op, created_at
    )
    VALUES (
        NEW.id, NEW.last_msg_id, COALESCE(NEW.last_ts, now()), NEW.last_error,
        NEW.source_chat, NEW.session_name, TG_OP, now()
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS indexer_status_audit_trg ON public.indexer_status;
CREATE TRIGGER indexer_status_audit_trg
AFTER INSERT OR UPDATE ON public.indexer_status
FOR EACH ROW
EXECUTE FUNCTION public.trg_indexer_status_to_history();

-- === Helper view: real-time lag in minutes =================================
CREATE OR REPLACE VIEW public.v_indexer_lag_minutes AS
SELECT
    s.id,
    s.last_msg_id,
    s.last_ts,
    EXTRACT(EPOCH FROM (now() - s.last_ts)) / 60.0 AS lag_min,
    s.last_error,
    s.source_chat,
    s.session_name
FROM public.indexer_status AS s;

COMMENT ON VIEW public.v_indexer_lag_minutes IS
'Convenience view exposing current lag in minutes for Prometheus/Grafana/Reflex.';

-- === Upsert helper: canonical heartbeat API at SQL level ====================
-- Use from application: SELECT public.upsert_indexer_heartbeat($1, $2, $3, $4);
--  p_last_msg_id: bigint or NULL
--  p_last_error : text or NULL (set NULL on healthy heartbeat)
--  p_source_chat: text or NULL (keeps existing if NULL)
--  p_session    : text or NULL (keeps existing if NULL)
CREATE OR REPLACE FUNCTION public.upsert_indexer_heartbeat(
    p_last_msg_id bigint,
    p_last_error  text DEFAULT NULL,
    p_source_chat text DEFAULT NULL,
    p_session     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.indexer_status (id, last_msg_id, last_ts, last_error, source_chat, session_name)
    VALUES (1, p_last_msg_id, now(), p_last_error, p_source_chat, p_session)
    ON CONFLICT (id) DO UPDATE
    SET last_msg_id  = EXCLUDED.last_msg_id,
        last_ts      = EXCLUDED.last_ts,
        last_error   = EXCLUDED.last_error,
        source_chat  = COALESCE(EXCLUDED.source_chat, public.indexer_status.source_chat),
        session_name = COALESCE(EXCLUDED.session_name, public.indexer_status.session_name);
END;
$$;

COMMENT ON FUNCTION public.upsert_indexer_heartbeat(bigint, text, text, text) IS
'Atomic upsert used by the indexer to record progress, error, and context.';

-- === Optional: retention helper for history (manual or cron job) ===========
-- Example: keep last 90 days of history; tune as needed.
CREATE OR REPLACE FUNCTION public.prune_indexer_status_history(p_keep_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_cutoff timestamptz := now() - (p_keep_days || ' days')::interval;
    v_deleted integer;
BEGIN
    DELETE FROM public.indexer_status_history h
     WHERE h.created_at < v_cutoff;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.prune_indexer_status_history(integer) IS
'Deletes indexer_status_history rows older than N days (default 90).';

-- === (Optional) Privileges model ===========================================
-- REVOKE ALL ON public.indexer_status, public.indexer_status_history FROM PUBLIC;
-- GRANT SELECT, INSERT, UPDATE ON public.indexer_status TO ogma_app;      -- app role
-- GRANT SELECT ON public.indexer_status_history TO ogma_app, ogma_ro;     -- read-only role
-- GRANT EXECUTE ON FUNCTION public.upsert_indexer_heartbeat(bigint, text, text, text) TO ogma_app;
-- GRANT EXECUTE ON FUNCTION public.prune_indexer_status_history(integer) TO ogma_admin;

COMMIT;