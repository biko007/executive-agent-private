-- 020_insta_tables.sql — Instagram module tables (Sprint 3, Spec §3.1-§3.4)
-- Applied to: openclaw_core database
-- Idempotent: uses IF NOT EXISTS where possible

-- ── updated_at trigger function (shared, CREATE OR REPLACE) ──────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ── insta_drafts (§3.1) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insta_drafts (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('draft','review','approved','published','archived')),
  caption           TEXT,
  hashtags          TEXT[],
  media_type        TEXT NOT NULL CHECK (media_type IN ('image','video','carousel','reel')),
  media_files       JSONB NOT NULL DEFAULT '[]'::jsonb,
  vision_analysis   JSONB,
  source_session_id TEXT,
  approved_at       TIMESTAMPTZ,
  approved_by       TEXT,
  published_at      TIMESTAMPTZ,
  meta_post_id      TEXT,
  failed_at         TIMESTAMPTZ,
  failure_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_approved_consistency CHECK (
    (status = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  CONSTRAINT chk_published_consistency CHECK (
    (status = 'published') = (published_at IS NOT NULL AND meta_post_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_drafts_status   ON insta_drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_created  ON insta_drafts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_hashtags ON insta_drafts USING GIN (hashtags);
CREATE INDEX IF NOT EXISTS idx_drafts_vision   ON insta_drafts USING GIN (vision_analysis);
CREATE INDEX IF NOT EXISTS idx_drafts_session  ON insta_drafts(source_session_id) WHERE source_session_id IS NOT NULL;

-- Idempotency: one draft can have at most ONE meta_post_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_meta_post ON insta_drafts(meta_post_id) WHERE meta_post_id IS NOT NULL;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_drafts_updated_at ON insta_drafts;
CREATE TRIGGER trg_drafts_updated_at BEFORE UPDATE ON insta_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── insta_tokens (§3.2) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insta_tokens (
  id            SERIAL PRIMARY KEY,
  access_token  TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  rotated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tokens_one_active ON insta_tokens(active) WHERE active = true;

-- ── insta_style_profile (§3.3) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insta_style_profile (
  id          SERIAL PRIMARY KEY,
  profile     JSONB NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_style_one_active ON insta_style_profile(active) WHERE active = true;

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_style_updated_at ON insta_style_profile;
CREATE TRIGGER trg_style_updated_at BEFORE UPDATE ON insta_style_profile
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Record migration
INSERT INTO schema_version (module, version) VALUES ('instagram', 20)
  ON CONFLICT (module, version) DO NOTHING;
