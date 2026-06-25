-- V038: Widen banking_transactions.transaction_code from VARCHAR(20) to VARCHAR(50).
-- Grund: Deutsche SEPA-Buchungstexte (z.B. "SEPA-Überweisung") können > 20 Zeichen sein.
-- Reine Typ-Erweiterung — keine Datenänderung, kein Rewrite nötig (Postgres widening).

ALTER TABLE banking_transactions
  ALTER COLUMN transaction_code TYPE VARCHAR(50);

-- ── Record migration ────────────────────────────────────────────────────────
INSERT INTO schema_version (module, version) VALUES ('banking', 38)
  ON CONFLICT (module, version) DO NOTHING;
