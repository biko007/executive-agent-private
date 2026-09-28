-- Modul wiki, Version 1 — Ablösung des JSPWiki bei Nuveon (asp.nuveon.de/biko).
--
-- Drei Tabellen:
--   wiki_pages           Inhaltsseiten (Markdown + Originalmarkup)
--   wiki_page_revisions  Revisionshistorie (Import = Rev 1, jedes Speichern = neue Rev)
--   wiki_attachments     Anhänge mit Prüfsumme, Vorschau und extrahiertem PDF-Text
--
-- Volltextsuche: generierte tsvector-Spalten mit deutscher Konfiguration.
-- to_tsvector(regconfig, text) ist IMMUTABLE und daher in generierten Spalten
-- zulässig — die einargumentige Variante wäre nur STABLE und würde scheitern.

CREATE TABLE IF NOT EXISTS wiki_pages (
  id                 SERIAL PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  category           TEXT NOT NULL DEFAULT 'Sonstiges',
  body_md            TEXT NOT NULL DEFAULT '',
  source_markup      TEXT,
  sensitive          BOOLEAN NOT NULL DEFAULT FALSE,
  source             TEXT NOT NULL DEFAULT 'local'
                       CHECK (source IN ('nuveon', 'local')),
  -- Originalname der JSPWiki-Seite; nötig, um Anhang-Pfade und alte
  -- Wiki-Links nach dem Import noch auflösen zu können.
  source_page_name   TEXT,
  source_author      TEXT,
  source_modified_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_tsv         tsvector GENERATED ALWAYS AS (
                       to_tsvector('german'::regconfig,
                         coalesce(title, '') || ' ' || coalesce(body_md, ''))
                     ) STORED
);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_search
  ON wiki_pages USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_category
  ON wiki_pages (category);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_sensitive
  ON wiki_pages (sensitive);

CREATE TABLE IF NOT EXISTS wiki_page_revisions (
  id         SERIAL PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  rev        INTEGER NOT NULL,
  title      TEXT,
  body_md    TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (page_id, rev)
);

CREATE INDEX IF NOT EXISTS idx_wiki_revisions_page
  ON wiki_page_revisions (page_id, rev DESC);

CREATE TABLE IF NOT EXISTS wiki_attachments (
  id                 SERIAL PRIMARY KEY,
  page_id            INTEGER NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  filename           TEXT NOT NULL,
  mime               TEXT NOT NULL DEFAULT 'application/octet-stream',
  size               BIGINT NOT NULL DEFAULT 0,
  sha256             TEXT,
  -- Alle Pfade relativ zu artifacts/personal/wiki/ — nie absolut, damit ein
  -- Restore an anderer Stelle nicht die Datenbank nachziehen muss.
  path               TEXT NOT NULL,
  preview_path       TEXT,
  thumb_path         TEXT,
  text_content       TEXT,
  source_author      TEXT,
  source_modified_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_tsv         tsvector GENERATED ALWAYS AS (
                       to_tsvector('german'::regconfig,
                         coalesce(filename, '') || ' ' || coalesce(text_content, ''))
                     ) STORED,
  UNIQUE (page_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_wiki_attachments_page
  ON wiki_attachments (page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_attachments_search
  ON wiki_attachments USING GIN (search_tsv);

-- ── GRANTs für Rolle openclaw ───────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON wiki_pages TO openclaw;
GRANT SELECT, INSERT, UPDATE, DELETE ON wiki_page_revisions TO openclaw;
GRANT SELECT, INSERT, UPDATE, DELETE ON wiki_attachments TO openclaw;
GRANT USAGE, SELECT ON SEQUENCE wiki_pages_id_seq TO openclaw;
GRANT USAGE, SELECT ON SEQUENCE wiki_page_revisions_id_seq TO openclaw;
GRANT USAGE, SELECT ON SEQUENCE wiki_attachments_id_seq TO openclaw;
