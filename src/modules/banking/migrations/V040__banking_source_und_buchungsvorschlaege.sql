-- V040 — Herkunft von Bankumsätzen und Buchungsvorschläge (Paket 3, Teile 3 und 5)
-- Owner-Freigabe 10.10.2026 (Rote Zone, /arm push).
--
-- Zwei Änderungen in einer Datei, damit nur EIN armierter Push nötig ist:
--
-- 1. banking_transactions.source — Bisher konnten Umsätze ausschließlich aus
--    der FinTS-Synchronisierung kommen. Der Bestand endete deshalb am
--    29.06.2026, obwohl die Kontoauszüge als PDF vorlagen. Ohne eine
--    Herkunftsspalte liesse sich ein nachträglich eingelesener Umsatz später
--    nicht mehr von einem synchronisierten unterscheiden — und damit auch
--    nicht gezielt zurücknehmen.
--
-- 2. expense_booking_proposals — Buchungsvorschläge aus Bankumsätzen. Sie sind
--    Bewegungsdaten mit Lebenszyklus (offen → bestätigt oder verworfen) und
--    gehören deshalb in die Datenbank, nicht in eine JSON-Datei: nur so gibt
--    es Fremdschlüssel, Audit-Spur und eine Abfrage, die den Namen verdient.
--    Die REGELN, nach denen Vorschläge entstehen, liegen dagegen bewusst in
--    system_settings.expense_rules — die ändert der Owner ohne Deployment.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Herkunft der Bankumsätze
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE banking_transactions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'fints';

COMMENT ON COLUMN banking_transactions.source IS
  'Herkunft: fints = Synchronisierung mit der Bank, pdf_import = aus einem Kontoauszug eingelesen.';

CREATE INDEX IF NOT EXISTS idx_banking_transactions_source
  ON banking_transactions(source) WHERE source <> 'fints';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Buchungsvorschläge
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS expense_booking_proposals (
  id                    SERIAL PRIMARY KEY,
  property_id           INT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  transaction_id        BIGINT REFERENCES banking_transactions(id) ON DELETE SET NULL,
  -- Kennung der Regel aus system_settings.expense_rules; kein Fremdschlüssel,
  -- weil die Regeln bewusst ausserhalb des Schemas gepflegt werden.
  rule_id               TEXT NOT NULL,
  cost_category_id      INT NOT NULL REFERENCES cost_categories(id),
  vendor_name           TEXT,
  booking_date          DATE NOT NULL,
  -- Betrag, der gebucht würde: Zahlbetrag mal Anteil.
  amount_gross          NUMERIC(12,2) NOT NULL,
  -- Anteil des Objekts am Zahlbetrag. 1 = ganz. Die Gebäudeversicherung von
  -- MG24 läuft z. B. mit 0.98200, weil die Police Marktgasse 22 mitversichert.
  anteil                NUMERIC(7,5) NOT NULL DEFAULT 1,
  service_period_start  DATE,
  service_period_end    DATE,
  umlagefaehig          BOOLEAN NOT NULL,
  sicherheit            TEXT NOT NULL CHECK (sicherheit IN ('hoch','mittel','niedrig')),
  begruendung           TEXT,
  reference             TEXT,
  status                TEXT NOT NULL CHECK (status IN ('offen','bestaetigt','verworfen')) DEFAULT 'offen',
  expense_booking_id    INT REFERENCES expense_bookings(id) ON DELETE SET NULL,
  entschieden_am        TIMESTAMPTZ,
  entschieden_von       TEXT,
  notiz                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (service_period_end IS NULL OR service_period_start IS NULL
         OR service_period_end >= service_period_start),
  CHECK (status <> 'bestaetigt' OR expense_booking_id IS NOT NULL)
);

-- Ein Umsatz darf je Regel nur einen Vorschlag erzeugen — sonst entstünde bei
-- jedem Lauf des Bankabgleichs derselbe Vorschlag erneut.
CREATE UNIQUE INDEX IF NOT EXISTS uq_proposal_tx_rule
  ON expense_booking_proposals(transaction_id, rule_id)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proposals_offen
  ON expense_booking_proposals(property_id, booking_date DESC)
  WHERE status = 'offen';

DROP TRIGGER IF EXISTS trg_proposals_updated_at ON expense_booking_proposals;
CREATE TRIGGER trg_proposals_updated_at BEFORE UPDATE ON expense_booking_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Migration vermerken
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO schema_version (module, version) VALUES ('banking', 40)
  ON CONFLICT (module, version) DO NOTHING;
