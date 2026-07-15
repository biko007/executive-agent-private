-- Migration 043: Owner-memory no longer has a hardcoded Telegram sender default.
-- Binding-based guards pass owner_sender_id explicitly.

ALTER TABLE owner_memory
  ALTER COLUMN owner_sender_id DROP DEFAULT;

INSERT INTO schema_version (module, version)
VALUES ('memory', 43)
ON CONFLICT DO NOTHING;
