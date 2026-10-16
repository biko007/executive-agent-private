-- V043 — Objektsteckbrief: Felder mit Quelle und Stand, Fristen,
-- Dienstleister, Versicherungen
--
-- Owner-Vorgabe 16.10.2026: Zu jedem Objekt soll auf einen Blick stehen, was
-- gewusst ist, woher es kommt und was fehlt. Die Spezifikation liegt als
-- docs/projekt/Objektsteckbrief-Standard.md im Repository.
--
-- WARUM EINE FELDTABELLE UND NICHT HUNDERT SPALTEN
--
-- Der Steckbrief hat rund neunzig Angaben, von der Flurstuecksnummer bis zum
-- Wartungsvertrag der Aufzugsfirma. Als Spalten an `properties` waeren das
-- neunzig Spalten, von denen die meisten bei den meisten Objekten leer
-- blieben — und jede neue Angabe braeuchte eine Migration und damit ein
-- /arm. Vor allem aber verlangt die Vorgabe zu JEDEM Wert die Quelle und den
-- Stand; als Spalten waeren das dreihundert.
--
-- Deshalb: ein Katalog, der sagt WELCHE Felder es gibt, und eine Wertetabelle,
-- die zu jedem Wert Quelle und Stand traegt. Ein neues Feld ist dann eine
-- Zeile im Katalog, keine Migration.
--
-- Fuenf additive Aenderungen. Nichts Bestehendes wird angefasst.

-- ---------------------------------------------------------------------------
-- 1. KATALOG — welche Felder der Steckbrief kennt
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objekt_feld_katalog (
  feld          text PRIMARY KEY,
  reiter        text NOT NULL,
  label         text NOT NULL,
  einheit       text,
  art           text NOT NULL DEFAULT 'text'
                  CHECK (art IN ('text','zahl','datum','geld','flaeche','prozent','ja_nein')),
  pflicht       boolean NOT NULL DEFAULT false,
  reihenfolge   integer NOT NULL DEFAULT 100,
  beschreibung  text,
  aktiv         boolean NOT NULL DEFAULT true
);

COMMENT ON TABLE objekt_feld_katalog IS
  'Welche Angaben der Objektsteckbrief kennt. Ein neues Feld ist eine Zeile, keine Migration.';
COMMENT ON COLUMN objekt_feld_katalog.pflicht IS
  'Zaehlt in die Datenvollstaendigkeit auf der Kachel.';

-- ---------------------------------------------------------------------------
-- 2. WERTE — je Objekt und Feld ein Wert MIT QUELLE UND STAND
--
-- Ohne Quelle ist ein Wert eine Vermutung. Deshalb ist `quelle` nicht
-- optional: Auch ein gerechneter Wert nennt, woraus er gerechnet wurde.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objekt_felder (
  id            bigserial PRIMARY KEY,
  property_id   integer NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  feld          text NOT NULL REFERENCES objekt_feld_katalog(feld),
  wert_text     text,
  wert_zahl     numeric(16,4),
  wert_datum    date,
  quelle        text NOT NULL,
  quelle_typ    text NOT NULL DEFAULT 'owner'
                  CHECK (quelle_typ IN ('db','sharepoint','postfach','dropbox','owner','gerechnet','extern')),
  stand         date,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, feld)
);

CREATE INDEX IF NOT EXISTS objekt_felder_property_idx ON objekt_felder(property_id);

COMMENT ON COLUMN objekt_felder.quelle IS
  'Dokument und Fundstelle, so genau, dass ein Dritter sie wiederfindet.';
COMMENT ON COLUMN objekt_felder.stand IS
  'Datum, auf das sich der Wert bezieht — nicht das Datum der Erfassung.';

