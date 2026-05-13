-- V023__assets_foundation.sql — Sprint 5.5a-1 Assets Foundation
-- Extends V022 schema with: owner, unit_residents, heating_config,
-- approval_tokens, csrf_tokens, idempotency_keys (new), nk_period_obligations,
-- EXCLUDE USING gist constraints, triggers on all mutable tables.
-- Requires: btree_gist extension (installed in a0 preflight)

-- ════════════════════════════════════════════════════════════════════════════
-- PREFLIGHT: Check for overlapping ranges before adding EXCLUDE constraints
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  overlap_count INT;
BEGIN
  -- lease_charges: check for overlapping valid_from/valid_until per lease_id + charge_type
  SELECT count(*) INTO overlap_count
  FROM lease_charges a JOIN lease_charges b
    ON a.lease_id = b.lease_id AND a.charge_type = b.charge_type AND a.id < b.id
    AND a.valid_from <= COALESCE(b.valid_until, '9999-12-31'::date)
    AND COALESCE(a.valid_until, '9999-12-31'::date) >= b.valid_from;
  IF overlap_count > 0 THEN
    RAISE EXCEPTION 'V023 preflight: % overlapping lease_charges found — resolve before migration', overlap_count;
  END IF;

  -- allocation_rules: check for overlapping valid_from/valid_until per property_id + cost_category_id
  SELECT count(*) INTO overlap_count
  FROM allocation_rules a JOIN allocation_rules b
    ON a.property_id = b.property_id AND a.cost_category_id = b.cost_category_id AND a.id < b.id
    AND a.valid_from <= COALESCE(b.valid_until, '9999-12-31'::date)
    AND COALESCE(a.valid_until, '9999-12-31'::date) >= b.valid_from;
  IF overlap_count > 0 THEN
    RAISE EXCEPTION 'V023 preflight: % overlapping allocation_rules found — resolve before migration', overlap_count;
  END IF;

  -- allocation_rule_shares: check for overlapping valid_from/valid_until per allocation_rule_id + unit_id
  SELECT count(*) INTO overlap_count
  FROM allocation_rule_shares a JOIN allocation_rule_shares b
    ON a.allocation_rule_id = b.allocation_rule_id AND a.unit_id = b.unit_id AND a.id < b.id
    AND a.valid_from <= COALESCE(b.valid_until, '9999-12-31'::date)
    AND COALESCE(a.valid_until, '9999-12-31'::date) >= b.valid_from;
  IF overlap_count > 0 THEN
    RAISE EXCEPTION 'V023 preflight: % overlapping allocation_rule_shares found — resolve before migration', overlap_count;
  END IF;
END$$;

-- ════════════════════════════════════════════════════════════════════════════
-- ALTER EXISTING TABLES
-- ════════════════════════════════════════════════════════════════════════════

-- ── Properties: add owner + ownership_end ──────────────────────────────────
ALTER TABLE properties ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS ownership_end DATE;

-- ── Meter Readings: add estimation fields, extend reading_type ─────────────
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS is_estimated BOOLEAN DEFAULT false;
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS estimate_method TEXT;
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS estimate_reason TEXT;

-- Drop and recreate reading_type CHECK to add 'meter_reset'
ALTER TABLE meter_readings DROP CONSTRAINT IF EXISTS meter_readings_reading_type_check;
ALTER TABLE meter_readings ADD CONSTRAINT meter_readings_reading_type_check
  CHECK (reading_type IN ('annual','move_in','move_out','interim','automatic','meter_reset'));

-- ── Meters: add submetering_purpose ────────────────────────────────────────
ALTER TABLE meters ADD COLUMN IF NOT EXISTS submetering_purpose TEXT;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- ── Expense Bookings: add archived_at ──────────────────────────────────────
ALTER TABLE expense_bookings ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- ── Units: add archived column ─────────────────────────────────────────────
-- Note: 'active' already exists — archived_at is the complement
ALTER TABLE units ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- ════════════════════════════════════════════════════════════════════════════
-- NEW TABLES
-- ════════════════════════════════════════════════════════════════════════════

-- ── Unit Residents (EXCLUDE USING gist for no-overlap) ─────────────────────
CREATE TABLE IF NOT EXISTS unit_residents (
  id              SERIAL PRIMARY KEY,
  unit_id         INT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  move_in         DATE NOT NULL,
  move_out        DATE,
  persons_count   INT NOT NULL DEFAULT 1 CHECK (persons_count >= 1),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (move_out IS NULL OR move_out >= move_in)
);

-- EXCLUDE constraint: no overlapping residents per unit
-- Uses daterange with upper bound inclusive semantics
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unit_residents_no_overlap'
  ) THEN
    ALTER TABLE unit_residents ADD CONSTRAINT unit_residents_no_overlap
      EXCLUDE USING gist (
        unit_id WITH =,
        daterange(move_in, move_out, '[]') WITH &&
      );
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_unit_residents_unit ON unit_residents(unit_id, move_in);

