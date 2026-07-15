-- Migration 042: owner_memory + conversation_log extraction columns
-- Module: memory | Version: 42
-- Boot-Time-DDL: idempotent, automatisch bei jedem Gateway-Start

-- conversation_log: neue Spalten fuer Extraktions-Job-Tracking
ALTER TABLE conversation_log
  ADD COLUMN IF NOT EXISTS memory_extract_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS memory_extract_attempts INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS memory_extract_last_error TEXT,
  ADD COLUMN IF NOT EXISTS memory_extracted_at TIMESTAMPTZ;

-- CHECK constraint via separate statement (idempotent)
DO $$ BEGIN
  ALTER TABLE conversation_log
    ADD CONSTRAINT chk_memory_extract_status
    CHECK (memory_extract_status IN ('pending','done','failed','skipped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- owner_memory: Fakten-Speicher
CREATE TABLE IF NOT EXISTS owner_memory (
  id                BIGSERIAL PRIMARY KEY,
  owner_sender_id   TEXT NOT NULL,
  fact              TEXT NOT NULL CHECK (length(trim(fact)) > 0),
  fact_norm         TEXT NOT NULL,
  fact_hash         TEXT NOT NULL,
  category          TEXT CHECK (category IN
    ('person','preference','project','health','business','other')),
  sensitivity       TEXT DEFAULT 'normal' CHECK (sensitivity IN
    ('normal','sensitive','never_inject')),
  evidence_quote    TEXT,
  source_log_id     BIGINT REFERENCES conversation_log(id) ON DELETE SET NULL,
  confidence        REAL CHECK (confidence BETWEEN 0 AND 1),
  status            TEXT DEFAULT 'active' CHECK (status IN
    ('active','superseded','rejected')),
  supersedes_id     BIGINT REFERENCES owner_memory(id),
  model_used        TEXT,
  prompt_version    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: only one active fact per hash
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_memory_fact_hash_active
  ON owner_memory (fact_hash) WHERE status = 'active';

-- Query index for recall
CREATE INDEX IF NOT EXISTS idx_owner_memory_status_category
  ON owner_memory (status, category);

INSERT INTO schema_version (module, version)
VALUES ('memory', 42)
ON CONFLICT DO NOTHING;
