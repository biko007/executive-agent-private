-- V030__assets_extension.sql — Sprint 5d.1 Assets-Erweiterung
-- Drei nullable Spalten fuer Stammdaten + NK-PDF:
--   properties.legal_owner   — Vermieter-Bezeichnung
--   leases.garage_amount     — monatliche Garage-Komponente
--   leases.kitchen_amount    — monatliche Kueche-Komponente

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS legal_owner VARCHAR(200) NULL;

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS garage_amount NUMERIC(10,2) NULL,
  ADD COLUMN IF NOT EXISTS kitchen_amount NUMERIC(10,2) NULL;

CREATE INDEX IF NOT EXISTS properties_legal_owner_idx
  ON properties (legal_owner) WHERE legal_owner IS NOT NULL;

-- ── Record migration ────────────────────────────────────────────────────────
INSERT INTO schema_version (module, version) VALUES ('assets', 30)
  ON CONFLICT (module, version) DO NOTHING;
