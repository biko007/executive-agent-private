-- V041 — Verbrauchsanteil bei heating_split von 50-70 % auf 0-100 % öffnen
-- Owner-Entscheidung 10.10.2026, 23:10 (Paket 3c, Teil A1). Rote Zone.
--
-- AUSGANGSLAGE. V022 schrieb bei `key_type = 'heating_split'` einen
-- Verbrauchsanteil zwischen 50 und 70 Prozent vor. Das ist der Rahmen des
-- § 7 Abs. 1 HeizkostenV: 50 bis 70 Prozent nach Verbrauch, der Rest nach
-- Fläche. Die Datenbank hat damit Recht durchgesetzt.
--
-- ENTSCHEIDUNG DES OWNERS. Heizung und Warmwasser von MG24 werden zu 100
-- Prozent nach Verbrauch verteilt, also mit 0 Prozent Grundkosten — so, wie es
-- bei N24 für 2024 schon praktiziert wurde. Der Owner trägt das Risiko aus
-- § 12 HeizkostenV (Kürzungsrecht des Mieters um 15 Prozent bei nicht
-- verordnungsgemäßer Abrechnung) ausdrücklich und bewusst.
--
-- WAS BLEIBT. Die Summe aus Grund- und Verbrauchsanteil muss weiterhin genau
-- 100 Prozent ergeben, und beide Werte müssen gesetzt sein. Das ist keine
-- Rechtsfrage, sondern Arithmetik: Eine Verteilung, die nicht 100 Prozent
-- abdeckt, verliert oder erfindet Geld.
--
-- WAS AN DIE STELLE DER DATENBANKSPERRE TRITT. Die Engine meldet ab jetzt
-- einen Befund `HEATING_SPLIT_OUTSIDE_HEIZKOSTENV`, sobald der
-- Verbrauchsanteil außerhalb von 50 bis 70 Prozent liegt. Die Abweichung ist
-- damit in jeder Probe- und Endabrechnung sichtbar und dokumentiert, statt
-- unbemerkt zu bleiben. Eine Sperre, die eine bewusste Owner-Entscheidung
-- blockiert, wäre an dieser Stelle falsch; eine stillschweigende Abweichung
-- aber auch.

ALTER TABLE allocation_rules DROP CONSTRAINT IF EXISTS allocation_rules_check1;

ALTER TABLE allocation_rules ADD CONSTRAINT allocation_rules_check1 CHECK (
  key_type <> 'heating_split' OR (
    base_share_percent IS NOT NULL
    AND consumption_share_percent IS NOT NULL
    AND base_share_percent + consumption_share_percent = 100
    AND consumption_share_percent >= 0
    AND consumption_share_percent <= 100
  )
);

COMMENT ON COLUMN allocation_rules.consumption_share_percent IS
  'Verbrauchsanteil bei heating_split, 0 bis 100 Prozent. Der Rahmen des § 7 HeizkostenV '
  '(50 bis 70 Prozent) wird NICHT mehr von der Datenbank erzwungen; eine Abweichung meldet '
  'die Engine als HEATING_SPLIT_OUTSIDE_HEIZKOSTENV. Owner-Entscheidung 10.10.2026.';

INSERT INTO schema_version (module, version) VALUES ('assets', 41)
  ON CONFLICT (module, version) DO NOTHING;
