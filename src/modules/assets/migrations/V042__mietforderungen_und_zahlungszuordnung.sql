-- V042 — Mietforderungen, Zahlungszuordnung und Dublettenmarkierung
--
-- Owner-Auftrag 15.10.2026: Aus den Mietvertraegen monatliche Forderungen
-- ableiten, sie mit den FinTS-Umsaetzen abgleichen und je Mieter und Objekt
-- ein Laempchen zeigen. Dazu kommt die Berichtigung der Umsatzanzeige.
--
-- Fuenf Aenderungen, alle additiv. Nichts wird geloescht, keine Spalte entfaellt.

-- ---------------------------------------------------------------------------
-- 1. Hauptmieter des Eigentuemers als VERTRAGSMERKMAL
--
-- Vier Einheiten bewohnt oder nutzt der Eigentuemer selbst (L19 W3, L19 W4+,
-- N24 W3, N24 W4). Eine Forderung wird auch dort erzeugt, sie gilt aber immer
-- als bezahlt. Das steht bewusst am Vertrag und nicht als Liste im Code: Die
-- L19-Einheiten werden demnaechst umgewandelt, dann faellt das Merkmal weg,
-- ohne dass jemand Code aendern muss.
-- ---------------------------------------------------------------------------
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS owner_hauptmieter boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN leases.owner_hauptmieter IS
  'Einheit des Eigentuemers: Forderung wird erzeugt, gilt aber stets als bezahlt (Laempchen gruen).';

-- ---------------------------------------------------------------------------
-- 2. Forderungen mit ihren Bestandteilen
--
-- rent_ledger gab es schon, aber nur mit einem Gesamtbetrag. Der Owner will
-- die Bestandteile getrennt sehen — Grundmiete, Betriebskosten, Heizkosten,
-- Garage, Kueche —, weil die Dashboard-Anzeige bisher nur die Kaltmiete zeigte.
-- ---------------------------------------------------------------------------
ALTER TABLE rent_ledger
  ADD COLUMN IF NOT EXISTS kaltmiete_amount   numeric(12,2),
  ADD COLUMN IF NOT EXISTS nk_amount          numeric(12,2),
  ADD COLUMN IF NOT EXISTS heizkosten_amount  numeric(12,2),
  ADD COLUMN IF NOT EXISTS garage_amount      numeric(12,2),
  ADD COLUMN IF NOT EXISTS kitchen_amount     numeric(12,2),
  -- Anteil des Monats, den der Vertrag abdeckt: 1.0000 = ganzer Monat.
  ADD COLUMN IF NOT EXISTS anteil             numeric(6,4) NOT NULL DEFAULT 1.0000,
  -- true = aus dem Vertrag erzeugt, false = von Hand erfasst (die sieben
  -- Rueckstaende vom 15.10.2026 bleiben damit als Handeintrag erkennbar).
  ADD COLUMN IF NOT EXISTS erzeugt            boolean NOT NULL DEFAULT false,
  -- Owner-Einheit: gilt als bezahlt, ohne dass ein Umsatz existiert.
  ADD COLUMN IF NOT EXISTS gilt_als_bezahlt   boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN rent_ledger.anteil IS
  'Anteil des Monats laut Vertragslaufzeit, kaufmaennisch auf Tage gerechnet.';

-- ---------------------------------------------------------------------------
-- 3. Bekannte Zahler je Vertrag
--
-- Nicht immer zahlt der Mieter selbst. Bei I83 W1 ueberweisen Noah Mainz und
-- Anna Cumming fuer Cambier/Jacobs. Ohne diese Tabelle bliebe der Eingang
-- "nicht zugeordnet", und geraten wird nicht.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lease_payers (
  id          serial PRIMARY KEY,
  lease_id    integer NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  iban        varchar(34),
  name        text,
  notes       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lease_payers_iban_oder_name CHECK (iban IS NOT NULL OR name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS lease_payers_lease_idx ON lease_payers(lease_id);
CREATE INDEX IF NOT EXISTS lease_payers_iban_idx  ON lease_payers(iban) WHERE iban IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Zuordnung Umsatz -> Forderung
--
-- Eine Zahlung kann mehrere Monate decken, ein Monat kann aus mehreren
-- Zahlungen zusammenkommen (De Meo Juli/August 2025). Deshalb eine eigene
-- Verknuepfungstabelle statt eines Feldes an der Forderung.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rent_payment_links (
  id              serial PRIMARY KEY,
  rent_ledger_id  integer NOT NULL REFERENCES rent_ledger(id) ON DELETE CASCADE,
  transaction_id  bigint  NOT NULL REFERENCES banking_transactions(id) ON DELETE RESTRICT,
  amount          numeric(12,2) NOT NULL,
  -- Woran die Zuordnung haengt: iban | name_zweck | manuell
  grundlage       text NOT NULL DEFAULT 'iban',
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_payment_links_grundlage_check
    CHECK (grundlage IN ('iban','name_zweck','manuell','owner_hauptmieter')),
  CONSTRAINT rent_payment_links_einmal UNIQUE (rent_ledger_id, transaction_id)
);
CREATE INDEX IF NOT EXISTS rent_payment_links_tx_idx ON rent_payment_links(transaction_id);

-- ---------------------------------------------------------------------------
-- 5. Dublettenmarkierung bei den Bankumsaetzen
--
-- Befund 15.10.2026: 40 Umsaetze stehen doppelt im Bestand — einmal aus dem
-- Kontoauszug (pdf_import), einmal aus der FinTS-Synchronisierung. Die
-- Eindeutigkeit haengt an bank_transaction_id, und die unterscheidet sich je
-- Quelle. GELOESCHT WIRD NICHTS: Die unterlegene Zeile bekommt einen Verweis
-- auf die fuehrende und verschwindet nur aus der Anzeige.
-- ---------------------------------------------------------------------------
ALTER TABLE banking_transactions
  ADD COLUMN IF NOT EXISTS duplicate_of bigint REFERENCES banking_transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS banking_transactions_duplicate_idx
  ON banking_transactions(duplicate_of) WHERE duplicate_of IS NOT NULL;

COMMENT ON COLUMN banking_transactions.duplicate_of IS
  'Zeigt auf den fuehrenden Umsatz derselben Buchung. Gesetzt = aus der Anzeige nehmen, nicht loeschen.';

-- ---------------------------------------------------------------------------
-- 5. updated_at bei banking_transactions NACHTRAGEN
--
-- V027 hat die Tabelle ohne updated_at angelegt, ihr aber den Trigger
-- trg_banking_transactions_updated_at mit set_updated_at() gegeben. Die
-- Funktion setzt NEW.updated_at — die Spalte fehlt. Folge: JEDE Aenderung an
-- banking_transactions bricht mit
--   ERROR: record "new" has no field "updated_at"
-- ab. Das ist bisher niemandem aufgefallen, weil Umsaetze nur eingefuegt und
-- nie geaendert wurden. Mit duplicate_of (Punkt 4) und der Korrektur der elf
-- Auszugszeilen mit vertauschten Feldern wird erstmals geaendert; ohne diese
-- Spalte scheitert beides.
--
-- Die drei uebrigen Banking-Tabellen aus V027 haben die Spalte; hier wird nur
-- nachgezogen, was dort schon steht.
-- ---------------------------------------------------------------------------
ALTER TABLE banking_transactions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Schema-Version fortschreiben.
INSERT INTO schema_version (module, version, applied_at)
VALUES ('assets', 42, now())
ON CONFLICT (module, version) DO NOTHING;
