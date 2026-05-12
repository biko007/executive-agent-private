-- V021__health_tables.sql — Health module tables (Sprint 4, Spec §3.1-§3.3)
-- Applied to: openclaw_core database
-- Idempotent: uses IF NOT EXISTS / CREATE OR REPLACE where possible

-- ── updated_at trigger function (shared, CREATE OR REPLACE) ──────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ── health_logs (§3.1) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_logs (
  id              SERIAL PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN (
                    'weight','sleep','heartrate','steps','body_fat','activity'
                  )),
  value_numeric   NUMERIC,
  unit            TEXT,
  source          TEXT NOT NULL CHECK (source IN ('withings','manual','system')),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at     TIMESTAMPTZ NOT NULL,
  withings_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: (source, type, withings_id) prevents duplicates
CREATE UNIQUE INDEX IF NOT EXISTS uq_health_withings_source_type_id
  ON health_logs(source, type, withings_id)
  WHERE withings_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_health_type_recorded ON health_logs(type, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_recorded      ON health_logs(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_source        ON health_logs(source);

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_health_logs_updated_at ON health_logs;
CREATE TRIGGER trg_health_logs_updated_at BEFORE UPDATE ON health_logs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── health_withings_tokens (§3.2) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_withings_tokens (
  id                  SERIAL PRIMARY KEY,
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  refresh_expires_at  TIMESTAMPTZ,
  userid              TEXT NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  last_sync           TIMESTAMPTZ,
  last_sync_error     TEXT,
  rotated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_withings_one_active
  ON health_withings_tokens(active) WHERE active = true;

-- Record migration
INSERT INTO schema_version (module, version) VALUES ('health', 21)
  ON CONFLICT (module, version) DO NOTHING;
