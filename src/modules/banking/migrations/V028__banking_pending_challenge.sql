-- V028: Add pending TAN challenge columns to banking_sessions.
-- Sprint 7b Etappe d: Stores challenge metadata while awaiting TAN response.
-- pending_challenge_state is encrypted BYTEA (same pattern as session_state_encrypted).

ALTER TABLE banking_sessions ADD COLUMN IF NOT EXISTS pending_challenge_type VARCHAR(50);
ALTER TABLE banking_sessions ADD COLUMN IF NOT EXISTS pending_challenge_message TEXT;
ALTER TABLE banking_sessions ADD COLUMN IF NOT EXISTS pending_challenge_state BYTEA;
ALTER TABLE banking_sessions ADD COLUMN IF NOT EXISTS pending_challenge_at TIMESTAMPTZ;

INSERT INTO schema_version (module, version) VALUES ('banking', 28) ON CONFLICT DO NOTHING;
