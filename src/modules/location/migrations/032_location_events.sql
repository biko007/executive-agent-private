-- Sprint 8: Location events table
-- Replaces history.jsonl file-based storage with Postgres

CREATE TABLE IF NOT EXISTS location_events (
  id            SERIAL PRIMARY KEY,
  recorded_at   TIMESTAMPTZ NOT NULL,
  lat           NUMERIC(10, 7) NOT NULL,
  lon           NUMERIC(10, 7) NOT NULL,
  altitude_m    NUMERIC(8, 2),
  source        TEXT NOT NULL DEFAULT 'ios_shortcut',
  label         TEXT,
  geocoded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_location_recorded_at ON location_events(recorded_at DESC);

DO $$ BEGIN
  ALTER TABLE location_events ADD CONSTRAINT lat_range CHECK (lat BETWEEN -90 AND 90);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE location_events ADD CONSTRAINT lon_range CHECK (lon BETWEEN -180 AND 180);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
