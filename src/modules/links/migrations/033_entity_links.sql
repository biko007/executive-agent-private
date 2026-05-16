-- Sprint 9 Etappe 9.1: entity_links table
-- Stores document links (SharePoint + local) previously in links.json

CREATE TABLE IF NOT EXISTS entity_links (
  id            SERIAL PRIMARY KEY,
  link_code     TEXT NOT NULL UNIQUE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('sharepoint', 'local')),
  label         TEXT NOT NULL DEFAULT '',
  sp_item_id    TEXT,
  sp_drive_id   TEXT,
  sp_name       TEXT,
  sp_web_url    TEXT,
  local_path    TEXT,
  local_name    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_links_entity
  ON entity_links (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_links_doc_type
  ON entity_links (doc_type);
