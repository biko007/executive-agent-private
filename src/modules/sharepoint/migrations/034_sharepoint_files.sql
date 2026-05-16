-- Sprint 10: SharePoint Postgres Migration (V034)
-- pg_trgm must be created as superuser in Etappe 0
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS sharepoint_files (
  id SERIAL PRIMARY KEY,
  sp_item_key TEXT NOT NULL UNIQUE,
  graph_item_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  web_url TEXT NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  mime_type TEXT,
  last_modified_at TIMESTAMPTZ NOT NULL,
  created_at_remote TIMESTAMPTZ NOT NULL,
  site_name TEXT NOT NULL,
  site_id TEXT NOT NULL,
  drive_name TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  missing_since TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sp_files_path ON sharepoint_files(path);
CREATE INDEX IF NOT EXISTS idx_sp_files_name ON sharepoint_files(name);
CREATE INDEX IF NOT EXISTS idx_sp_files_site_drive ON sharepoint_files(site_id, drive_id);
CREATE INDEX IF NOT EXISTS idx_sp_files_last_modified ON sharepoint_files(last_modified_at DESC);
CREATE INDEX IF NOT EXISTS idx_sp_files_mime_type ON sharepoint_files(mime_type);
CREATE INDEX IF NOT EXISTS idx_sp_files_missing_since ON sharepoint_files(missing_since)
  WHERE missing_since IS NULL;
CREATE INDEX IF NOT EXISTS idx_sp_files_graph_id ON sharepoint_files(graph_item_id)
  WHERE graph_item_id IS NOT NULL;

-- Full-text search: pg_trgm GIN on generated search column
ALTER TABLE sharepoint_files ADD COLUMN IF NOT EXISTS search_haystack TEXT
  GENERATED ALWAYS AS (name || ' ' || path || ' ' || site_name || ' ' || drive_name) STORED;
CREATE INDEX IF NOT EXISTS idx_sp_files_search_trgm ON sharepoint_files
  USING GIN (search_haystack gin_trgm_ops);

CREATE TABLE IF NOT EXISTS sharepoint_sync_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running','success','error')),
  total_files INTEGER,
  total_sites INTEGER,
  total_drives INTEGER,
  newly_missing INTEGER DEFAULT 0,
  duration_ms INTEGER,
  errors JSONB DEFAULT '[]',
  skipped_sites JSONB DEFAULT '[]',
  triggered_by TEXT NOT NULL DEFAULT 'manual'
);

CREATE INDEX IF NOT EXISTS idx_sp_runs_started_at ON sharepoint_sync_runs(started_at DESC);
