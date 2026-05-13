-- V024__nk_engine.sql — Sprint 5.5b NK Engine Schema
-- New tables: nk_statement_runs, nk_statements, nk_statement_items, nk_alert_log
-- Modifications: nk_period_obligations (active_run_id, service_deadline_at, status expansion)
-- Lock triggers for served statements

-- ════════════════════════════════════════════════════════════════════════════
-- 1. NK Statement Runs
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nk_statement_runs (
  id                  SERIAL PRIMARY KEY,
  property_id         INT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  period_year         INT NOT NULL,
  version             INT NOT NULL DEFAULT 1,
  status              TEXT NOT NULL CHECK (status IN (
    'calculated','pdf_pending','pdf_ready','pdf_failed','served_partial','served','superseded'
  )) DEFAULT 'calculated',
  engine_version      TEXT NOT NULL DEFAULT '1.0.0',
  input_hash          TEXT NOT NULL,
  snapshot_path       TEXT,
  snapshot_sha256     TEXT,
  snapshot_size_bytes INT,
  finalized_at        TIMESTAMPTZ,
  superseded_at       TIMESTAMPTZ,
  superseded_by       INT REFERENCES nk_statement_runs(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, period_year, version)
);

CREATE INDEX IF NOT EXISTS idx_nk_runs_property_year
  ON nk_statement_runs(property_id, period_year);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Alter nk_period_obligations: add active_run_id, service_deadline_at, expand status
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE nk_period_obligations ADD COLUMN IF NOT EXISTS active_run_id INT;
ALTER TABLE nk_period_obligations ADD COLUMN IF NOT EXISTS service_deadline_at DATE;

-- Drop old status CHECK and recreate with expanded values
ALTER TABLE nk_period_obligations DROP CONSTRAINT IF EXISTS nk_period_obligations_status_check;
ALTER TABLE nk_period_obligations ADD CONSTRAINT nk_period_obligations_status_check
  CHECK (status IN (
    'pending','data_collection','calculation_ready','review',
    'approved','sent','objection','served',
    'active_run','expired'
  ));

-- FK to nk_statement_runs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_obligations_run'
  ) THEN
    ALTER TABLE nk_period_obligations
      ADD CONSTRAINT fk_obligations_run
      FOREIGN KEY (active_run_id) REFERENCES nk_statement_runs(id);
  END IF;
END$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. NK Statements (one per lease/owner-block per run)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nk_statements (
  id                  SERIAL PRIMARY KEY,
  run_id              INT NOT NULL REFERENCES nk_statement_runs(id) ON DELETE RESTRICT,
  lease_id            INT REFERENCES leases(id) ON DELETE RESTRICT,
  is_owner_block      BOOLEAN NOT NULL DEFAULT false,
  active_days         INT NOT NULL,
  costs_total         NUMERIC(12,2) NOT NULL DEFAULT 0,
  advance_total       NUMERIC(12,2) NOT NULL DEFAULT 0,
  balance             NUMERIC(12,2) NOT NULL DEFAULT 0,
  rounding_adjustment NUMERIC(12,2) NOT NULL DEFAULT 0,
  tenant_recipients   JSONB,
  pdf_render_status   TEXT NOT NULL CHECK (pdf_render_status IN (
    'pending','rendering','ready','failed'
  )) DEFAULT 'pending',
  pdf_render_error    TEXT,
  pdf_render_attempts INT NOT NULL DEFAULT 0,
  pdf_path            TEXT,
  pdf_sha256          TEXT,
  pdf_size_bytes      INT,
  served_at           TIMESTAMPTZ,
  served_method       TEXT CHECK (served_method IS NULL OR served_method IN (
    'mail','email','hand_delivery','registered_mail'
  )),
  served_note         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (is_owner_block = true AND lease_id IS NULL)
    OR (is_owner_block = false AND lease_id IS NOT NULL)
  ),
  CHECK (
    served_method IS NULL OR served_at IS NOT NULL
  )
);

-- Unique: one owner-block per run
CREATE UNIQUE INDEX IF NOT EXISTS uq_nk_statements_owner_per_run
  ON nk_statements(run_id) WHERE is_owner_block = true;

-- Unique: one statement per lease per run
CREATE UNIQUE INDEX IF NOT EXISTS uq_nk_statements_lease_per_run
  ON nk_statements(run_id, lease_id) WHERE lease_id IS NOT NULL;

