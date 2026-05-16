-- V026__fleet_tire_sets.sql — Sprint 5.7b: vehicle_tire_sets table
-- Missed from V025, code already references this table.

CREATE TABLE IF NOT EXISTS vehicle_tire_sets (
  id              SERIAL PRIMARY KEY,
  vehicle_id      BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  tire_type       VARCHAR(100),
  brand           VARCHAR(200),
  model           VARCHAR(200),
  tread_depth_mm  NUMERIC(5,1),
  installed_at    DATE,
  removed_at      DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      VARCHAR(100),
  updated_by      VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_tire_sets_vehicle
  ON vehicle_tire_sets(vehicle_id);

DROP TRIGGER IF EXISTS trg_vehicle_tire_sets_updated_at ON vehicle_tire_sets;
CREATE TRIGGER trg_vehicle_tire_sets_updated_at
  BEFORE UPDATE ON vehicle_tire_sets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_version (module, version) VALUES ('fleet', 26)
  ON CONFLICT (module, version) DO NOTHING;
