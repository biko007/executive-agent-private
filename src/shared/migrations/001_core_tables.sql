-- 001_core_tables.sql — Core infrastructure tables for OpenClaw
-- Applied to: openclaw_core database
-- Idempotent: uses IF NOT EXISTS

-- Schema version tracking (per module)
CREATE TABLE IF NOT EXISTS schema_version (
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (module, version)
);

-- Audit log (cross-module)
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor           TEXT,                         -- 'telegram:12345', 'system', 'n8n', 'dashboard'
  module          TEXT NOT NULL,                -- 'instagram', 'assets', 'fleet', etc.
  action          TEXT NOT NULL,                -- 'draft.created', 'post.approved', etc.
  entity_type     TEXT,                         -- 'draft', 'property', 'vehicle', etc.
  entity_id       TEXT,                         -- the ID of the affected entity
  before_jsonb    JSONB,                        -- state before change (nullable for creates)
  after_jsonb     JSONB,                        -- state after change (nullable for deletes)
  source          TEXT NOT NULL DEFAULT 'system', -- 'telegram', 'dashboard', 'n8n', 'system'
  correlation_id  TEXT,                         -- links related operations
  request_id      TEXT                          -- unique per request
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_module ON audit_log (module);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_correlation ON audit_log (correlation_id) WHERE correlation_id IS NOT NULL;

-- Durable workflows (state machine in Postgres)
CREATE TABLE IF NOT EXISTS workflows (
  id              SERIAL PRIMARY KEY,
  type            TEXT NOT NULL,                -- 'instagram_post', 'banking_sync', etc.
  status          TEXT NOT NULL DEFAULT 'pending', -- defined per workflow type
  state_jsonb     JSONB NOT NULL DEFAULT '{}',  -- current workflow state
  correlation_id  TEXT NOT NULL,                -- links to originating request
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error           TEXT                          -- error message when status='failed'
);

CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows (status) WHERE status NOT IN ('completed', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_workflows_type ON workflows (type);
CREATE INDEX IF NOT EXISTS idx_workflows_correlation ON workflows (correlation_id);

-- Idempotency keys for external side-effects
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT PRIMARY KEY,             -- e.g. 'instagram_post:42:vision'
  workflow_id     INTEGER REFERENCES workflows(id),
  result_jsonb    JSONB,                        -- cached result of the step
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Record migration
INSERT INTO schema_version (module, version) VALUES ('shared', 1)
  ON CONFLICT (module, version) DO NOTHING;
