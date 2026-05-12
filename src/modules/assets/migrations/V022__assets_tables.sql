-- V022__assets_tables.sql — Assets module tables (Sprint 5, Spec §3)
-- Applied to: openclaw_core database
-- 14 Tabellen: 7 befüllt (Sprint 5) + 7 leer (Sprint 6/7)
-- Idempotent: uses IF NOT EXISTS / CREATE OR REPLACE where possible

-- ── updated_at trigger function (shared, CREATE OR REPLACE) ──────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════════════════════
-- STAMMDATEN (Sprint 5 — mit Daten gefüllt)
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Properties ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id                          SERIAL PRIMARY KEY,
  code                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  street                      TEXT,
  postal_code                 TEXT,
  city                        TEXT,
  property_type               TEXT NOT NULL CHECK (property_type IN ('residential','commercial','mixed','industrial')),
  ownership_start             DATE,
  acquisition_date            DATE,
  purchase_price_total        NUMERIC(14,2),
  building_value              NUMERIC(14,2),
  land_value                  NUMERIC(14,2),
  afa_rate                    NUMERIC(5,3),
  total_living_area_qm        NUMERIC(10,2),
  total_commercial_area_qm    NUMERIC(10,2),
  billing_period_start_month  INT DEFAULT 1 CHECK (billing_period_start_month BETWEEN 1 AND 12),
  heating_type                TEXT CHECK (heating_type IN ('gas','oil','heat_pump','district','electric','none')),
  co2_cost_relevant           BOOLEAN DEFAULT true,
  notes                       TEXT,
  active                      BOOLEAN NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_properties_updated_at ON properties;
