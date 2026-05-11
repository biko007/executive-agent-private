-- Service health monitoring state (recovery after restart)
CREATE TABLE IF NOT EXISTS service_health (
  service        TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'unknown',  -- 'up', 'down', 'unknown'
  last_check     TIMESTAMPTZ,
  last_change    TIMESTAMPTZ,
  downtime_start TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
