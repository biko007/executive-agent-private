-- V039: Banking Sync Runs audit table + circuit-breaker columns.
-- Etappe 0 (Safety Envelope), Spec v2 §3.1/§3.3.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Sync Runs — audit/status per sync execution
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS banking_sync_runs (
  id              BIGSERIAL PRIMARY KEY,
  institution_id  BIGINT NOT NULL REFERENCES banking_institutions(id),
  sync_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  run_phase       VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    -- 'scheduled' | 'event_resync' | 'manual'
  status          VARCHAR(40) NOT NULL DEFAULT 'RUNNING',
    -- RUNNING | SUCCESS_FULL | SUCCESS_PARTIAL | TAN_REQUIRED |
    -- BANK_TIMEOUT_UNKNOWN | IMPORT_FAILED | SKIPPED_ALREADY_SYNCED |
    -- SKIPPED_ALREADY_RUNNING
  trigger_source  VARCHAR(40),
    -- 'n8n_cron' | 'telegram_button' | 'manual_command'
  trigger_id      VARCHAR(100),
    -- n8n execution_id or telegram update_id (idempotency key)
  sca_required    BOOLEAN,
  alert_delivered BOOLEAN,
  accounts_synced INTEGER DEFAULT 0,
  transactions_new INTEGER DEFAULT 0,
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for quick lookups by institution + date (no UNIQUE — per owner decision)
CREATE INDEX IF NOT EXISTS idx_sync_runs_inst_date
  ON banking_sync_runs(institution_id, sync_date DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Circuit-Breaker columns on banking_institutions
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE banking_institutions
  ADD COLUMN IF NOT EXISTS sync_paused_status VARCHAR(40),
  ADD COLUMN IF NOT EXISTS sync_paused_since TIMESTAMPTZ;
  -- sync_paused_status: NULL (normal) | 'AUTO_PAUSED_PENDING_TAN'

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Record migration
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO schema_version (module, version) VALUES ('banking', 39)
  ON CONFLICT (module, version) DO NOTHING;