CREATE TRIGGER trg_properties_updated_at BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. Units ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS units (
  id                  SERIAL PRIMARY KEY,
  property_id         INT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  code                TEXT NOT NULL,
  unit_type           TEXT NOT NULL CHECK (unit_type IN ('apartment','garage','storage','office','retail','industrial_hall')),
  floor               TEXT,
  living_area_qm      NUMERIC(10,2),
  usable_area_qm      NUMERIC(10,2),
  allocation_area_qm  NUMERIC(10,2),
  rooms               NUMERIC(3,1),
  has_balcony         BOOLEAN DEFAULT false,
  has_heating         BOOLEAN DEFAULT true,
  vacant_from         DATE,
  vacant_until        DATE,
  notes               TEXT,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

DROP TRIGGER IF EXISTS trg_units_updated_at ON units;
CREATE TRIGGER trg_units_updated_at BEFORE UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 3. Tenants ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id                       SERIAL PRIMARY KEY,
  tenant_code              TEXT UNIQUE,
  tenant_type              TEXT NOT NULL CHECK (tenant_type IN ('person','company')) DEFAULT 'person',
  first_name               TEXT,
  last_name                TEXT,
  birth_date               DATE,
  company_name             TEXT,
  contact_person           TEXT,
  ust_id                   TEXT,
  street                   TEXT,
  postal_code              TEXT,
  city                     TEXT,
  phone                    TEXT,
  email                    TEXT,
  iban                     TEXT,
  bic                      TEXT,
  bank                     TEXT,
  debitor_no               TEXT,
  sepa_mandate_reference   TEXT,
  sepa_mandate_signed_at   DATE,
  correspondence_address   TEXT,
  active                   BOOLEAN NOT NULL DEFAULT true,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (tenant_type='person' AND last_name IS NOT NULL) OR
    (tenant_type='company' AND company_name IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS trg_tenants_updated_at ON tenants;
CREATE TRIGGER trg_tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_tenants_last_name ON tenants(last_name) WHERE last_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_company ON tenants(company_name) WHERE company_name IS NOT NULL;

-- ── 4. Leases ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leases (
  id                          SERIAL PRIMARY KEY,
  lease_number                TEXT UNIQUE,
  unit_id                     INT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  lease_type                  TEXT NOT NULL CHECK (lease_type IN ('residential','temporary','commercial','garage','storage')),
  status                      TEXT NOT NULL CHECK (status IN ('draft','active','terminated','ended','unverified_legacy')) DEFAULT 'active',
  signed_at                   DATE,
  start_date                  DATE NOT NULL,
  handover_at                 DATE,
  end_date                    DATE,
  termination_date            DATE,
  termination_reason          TEXT,
  actual_move_out             DATE,
  billing_mode                TEXT CHECK (billing_mode IN ('vorauszahlung','pauschale','inklusive')),
  kaltmiete                   NUMERIC(10,2),
  nk_vorauszahlung            NUMERIC(10,2),
  heizkosten_vorauszahlung    NUMERIC(10,2),
  kaution                     NUMERIC(10,2),
  payment_method              TEXT CHECK (payment_method IN ('bank_transfer','sepa_direct_debit','cash','other')),
  rent_due_day                INT CHECK (rent_due_day BETWEEN 1 AND 31),
  vat_option                  BOOLEAN NOT NULL DEFAULT false,
  vat_rate                    NUMERIC(5,2),
  contract_document_path      TEXT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (termination_date IS NULL OR termination_date >= start_date),
  CHECK (actual_move_out IS NULL OR actual_move_out >= start_date),
  CHECK ((vat_option = false AND vat_rate IS NULL) OR (vat_option = true AND vat_rate IS NOT NULL))
);

DROP TRIGGER IF EXISTS trg_leases_updated_at ON leases;
CREATE TRIGGER trg_leases_updated_at BEFORE UPDATE ON leases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_leases_unit_active ON leases(unit_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_leases_unit_status ON leases(unit_id, status);

-- ── 5. Lease-Tenants Junction ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lease_tenants (
  id                  SERIAL PRIMARY KEY,
  lease_id            INT NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  tenant_id           INT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  role                TEXT NOT NULL CHECK (role IN ('contract_party','occupant','guarantor')) DEFAULT 'contract_party',
  is_primary_contact  BOOLEAN NOT NULL DEFAULT false,
  valid_from          DATE NOT NULL,
  valid_until         DATE,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE INDEX IF NOT EXISTS idx_lease_tenants_lease ON lease_tenants(lease_id, valid_until);
CREATE INDEX IF NOT EXISTS idx_lease_tenants_tenant ON lease_tenants(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lease_primary ON lease_tenants(lease_id)
  WHERE is_primary_contact = true AND valid_until IS NULL;

-- ── 6. Cost Categories (BetrKV §2 Nr. 1-17 + Steuer) ─────────────────────
CREATE TABLE IF NOT EXISTS cost_categories (
  id                       SERIAL PRIMARY KEY,
  code                     TEXT NOT NULL UNIQUE,
  name                     TEXT NOT NULL,
  betrkv_reference         TEXT,
  umlagefaehig_default     BOOLEAN NOT NULL,
  tax_category             TEXT CHECK (tax_category IN ('werbungskosten','erhaltungsaufwand','herstellungskosten','schuldzinsen','afa','sonstiges')),
  requires_consumption     BOOLEAN DEFAULT false,
  heating_cost_relevant    BOOLEAN DEFAULT false,
  co2_relevant             BOOLEAN DEFAULT false,
  active                   BOOLEAN NOT NULL DEFAULT true,
  sort_order               INT,
  notes                    TEXT
);

-- Pre-Seed: 23 Einträge (BetrKV §2 Nr. 1-17 + 6 Nicht-BetrKV)
INSERT INTO cost_categories (code, name, betrkv_reference, umlagefaehig_default, tax_category, requires_consumption, heating_cost_relevant, co2_relevant, sort_order) VALUES
  ('grundsteuer',                     'Grundsteuer',                              'BetrKV §2 Nr. 1',  true,  'werbungskosten',     false, false, false,  1),
  ('wasser',                          'Wasserversorgung',                         'BetrKV §2 Nr. 2',  true,  'werbungskosten',     false, false, false,  2),
  ('entwaesserung',                   'Entwässerung',                             'BetrKV §2 Nr. 3',  true,  'werbungskosten',     false, false, false,  3),
  ('heizung',                         'Heizung',                                  'BetrKV §2 Nr. 4',  true,  'werbungskosten',     true,  true,  true,   4),
  ('warmwasser',                      'Warmwasser',                               'BetrKV §2 Nr. 5',  true,  'werbungskosten',     true,  true,  true,   5),
  ('verbundene_heizung_warmwasser',   'Verbundene Heizungs-/Warmwasseranlagen',   'BetrKV §2 Nr. 6',  true,  'werbungskosten',     true,  true,  true,   6),
  ('aufzug',                          'Aufzug',                                   'BetrKV §2 Nr. 7',  true,  'werbungskosten',     false, false, false,  7),
  ('strassenreinigung_muell',         'Straßenreinigung und Müllbeseitigung',     'BetrKV §2 Nr. 8',  true,  'werbungskosten',     false, false, false,  8),
  ('gebaeudereinigung',               'Gebäudereinigung/Ungeziefer',              'BetrKV §2 Nr. 9',  true,  'werbungskosten',     false, false, false,  9),
  ('gartenpflege',                    'Gartenpflege',                             'BetrKV §2 Nr. 10', true,  'werbungskosten',     false, false, false, 10),
  ('beleuchtung',                     'Beleuchtung',                              'BetrKV §2 Nr. 11', true,  'werbungskosten',     false, false, false, 11),
  ('schornstein',                     'Schornsteinreinigung',                     'BetrKV §2 Nr. 12', true,  'werbungskosten',     false, false, false, 12),
  ('versicherung',                    'Sach-/Haftpflichtversicherung',            'BetrKV §2 Nr. 13', true,  'werbungskosten',     false, false, false, 13),
  ('hauswart',                        'Hauswart',                                 'BetrKV §2 Nr. 14', true,  'werbungskosten',     false, false, false, 14),
  ('antenne_kabel',                   'Antenne/Breitband',                        'BetrKV §2 Nr. 15', true,  'werbungskosten',     false, false, false, 15),
  ('waeschepflege',                   'Wäschepflege/Waschmaschinen',              'BetrKV §2 Nr. 16', true,  'werbungskosten',     false, false, false, 16),
  ('sonstige_betrkv',                 'Sonstige Betriebskosten',                  'BetrKV §2 Nr. 17', false, 'werbungskosten',     false, false, false, 17),
  ('instandhaltung',                  'Instandhaltung/Reparatur',                 NULL,                false, 'erhaltungsaufwand',  false, false, false, 18),
  ('modernisierung',                  'Modernisierung',                           NULL,                false, 'herstellungskosten', false, false, false, 19),
  ('verwaltung',                      'Verwaltungskosten',                        NULL,                false, 'werbungskosten',     false, false, false, 20),
  ('schuldzinsen',                    'Schuldzinsen',                             NULL,                false, 'schuldzinsen',       false, false, false, 21),
  ('afa',                             'AfA Gebäude',                              NULL,                false, 'afa',                false, false, false, 22),
  ('leerstand',                       'Leerstandskosten',                         NULL,                false, 'werbungskosten',     false, false, false, 23)
ON CONFLICT (code) DO NOTHING;

-- ── 7. Expense Bookings ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_bookings (
  id                          SERIAL PRIMARY KEY,
  source_key                  TEXT,
  property_id                 INT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  unit_id                     INT REFERENCES units(id) ON DELETE RESTRICT,
  cost_category_id            INT NOT NULL REFERENCES cost_categories(id),
  vendor_name                 TEXT,
  invoice_number              TEXT,
  invoice_date                DATE,
  service_period_start        DATE,
  service_period_end          DATE,
  payment_date                DATE,
  amount_gross                NUMERIC(12,2) NOT NULL,
  amount_net                  NUMERIC(12,2),
  vat_amount                  NUMERIC(12,2),
  vat_rate                    NUMERIC(5,2),
  umlagefaehig                BOOLEAN NOT NULL,
  maintenance_vs_operating    TEXT CHECK (maintenance_vs_operating IN ('operating','maintenance','improvement','interest','depreciation','other')) DEFAULT 'operating',
  document_path               TEXT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (service_period_end IS NULL OR service_period_end >= service_period_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_source_key ON expense_bookings(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expense_property_period ON expense_bookings(property_id, service_period_start);
CREATE INDEX IF NOT EXISTS idx_expense_property_payment ON expense_bookings(property_id, payment_date);
CREATE INDEX IF NOT EXISTS idx_expense_property_invoice ON expense_bookings(property_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_expense_property_category ON expense_bookings(property_id, cost_category_id);

DROP TRIGGER IF EXISTS trg_expense_bookings_updated_at ON expense_bookings;
CREATE TRIGGER trg_expense_bookings_updated_at BEFORE UPDATE ON expense_bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- LEERE TABELLEN (Sprint 6/7 — nur Schema, keine Daten, kein TypeScript)
-- ════════════════════════════════════════════════════════════════════════════

-- ── 8. Lease Charges ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lease_charges (
  id            SERIAL PRIMARY KEY,
  lease_id      INT NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  charge_type   TEXT NOT NULL CHECK (charge_type IN ('base_rent','operating_cost_prepayment','heating_prepayment','garage_rent','vat')),
  amount        NUMERIC(10,2) NOT NULL,
  vat_rate      NUMERIC(5,2),
  valid_from    DATE NOT NULL,
  valid_until   DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

-- ── 9. Rent Ledger ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rent_ledger (
  id                    SERIAL PRIMARY KEY,
  lease_id              INT NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  period_month          DATE NOT NULL,
  due_date              DATE NOT NULL,
  expected_amount       NUMERIC(10,2) NOT NULL,
  paid_amount           NUMERIC(10,2) DEFAULT 0,
  payment_date          DATE,
  booking_text          TEXT,
  status                TEXT NOT NULL CHECK (status IN ('open','paid','partial','overdue')) DEFAULT 'open',
  bank_transaction_id   TEXT,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lease_id, period_month)
);

DROP TRIGGER IF EXISTS trg_rent_ledger_updated_at ON rent_ledger;
CREATE TRIGGER trg_rent_ledger_updated_at BEFORE UPDATE ON rent_ledger
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 10. Security Deposits ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_deposits (
  id                   SERIAL PRIMARY KEY,
  lease_id             INT NOT NULL REFERENCES leases(id) ON DELETE RESTRICT UNIQUE,
  agreed_amount        NUMERIC(10,2) NOT NULL,
  due_amount           NUMERIC(10,2),
  paid_amount          NUMERIC(10,2) DEFAULT 0,
  deposit_account      TEXT,
  interest_amount      NUMERIC(10,2) DEFAULT 0,
  returned_at          DATE,
  deductions_amount    NUMERIC(10,2) DEFAULT 0,
  status               TEXT NOT NULL CHECK (status IN ('unknown','open','partial','paid','returned','partially_returned')) DEFAULT 'unknown',
  payment_dates        JSONB,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_security_deposits_updated_at ON security_deposits;
CREATE TRIGGER trg_security_deposits_updated_at BEFORE UPDATE ON security_deposits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 11. Meters ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meters (
  id                          SERIAL PRIMARY KEY,
  scope_type                  TEXT NOT NULL CHECK (scope_type IN ('property','unit')),
  property_id                 INT REFERENCES properties(id) ON DELETE RESTRICT,
  unit_id                     INT REFERENCES units(id) ON DELETE RESTRICT,
  medium                      TEXT NOT NULL CHECK (medium IN ('cold_water','warm_water','heat','electricity','gas')),
  meter_number                TEXT NOT NULL,
  provider                    TEXT,
  installed_at                DATE,
  removed_at                  DATE,
  calibration_valid_until     DATE,
  is_main_meter               BOOLEAN DEFAULT false,
  parent_meter_id             INT REFERENCES meters(id),
  initial_reading             NUMERIC(12,3),
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (scope_type='property' AND property_id IS NOT NULL AND unit_id IS NULL) OR
    (scope_type='unit'     AND unit_id IS NOT NULL AND property_id IS NULL)
  ),
  CHECK (parent_meter_id IS NULL OR parent_meter_id != id)
);

CREATE INDEX IF NOT EXISTS idx_meters_property ON meters(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meters_unit ON meters(unit_id) WHERE unit_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_meters_updated_at ON meters;
CREATE TRIGGER trg_meters_updated_at BEFORE UPDATE ON meters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 12. Meter Readings ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meter_readings (
  id                  SERIAL PRIMARY KEY,
  meter_id            INT NOT NULL REFERENCES meters(id) ON DELETE RESTRICT,
  value               NUMERIC(12,3) NOT NULL CHECK (value >= 0),
  unit                TEXT NOT NULL,
  reading_type        TEXT CHECK (reading_type IN ('annual','move_in','move_out','interim','automatic')) DEFAULT 'annual',
  period_start        DATE,
  period_end          DATE,
  read_at             TIMESTAMPTZ NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('manual','automatic')),
  reader_name         TEXT,
  document_path       TEXT,
  source_reference    TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meter_readings_meter ON meter_readings(meter_id, read_at DESC);

-- ── 13. Allocation Rules ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS allocation_rules (
  id                          SERIAL PRIMARY KEY,
  property_id                 INT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  cost_category_id            INT NOT NULL REFERENCES cost_categories(id),
  key_type                    TEXT NOT NULL CHECK (key_type IN ('sqm','persons','units','consumption','heating_split','fixed')),
  base_share_percent          NUMERIC(5,2) CHECK (base_share_percent BETWEEN 0 AND 100),
  consumption_share_percent   NUMERIC(5,2) CHECK (consumption_share_percent BETWEEN 0 AND 100),
  valid_from                  DATE NOT NULL,
  valid_until                 DATE,
  source                      TEXT,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  -- HeizkostenV §7: bei heating_split müssen Grund- + Verbrauchsanteil zusammen 100% sein
  CHECK (
    key_type != 'heating_split' OR
    (base_share_percent IS NOT NULL AND consumption_share_percent IS NOT NULL
     AND base_share_percent + consumption_share_percent = 100
     AND consumption_share_percent BETWEEN 50 AND 70)
  )
);

CREATE INDEX IF NOT EXISTS idx_allocation_rules_lookup ON allocation_rules(property_id, cost_category_id, valid_from);

DROP TRIGGER IF EXISTS trg_allocation_rules_updated_at ON allocation_rules;
CREATE TRIGGER trg_allocation_rules_updated_at BEFORE UPDATE ON allocation_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 14. Allocation Rule Shares ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS allocation_rule_shares (
  id                    SERIAL PRIMARY KEY,
  allocation_rule_id    INT NOT NULL REFERENCES allocation_rules(id) ON DELETE RESTRICT,
  unit_id               INT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  share_value           NUMERIC(12,4) NOT NULL,
  valid_from            DATE NOT NULL,
  valid_until           DATE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE INDEX IF NOT EXISTS idx_allocation_shares_rule_unit ON allocation_rule_shares(allocation_rule_id, unit_id);

-- ── Record migration ──────────────────────────────────────────────────────
INSERT INTO schema_version (module, version) VALUES ('assets', 22)
  ON CONFLICT (module, version) DO NOTHING;
