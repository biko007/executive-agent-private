-- Migration 041: conversation_log (Message-Sink fuer spaetere Memory-Extraktion)
-- Module: memory | Version: 41
-- Boot-Time-DDL: idempotent, automatisch bei jedem Gateway-Start

CREATE TABLE IF NOT EXISTS conversation_log (
  id           BIGSERIAL    PRIMARY KEY,
  sender_id    TEXT         NOT NULL,
  user_text    TEXT         NOT NULL,
  agent_text   TEXT,
  session_key  TEXT,
  channel      TEXT         NOT NULL DEFAULT 'telegram',
  metadata     JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_log_sender_created
  ON conversation_log (sender_id, created_at);

INSERT INTO schema_version (module, version)
VALUES ('memory', 41)
ON CONFLICT DO NOTHING;
