-- V025__fleet_tables.sql — Sprint 6a Fleet Foundation
-- 6 new tables: vehicles, vehicle_service_records, vehicle_insurance_policies,
-- vehicle_tax_records, vehicle_tuev_records, fleet_documents
-- set_updated_at() trigger on all 6 tables (function exists from V023)

-- ════════════════════════════════════════════════════════════════════════════
-- 0. Guard: ensure set_updated_at() exists (idempotent)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Vehicles
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicles (
  id                  BIGSERIAL PRIMARY KEY,
  vehicle_code        VARCHAR(30) NOT NULL UNIQUE,
  display_name        VARCHAR(200) NOT NULL,
  license_plate       VARCHAR(20),
  make                VARCHAR(100) NOT NULL,
  model               VARCHAR(100) NOT NULL,
  vin                 VARCHAR(17),
  first_registration  DATE,
  holder              VARCHAR(200),
  current_mileage_km  INT,
  status              TEXT NOT NULL CHECK (status IN ('active', 'archived')) DEFAULT 'active',
  archived_at         TIMESTAMPTZ,
  archived_reason     TEXT,
  notes               TEXT,
  source_payload      JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100)
);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Vehicle Service Records
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicle_service_records (
  id                  SERIAL PRIMARY KEY,
  vehicle_id          BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  service_date        DATE NOT NULL,
  mileage_km          INT,
  service_type        VARCHAR(100) NOT NULL,
  workshop            VARCHAR(200),
  cost                NUMERIC(10,2),
  currency            VARCHAR(3) NOT NULL DEFAULT 'EUR',
  notes               TEXT,
  document_url        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_service_records_vehicle
  ON vehicle_service_records(vehicle_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Vehicle Insurance Policies
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicle_insurance_policies (
  id                  SERIAL PRIMARY KEY,
  vehicle_id          BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  company             VARCHAR(200) NOT NULL,
  policy_number       VARCHAR(100),
  coverage_type       TEXT NOT NULL CHECK (coverage_type IN ('haftpflicht', 'teilkasko', 'vollkasko')),
  annual_premium      NUMERIC(10,2),
  currency            VARCHAR(3) NOT NULL DEFAULT 'EUR',
  valid_from          DATE,
  valid_to            DATE,
  status              TEXT NOT NULL CHECK (status IN ('active', 'expired', 'cancelled')) DEFAULT 'active',
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_insurance_policies_vehicle
  ON vehicle_insurance_policies(vehicle_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Vehicle Tax Records
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicle_tax_records (
  id                  SERIAL PRIMARY KEY,
  vehicle_id          BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  tax_year            INT NOT NULL,
  amount              NUMERIC(10,2) NOT NULL,
  currency            VARCHAR(3) NOT NULL DEFAULT 'EUR',
  paid_at             TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100),
  UNIQUE (vehicle_id, tax_year)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_tax_records_vehicle
  ON vehicle_tax_records(vehicle_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Vehicle TÜV Records
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicle_tuev_records (
  id                  SERIAL PRIMARY KEY,
  vehicle_id          BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  inspection_date     DATE,
  result              TEXT CHECK (result IS NULL OR result IN ('pass', 'conditional', 'fail')),
  next_due_date       DATE,
  mileage_km          INT,
  notes               TEXT,
  document_url        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_tuev_records_vehicle
  ON vehicle_tuev_records(vehicle_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Fleet Documents
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS fleet_documents (
  id                  SERIAL PRIMARY KEY,
  vehicle_id          BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  doc_type            TEXT NOT NULL CHECK (doc_type IN (
    'vehicle_registration', 'insurance_policy', 'tuev_report', 'purchase_contract', 'other'
  )),
  title               VARCHAR(300),
  url                 TEXT NOT NULL,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_fleet_documents_vehicle
  ON fleet_documents(vehicle_id);

-- ════════════════════════════════════════════════════════════════════════════
-- TRIGGERS: set_updated_at() for all 6 tables
-- ════════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON vehicles;
CREATE TRIGGER trg_vehicles_updated_at
  BEFORE UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_vehicle_service_records_updated_at ON vehicle_service_records;
CREATE TRIGGER trg_vehicle_service_records_updated_at
  BEFORE UPDATE ON vehicle_service_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_vehicle_insurance_policies_updated_at ON vehicle_insurance_policies;
CREATE TRIGGER trg_vehicle_insurance_policies_updated_at
  BEFORE UPDATE ON vehicle_insurance_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_vehicle_tax_records_updated_at ON vehicle_tax_records;
CREATE TRIGGER trg_vehicle_tax_records_updated_at
  BEFORE UPDATE ON vehicle_tax_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_vehicle_tuev_records_updated_at ON vehicle_tuev_records;
CREATE TRIGGER trg_vehicle_tuev_records_updated_at
  BEFORE UPDATE ON vehicle_tuev_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_fleet_documents_updated_at ON fleet_documents;
CREATE TRIGGER trg_fleet_documents_updated_at
  BEFORE UPDATE ON fleet_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Record migration ────────────────────────────────────────────────────────
INSERT INTO schema_version (module, version) VALUES ('fleet', 25)
  ON CONFLICT (module, version) DO NOTHING;
