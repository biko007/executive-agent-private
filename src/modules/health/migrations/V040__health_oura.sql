-- V040__health_oura.sql — Oura Ring integration (Spec §0–§1)
--
-- 1. Rename withings_id → external_id (provider-neutral dedup key)
-- 2. Extend type/source CHECKs for Oura data types
-- 3. Create health_oura_tokens table (mirrors health_withings_tokens, no userid)
-- 4. GRANTs for openclaw role

-- ── 1. Rename column + index ─────────────────────────────────────────────────
ALTER TABLE health_logs RENAME COLUMN withings_id TO external_id;

ALTER INDEX IF EXISTS uq_health_withings_source_type_id
  RENAME TO uq_health_source_type_extid;

-- ── 2. Extend type CHECK (add hrv, readiness, temperature) ───────────────────
ALTER TABLE health_logs DROP CONSTRAINT health_logs_type_check;
ALTER TABLE health_logs ADD CONSTRAINT health_logs_type_check
  CHECK (type IN (
    'weight', 'sleep', 'heartrate', 'steps', 'body_fat', 'activity',
    'symptom', 'log',
    'hrv', 'readiness', 'temperature'
  ));

-- ── 3. Extend source CHECK (add oura) ────────────────────────────────────────
ALTER TABLE health_logs DROP CONSTRAINT health_logs_source_check;
ALTER TABLE health_logs ADD CONSTRAINT health_logs_source_check
  CHECK (source IN ('withings', 'manual', 'system', 'oura'));

-- ── 4. Oura token table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_oura_tokens (
  id              SERIAL PRIMARY KEY,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  last_sync       TIMESTAMPTZ,
  last_sync_error TEXT,
  rotated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oura_one_active
  ON health_oura_tokens(active) WHERE active = true;

-- ── 5. GRANTs ────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON health_oura_tokens TO openclaw;
GRANT USAGE, SELECT ON SEQUENCE health_oura_tokens_id_seq TO openclaw;

-- ── 6. Schema version ────────────────────────────────────────────────────────
INSERT INTO schema_version (module, version) VALUES ('health', 40)
  ON CONFLICT (module, version) DO NOTHING;