-- ── Lease Charges: add EXCLUDE constraint ──────────────────────────────────
ALTER TABLE lease_charges ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lease_charges_no_overlap'
  ) THEN
    ALTER TABLE lease_charges ADD CONSTRAINT lease_charges_no_overlap
      EXCLUDE USING gist (
        lease_id WITH =,
        charge_type WITH =,
        daterange(valid_from, valid_until, '[]') WITH &&
      );
  END IF;
END$$;

-- ── Allocation Rules: add EXCLUDE constraint ───────────────────────────────
ALTER TABLE allocation_rules ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rules_no_overlap'
  ) THEN
    ALTER TABLE allocation_rules ADD CONSTRAINT allocation_rules_no_overlap
      EXCLUDE USING gist (
        property_id WITH =,
        cost_category_id WITH =,
        daterange(valid_from, valid_until, '[]') WITH &&
      );
  END IF;
END$$;

-- ── Allocation Rule Shares: add EXCLUDE constraint ─────────────────────────
ALTER TABLE allocation_rule_shares ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_shares_no_overlap'
  ) THEN
    ALTER TABLE allocation_rule_shares ADD CONSTRAINT allocation_rule_shares_no_overlap
      EXCLUDE USING gist (
        allocation_rule_id WITH =,
        unit_id WITH =,
        daterange(valid_from, valid_until, '[]') WITH &&
      );
  END IF;
END$$;

-- ── Approval Tokens ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_tokens (
  id                    SERIAL PRIMARY KEY,
  token                 UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  session_id            TEXT NOT NULL,
  actor                 TEXT NOT NULL,
  method                TEXT NOT NULL,
  endpoint_key          TEXT NOT NULL,
  canonical_body_hash   TEXT NOT NULL,
  entity_versions       JSONB,
  diff_summary          JSONB,
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  superseded_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_tokens_active
  ON approval_tokens(session_id, endpoint_key)
  WHERE used_at IS NULL AND superseded_at IS NULL;

-- ── CSRF Tokens ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS csrf_tokens (
  id              SERIAL PRIMARY KEY,
  token           UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_csrf_tokens_lookup
  ON csrf_tokens(token, session_id);

-- ── Idempotency Keys: rename old → workflow_idempotency_keys, create new ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'idempotency_keys' AND table_schema = 'public'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'workflow_idempotency_keys' AND table_schema = 'public'
  ) THEN
    ALTER TABLE idempotency_keys RENAME TO workflow_idempotency_keys;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor           TEXT NOT NULL,
  endpoint_key    TEXT NOT NULL,
  key             TEXT NOT NULL,
  body_hash       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('processing','succeeded','failed')) DEFAULT 'processing',
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (actor, endpoint_key, key)
);

-- ── Property Heating Config ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS property_heating_config (
  id                          SERIAL PRIMARY KEY,
  property_id                 INT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  year                        INT NOT NULL,
  heating_system              TEXT NOT NULL CHECK (heating_system IN ('central_gas','central_oil','district','heat_pump','electric','none')),
  hot_water_via_heating       BOOLEAN NOT NULL DEFAULT true,
  base_share_percent          NUMERIC(5,2) CHECK (base_share_percent BETWEEN 0 AND 100),
  consumption_share_percent   NUMERIC(5,2) CHECK (consumption_share_percent BETWEEN 0 AND 100),
  co2_emissions_kg            NUMERIC(12,2),
  co2_cost_total              NUMERIC(12,2),
  co2_tenant_share_percent    NUMERIC(5,2),
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, year)
);

-- ── NK Period Obligations ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nk_period_obligations (
  id              SERIAL PRIMARY KEY,
  property_id     INT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  year            INT NOT NULL,
  unit_id         INT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  lease_id        INT NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL CHECK (status IN (
    'pending','data_collection','calculation_ready','review',
    'approved','sent','objection','served'
  )) DEFAULT 'pending',
  result_amount   NUMERIC(12,2),
  due_date        DATE,
  served_at       TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, year, unit_id)
);

CREATE INDEX IF NOT EXISTS idx_nk_obligations_property_year
  ON nk_period_obligations(property_id, year);

-- ════════════════════════════════════════════════════════════════════════════
-- TRIGGERS: set_updated_at() on all mutable tables
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- Apply trigger to all mutable tables (DROP + CREATE for idempotency)
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'properties', 'units', 'tenants', 'leases', 'lease_tenants',
    'lease_charges', 'expense_bookings', 'meters',
    'allocation_rules', 'allocation_rule_shares',
    'rent_ledger', 'security_deposits',
    'unit_residents', 'property_heating_config', 'nk_period_obligations'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', tbl, tbl);
    -- Only add trigger if the table has updated_at column
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = tbl AND column_name = 'updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        tbl, tbl
      );
    END IF;
  END LOOP;
END$$;

-- ════════════════════════════════════════════════════════════════════════════
-- SEED: properties.owner column
-- ════════════════════════════════════════════════════════════════════════════

UPDATE properties SET owner = 'personal' WHERE code IN ('l19', 'mg24', 'd4', 's28') AND owner = 'personal';
UPDATE properties SET owner = 'la_perla_gmbh' WHERE code = 'n24';

-- ── Record migration ────────────────────────────────────────────────────────
INSERT INTO schema_version (module, version) VALUES ('assets', 23)
  ON CONFLICT (module, version) DO NOTHING;
