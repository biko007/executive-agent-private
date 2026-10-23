-- V041 — Kontostatus „neu" und Auszugssalden (Owner-Freigabe 23.10.2026 21:40
-- „Freigabe Paket Abend", report-banking-paket-abend-20261023; Rote Zone, /arm).
--
-- 1. banking_accounts.status 'neu' — Beim Verbinden am 23.10.2026 meldete die
--    KSK sechs Konten erstmals (vier Kautionskonten, ein Darlehen, ein
--    Stromkonto). Sie wurden sofort aktiv angelegt und zählten in die
--    Kontensumme, das Darlehen mit −638.625,53 €. Künftig legt das Verbinden
--    neue Konten als 'neu' an: ausgeblendet, nicht abgerufen, nicht in Summen,
--    bis der Owner sie zuordnet.
--
-- 2. banking_statement_balances — Anfangs- und Endsaldo je MT940-Auszug mit
--    Umsatzzahl, Umsatzsumme und Probe. Bisher ging nur der erste Anfangs- und
--    der letzte Endsaldo eines Abrufs in die Saldenprobe; eine Abweichung ließ
--    sich keinem Auszug zuordnen.

ALTER TABLE banking_accounts DROP CONSTRAINT IF EXISTS banking_accounts_status_check;
ALTER TABLE banking_accounts ADD CONSTRAINT banking_accounts_status_check
  CHECK (status IN ('active', 'archived', 'neu'));

CREATE TABLE IF NOT EXISTS banking_statement_balances (
  id             BIGSERIAL PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES banking_accounts(id) ON DELETE CASCADE,
  -- Anfangssaldo gilt ab Ende dieses Tages (bei der KSK der Vortag der ersten
  -- Buchung, siehe _auszuege_auswerten im Sidecar)
  anfang_datum   DATE NOT NULL,
  anfang         NUMERIC(14,2) NOT NULL,
  schluss_datum  DATE NOT NULL,
  schluss        NUMERIC(14,2) NOT NULL,
  umsaetze       INT NOT NULL,
  summe          NUMERIC(14,2) NOT NULL,
  -- anfang + summe − schluss; ≠ 0 heißt: Lieferung dieses Auszugs lückenhaft
  probe          NUMERIC(14,2) NOT NULL,
  quelle         TEXT NOT NULL CHECK (quelle IN ('verbinden', 'abgleich', 'pruefung')),
  abgerufen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, anfang_datum, schluss_datum, anfang, schluss)
);

CREATE INDEX IF NOT EXISTS idx_statement_balances_konto
  ON banking_statement_balances(account_id, schluss_datum DESC);

CREATE INDEX IF NOT EXISTS idx_statement_balances_abweichung
  ON banking_statement_balances(account_id) WHERE probe <> 0;

INSERT INTO schema_version (module, version) VALUES ('banking', 41)
  ON CONFLICT (module, version) DO NOTHING;