-- Index for PDF worker polling
CREATE INDEX IF NOT EXISTS idx_nk_statements_render_pending
  ON nk_statements(created_at)
  WHERE pdf_render_status = 'pending';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. NK Statement Items (line items per statement)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nk_statement_items (
  id                  SERIAL PRIMARY KEY,
  statement_id        INT NOT NULL REFERENCES nk_statements(id) ON DELETE CASCADE,
  item_type           TEXT NOT NULL CHECK (item_type IN (
    'regular','vacancy_owner_share','excluded_billing_mode','rounding_adjustment'
  )),
  cost_category_id    INT REFERENCES cost_categories(id),
  allocation_rule_id  INT REFERENCES allocation_rules(id),
  related_lease_id    INT REFERENCES leases(id),
  total_property      NUMERIC(14,2),
  allocation_basis    TEXT,
  share_numerator     NUMERIC(14,4),
  share_denominator   NUMERIC(14,4),
  share_fraction      NUMERIC(10,8),
  amount              NUMERIC(12,2) NOT NULL,
  rounding_remainder  NUMERIC(12,4),
  source_booking_ids  INT[],
  notes               TEXT,
  metadata_jsonb      JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (item_type = 'regular' AND cost_category_id IS NOT NULL)
    OR (item_type != 'regular')
  ),
  CHECK (
    (item_type = 'excluded_billing_mode' AND related_lease_id IS NOT NULL)
    OR (item_type != 'excluded_billing_mode')
  )
);

CREATE INDEX IF NOT EXISTS idx_nk_items_statement
  ON nk_statement_items(statement_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Lock Triggers — prevent modification of served statements
-- ════════════════════════════════════════════════════════════════════════════

-- Lock trigger for nk_statements: block updates to served records
CREATE OR REPLACE FUNCTION nk_statement_lock_check() RETURNS TRIGGER AS $$
BEGIN
  -- If OLD row has served_at set, block changes to protected columns
  IF OLD.served_at IS NOT NULL THEN
    -- Allow only pdf_render_status and pdf_* column changes (for re-render before serve)
    -- Block changes to: served_at, served_method, served_note, costs/balance/items
    IF NEW.served_at IS DISTINCT FROM OLD.served_at
      OR NEW.served_method IS DISTINCT FROM OLD.served_method
      OR NEW.served_note IS DISTINCT FROM OLD.served_note
      OR NEW.costs_total IS DISTINCT FROM OLD.costs_total
      OR NEW.advance_total IS DISTINCT FROM OLD.advance_total
      OR NEW.balance IS DISTINCT FROM OLD.balance
      OR NEW.rounding_adjustment IS DISTINCT FROM OLD.rounding_adjustment
      OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
      OR NEW.is_owner_block IS DISTINCT FROM OLD.is_owner_block
      OR NEW.active_days IS DISTINCT FROM OLD.active_days
    THEN
      RAISE EXCEPTION 'Cannot modify served NK statement (id=%)', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_nk_statement_lock ON nk_statements;
CREATE TRIGGER trg_nk_statement_lock
  BEFORE UPDATE ON nk_statements
  FOR EACH ROW EXECUTE FUNCTION nk_statement_lock_check();

-- Lock trigger for nk_statement_items: block changes if parent statement is served
CREATE OR REPLACE FUNCTION nk_statement_items_lock_check() RETURNS TRIGGER AS $$
DECLARE
  parent_served_at TIMESTAMPTZ;
BEGIN
  -- For INSERT/UPDATE, check the target statement
  IF TG_OP = 'DELETE' THEN
    SELECT served_at INTO parent_served_at FROM nk_statements WHERE id = OLD.statement_id;
  ELSE
    SELECT served_at INTO parent_served_at FROM nk_statements WHERE id = NEW.statement_id;
  END IF;

  IF parent_served_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot modify items of served NK statement';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_nk_statement_items_lock ON nk_statement_items;
CREATE TRIGGER trg_nk_statement_items_lock
  BEFORE INSERT OR UPDATE OR DELETE ON nk_statement_items
  FOR EACH ROW EXECUTE FUNCTION nk_statement_items_lock_check();

-- ════════════════════════════════════════════════════════════════════════════
-- 6. NK Alert Log — deadline tracking per §556 BGB
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nk_alert_log (
  id              SERIAL PRIMARY KEY,
  obligation_id   INT NOT NULL REFERENCES nk_period_obligations(id) ON DELETE RESTRICT,
  alert_phase     TEXT NOT NULL CHECK (alert_phase IN ('30d','14d','7d','1d','expired')),
  alert_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  notified_via    TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (obligation_id, alert_phase, alert_date)
);

CREATE INDEX IF NOT EXISTS idx_nk_alert_log_obligation
  ON nk_alert_log(obligation_id);

-- ════════════════════════════════════════════════════════════════════════════
-- TRIGGERS: set_updated_at() for new tables
-- ════════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_nk_statement_runs_updated_at ON nk_statement_runs;
CREATE TRIGGER trg_nk_statement_runs_updated_at
  BEFORE UPDATE ON nk_statement_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_nk_statements_updated_at ON nk_statements;
CREATE TRIGGER trg_nk_statements_updated_at
  BEFORE UPDATE ON nk_statements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Record migration ────────────────────────────────────────────────────────
INSERT INTO schema_version (module, version) VALUES ('assets', 24)
  ON CONFLICT (module, version) DO NOTHING;
