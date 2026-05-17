-- V037_insta_media_edits.sql — Instagram media edit versioning (Sprint A+B, E1b)
-- Applied to: openclaw_core database
-- One-Shot migration (V-prefix pattern)

-- ── insta_media_edits ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insta_media_edits (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT      NOT NULL,
  media_index     INT       NOT NULL,
  draft_id        TEXT      NULL REFERENCES insta_drafts(id) ON DELETE SET NULL,
  variant         TEXT      NOT NULL,
  source_path     TEXT      NOT NULL,
  output_path     TEXT      NULL,
  sha256_original TEXT      NOT NULL,
  sha256_output   TEXT      NULL,
  params_hash     TEXT      NULL,
  status          TEXT      NOT NULL DEFAULT 'uploaded',
  error_code      TEXT      NULL,
  error_message   TEXT      NULL,
  vision_metadata JSONB     NULL,
  source          TEXT      NOT NULL,
  request_id      TEXT      NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_variant CHECK (variant IN ('original','center_4x5','vision_4x5','video_4x5','cover_frame')),
  CONSTRAINT chk_status  CHECK (status  IN ('uploaded','processing','edited','edit_failed','deleted')),
  CONSTRAINT chk_source  CHECK (source  IN ('telegram','ios_shortcut','dashboard'))
);

-- Partial UNIQUE: only non-deleted rows are constrained
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_edit_active_variant
  ON insta_media_edits (session_id, media_index, variant, COALESCE(params_hash, ''))
  WHERE status != 'deleted';

CREATE INDEX IF NOT EXISTS ix_media_edit_session ON insta_media_edits (session_id);
CREATE INDEX IF NOT EXISTS ix_media_edit_draft   ON insta_media_edits (draft_id) WHERE draft_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_media_edit_hash    ON insta_media_edits (sha256_original);
CREATE INDEX IF NOT EXISTS ix_media_edit_status  ON insta_media_edits (status) WHERE status IN ('processing','edit_failed');

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_media_edits_updated_at ON insta_media_edits;
CREATE TRIGGER trg_media_edits_updated_at BEFORE UPDATE ON insta_media_edits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Record migration
INSERT INTO schema_version (module, version) VALUES ('instagram', 37)
  ON CONFLICT (module, version) DO NOTHING;