DROP TRIGGER IF EXISTS trg_objekt_felder_updated_at ON objekt_felder;
CREATE TRIGGER trg_objekt_felder_updated_at
  BEFORE UPDATE ON objekt_felder FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. FRISTEN (Reiter B8)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objekt_fristen (
  id            bigserial PRIMARY KEY,
  property_id   integer NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  lease_id      integer REFERENCES leases(id) ON DELETE SET NULL,
  art           text NOT NULL,
  bezeichnung   text NOT NULL,
  termin        date NOT NULL,
  vorlauf_tage  integer NOT NULL DEFAULT 30,
  verantwortlich text,
  quelle        text,
  erledigt_am   date,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS objekt_fristen_termin_idx
  ON objekt_fristen(termin) WHERE erledigt_am IS NULL;

DROP TRIGGER IF EXISTS trg_objekt_fristen_updated_at ON objekt_fristen;
CREATE TRIGGER trg_objekt_fristen_updated_at
  BEFORE UPDATE ON objekt_fristen FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. VERSICHERUNGEN (Reiter B7)
--
-- Fuer Fahrzeuge gibt es das seit laengerem (vehicle_insurance_policies); fuer
-- Gebaeude lag es bisher nur in Notizen und PDF.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objekt_versicherungen (
  id              bigserial PRIMARY KEY,
  property_id     integer NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  gesellschaft    text NOT NULL,
  vertragsnummer  text,
  art             text NOT NULL,
  versicherungssumme numeric(14,2),
  beitrag_jahr    numeric(12,2),
  selbstbehalt    numeric(12,2),
  beginn          date,
  ende            date,
  kuendigungsfrist text,
  quelle          text,
  notes           text,
  aktiv           boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_objekt_versicherungen_updated_at ON objekt_versicherungen;
CREATE TRIGGER trg_objekt_versicherungen_updated_at
  BEFORE UPDATE ON objekt_versicherungen FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. DIENSTLEISTER (Reiter B9)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS objekt_dienstleister (
  id              bigserial PRIMARY KEY,
  property_id     integer NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  gewerk          text NOT NULL,
  firma           text NOT NULL,
  ansprechpartner text,
  telefon         text,
  email           text,
  vertrag         text,
  konditionen     text,
  kuendigungsfrist text,
  quelle          text,
  aktiv           boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_objekt_dienstleister_updated_at ON objekt_dienstleister;
CREATE TRIGGER trg_objekt_dienstleister_updated_at
  BEFORE UPDATE ON objekt_dienstleister FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. KATALOG BEFUELLEN
--
-- Referenzdaten, keine Geschaeftsdaten: Das ist die Feldliste aus
-- docs/projekt/Objektsteckbrief-Standard.md. Pflicht ist, was auf der Kachel
-- steht oder steuerlich gebraucht wird.
-- ---------------------------------------------------------------------------
INSERT INTO objekt_feld_katalog (feld, reiter, label, einheit, art, pflicht, reihenfolge) VALUES
  -- B1 Stammdaten und Erwerb
  ('flurstueck',            'B1', 'Flurstück',                     NULL,  'text',     true,  10),
  ('gemarkung',             'B1', 'Gemarkung',                     NULL,  'text',     true,  11),
  ('grundbuchblatt',        'B1', 'Grundbuchblatt',                NULL,  'text',     true,  12),
  ('grundstuecksflaeche',   'B1', 'Grundstücksfläche',             'm²',  'flaeche',  true,  13),
  ('baujahr',               'B1', 'Baujahr',                       NULL,  'zahl',     true,  14),
  ('bauweise',              'B1', 'Bauweise',                      NULL,  'text',     true,  15),
  ('denkmalschutz',         'B1', 'Denkmalschutz',                 NULL,  'ja_nein',  false, 16),
  ('sanierungsgebiet',      'B1', 'Sanierungsgebiet',              NULL,  'ja_nein',  false, 17),
  ('erwerbsdatum',          'B1', 'Besitzübergang',                NULL,  'datum',    true,  18),
  ('kaufpreis',             'B1', 'Kaufpreis',                     'EUR', 'geld',     true,  19),
  ('grunderwerbsteuer',     'B1', 'Grunderwerbsteuer',             'EUR', 'geld',     true,  20),
  ('notarkosten',           'B1', 'Notarkosten',                   'EUR', 'geld',     false, 21),
  ('grundbuchkosten',       'B1', 'Grundbuchkosten',               'EUR', 'geld',     false, 22),
  ('maklerkosten',          'B1', 'Maklerkosten',                  'EUR', 'geld',     false, 23),
  ('herstellungskosten',    'B1', 'Herstellungskosten (Neubau)',   'EUR', 'geld',     false, 24),
  -- Kaufpreis und Gesamtaufwand sind zweierlei: MG24 wurde fuer 340.000 EUR
  -- gekauft und danach umgebaut. Beide Zahlen beantworten verschiedene Fragen
  -- und werden deshalb getrennt gefuehrt (Owner-Vorgabe 16.10.2026).
  ('gesamtinvestition',     'B1', 'Gesamtinvestition inkl. Umbau', 'EUR', 'geld',     false, 31),
  ('anschaffungskosten',    'B1', 'Anschaffungskosten gesamt',     'EUR', 'geld',     true,  25),
  ('gebaeudeanteil',        'B1', 'Anteil Gebäude',                'EUR', 'geld',     true,  26),
  ('bodenanteil',           'B1', 'Anteil Grund und Boden',        'EUR', 'geld',     true,  27),
  ('afa_satz',              'B1', 'AfA-Satz',                      '%',   'prozent',  false, 28),
  ('afa_beginn',            'B1', 'AfA-Beginn',                    NULL,  'datum',    false, 29),
  ('belastungen',           'B1', 'Belastungen laut Grundbuch',    NULL,  'text',     false, 30),
  -- B2 Flaechen und Plaene
  ('wohnflaeche',           'B2', 'Wohnfläche gesamt',             'm²',  'flaeche',  true,  40),
  ('nutzflaeche',           'B2', 'Nutzfläche',                    'm²',  'flaeche',  false, 41),
  ('verkehrsflaeche',       'B2', 'Verkehrsfläche',                'm²',  'flaeche',  false, 42),
  ('bruttogrundflaeche',    'B2', 'Bruttogrundfläche',             'm²',  'flaeche',  false, 43),
  ('geschosse',             'B2', 'Geschosse',                     NULL,  'zahl',     false, 44),
  ('stellplaetze',          'B2', 'Stellplätze und Garagen',       NULL,  'zahl',     false, 45),
  ('lageplan',              'B2', 'Amtlicher Lageplan',            NULL,  'text',     true,  46),
  ('aufteilungsplan',       'B2', 'Aufteilungsplan',               NULL,  'text',     false, 47),
  ('grundrisse',            'B2', 'Grundrisse je Geschoss',        NULL,  'text',     false, 48),
  -- B5 Energie und Technik
  ('heizart',               'B5', 'Heizart',                       NULL,  'text',     true,  60),
  ('energietraeger',        'B5', 'Energieträger',                 NULL,  'text',     true,  61),
  ('energieausweis_art',    'B5', 'Energieausweis: Art',           NULL,  'text',     true,  62),
  ('energieausweis_wert',   'B5', 'Energieausweis: Kennwert',      'kWh/(m²·a)', 'zahl', true, 63),
  ('energieausweis_klasse', 'B5', 'Energieausweis: Klasse',        NULL,  'text',     true,  64),
  ('energieausweis_bis',    'B5', 'Energieausweis gültig bis',     NULL,  'datum',    true,  65),
  ('energieausweis_primaer','B5', 'Energieausweis: Primärenergie', 'kWh/(m²·a)', 'zahl', false, 70),
  ('kfw_standard',          'B5', 'KfW-Standard',                  NULL,  'text',     false, 66),
  ('pv_anlage',             'B5', 'PV-Anlage',                     'kWp', 'zahl',     false, 67),
  ('mieterstrom',           'B5', 'Mieterstrom',                   NULL,  'ja_nein',  false, 68),
  ('co2_aufteilung',        'B5', 'CO₂-Kostenaufteilung nötig',    NULL,  'ja_nein',  false, 69),
  -- B4 Finanzen
  ('darlehen_glaeubiger',   'B4', 'Darlehen: Gläubiger',           NULL,  'text',     false, 80),
  ('darlehen_restschuld',   'B4', 'Darlehen: Restschuld',          'EUR', 'geld',     false, 81),
  ('darlehen_zinssatz',     'B4', 'Darlehen: Zinssatz',            '%',   'prozent',  false, 82),
  ('darlehen_zinsbindung',  'B4', 'Darlehen: Zinsbindung bis',     NULL,  'datum',    false, 83),
  ('darlehen_annuitaet',    'B4', 'Darlehen: Annuität je Monat',   'EUR', 'geld',     false, 84),
  ('ruecklage',             'B4', 'Instandhaltungsrücklage',       'EUR', 'geld',     false, 85),
  -- B7 Versicherung (Kennzahl auf der Kachel; Vertraege in objekt_versicherungen)
  ('versicherungssumme',    'B7', 'Versicherungssumme Gebäude',    'EUR', 'geld',     true,  90),
  -- E Zusatzmodule
  ('mietspiegel_wert',      'E',  'Mietspiegel Vergleichsmiete',   'EUR/m²', 'zahl',  false, 95),
  ('mietspiegel_stand',     'E',  'Mietspiegel: Stand',            NULL,  'text',     false, 96),
  ('mietspiegel_klasse',    'E',  'Mietspiegel: Baujahrklasse',    NULL,  'text',     false, 97),
  ('mietspiegel_lage',      'E',  'Mietspiegel: Wohnlage',         NULL,  'text',     false, 98)
ON CONFLICT (feld) DO NOTHING;

-- Schema-Version fortschreiben.
INSERT INTO schema_version (module, version, applied_at)
VALUES ('assets', 43, now())
ON CONFLICT (module, version) DO NOTHING;
