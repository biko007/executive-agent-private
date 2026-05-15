-- V029: Dedup table for session-expiry Telegram reminders. Sprint 7b Etappe e.
CREATE TABLE IF NOT EXISTS banking_sync_reminders (
  id              BIGSERIAL PRIMARY KEY,
  session_id      BIGINT NOT NULL REFERENCES banking_sessions(id) ON DELETE CASCADE,
  threshold_days  SMALLINT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, threshold_days)
);

CREATE INDEX IF NOT EXISTS idx_banking_sync_reminders_session
  ON banking_sync_reminders(session_id);

INSERT INTO schema_version (module, version) VALUES ('banking', 29)
  ON CONFLICT (module, version) DO NOTHING;
