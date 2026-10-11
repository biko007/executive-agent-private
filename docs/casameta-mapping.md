# Casameta ↔ bikosoc — Zuordnung

**Stand: 2026-10-11** · Owner-Entscheidung 10.10.2026, 23:10 (Paket 3c)

## Wozu dieses Dokument

Die Abrechnungsarchitektur ist **hybrid**: bikosoc ist Datendrehscheibe,
Kontrollrechnung, Belegarchiv und Oberfläche; **Casameta** (portal.casameta.de,
eddi24 GmbH) ist die Abrechnungsmaschine und erzeugt das rechtsverbindliche
Mieter-PDF. Eine Schnittstelle gibt es nicht — die Eingabe ins Portal erfolgt
durch den Produkt-Chat per Browser.

Damit diese Eingabe ohne Suchen und ohne Raten möglich ist, erzeugt bikosoc ein
**Eingabeblatt**: alle Portalfelder in Portalreihenfolge, befüllt aus den
eigenen Daten, Lücken ausdrücklich als `FEHLT` markiert.

Dieses Dokument hält fest, welches Feld in Casameta welchem Datum in bikosoc
entspricht. Dieselbe Zuordnung liegt als JSON in `system_settings.casameta_mapping`
— dort ändert der Owner sie ohne Deployment, hier steht das Warum.

**Leistungsstellen-Nummern:** 0030757-3 = MG24 · 0030757-2 = N24 · 0030757-1 = L19.

---

## 1. Kostenarten

### Energiekosten (Brennstoffbezug / Zukauf)

Casameta verlangt hier **Menge mit Einheit**, nicht nur den Betrag — und
zusätzlich **Anfangs- und Endbestand des Lagers**. Das ist der entscheidende
Unterschied zur bikosoc-Logik: bikosoc bucht nach dem Leistungsprinzip auf das
**Lieferdatum**, Casameta rechnet den **tatsächlich verbrauchten** Brennstoff aus
Anfangsbestand + Zukauf − Endbestand.

| Casameta | bikosoc | Anmerkung |
|---|---|---|
| Brennstoffart | `property_heating_config.heating_system` | `central_pellets` → Holzpellets |
| Heizwert Hi | fest 5 kWh/kg für Holzpellets | Owner-Vorgabe; entspricht dem üblichen Wert nach DINplus |
| Zukauf Menge + Einheit | Rechnungsliste der Regel `mg24-pellets` | Tonnen aus der Rechnung, nicht aus dem Betrag gerechnet |
| Zukauf Betrag | `expense_bookings` mit Kostenart `heizung` | |
| Anfangsbestand | **FEHLT** — nicht geführt | siehe Abschnitt „Lagerbestand" |
| Endbestand | **FEHLT** — nicht geführt | |

### Heiznebenkosten

| Casameta | bikosoc |
|---|---|
| Wartung Heizung | Kostenart `heizung`, Belegart Wartung |
| Schornsteinfeger | Kostenart `schornstein` |
| Betriebsstrom Heizung | Anteil am Allgemeinstrom — in bikosoc nicht getrennt erfasst |
| Messdienst / Verbrauchserfassung | Kostenart `sonstige_betrkv` |

### Hausnebenkosten

Die bei N24 und L19 für 2024 verwendeten Arten, mit ihrer Entsprechung:

| Casameta | bikosoc-Kostenart | Umlageschlüssel Casameta |
|---|---|---|
| Grundsteuer | `grundsteuer` | NHN |
| Grundstücksentwässerung | `entwaesserung` | VKW |
| Niederschlagswasser | `niederschlagswasser` | NHN |
| Kaltwasser | `wasser` | VKW |
| Müllabfuhr | `strassenreinigung_muell` | NHN oder PE |
| Hauswart | `hauswart` | NHN |
| Allgemeinstrom | `sonstige_betrkv` | NHN |
| Gebäudeversicherung | `versicherung` | NHN |
| Gebäudehaftpflicht | `versicherung` | NHN |
| Wartung Fahrstuhl | `aufzug` | NHN |
| Sonstige Kosten 1..n | `sonstige_betrkv` | je Fall |

### Umlageschlüssel-Codes

| Code | Bedeutung | Entsprechung in bikosoc (`allocation_rules.key_type`) |
|---|---|---|
| **NHN** | Nutzfläche Hausnebenkosten | `sqm` |
| **VKW** | Verbrauch Kaltwasser | `consumption` (Medium Kalt- und Warmwasser) |
| **WNZ** | Wohnung nach Nutzungszeit | zeitanteilig — in bikosoc immer über `active_days` |
| **PE** | Personen | `persons` |
| **FL** | Fläche | `sqm` |
| **VE** | mit Zählern | `consumption` |

**Ein Unterschied, der auffallen wird:** bikosoc kennt `heating_split` mit
Grund- und Verbrauchsanteil als EINEN Schlüssel; Casameta trennt die
Heizkostenverteilung in eigene Felder. Beim Übertragen gilt: Grundkostenanteil
nach Fläche, Verbrauchsanteil nach Zählern — bei MG24 ab 2025 **0 / 100 %**
(Owner-Entscheidung, siehe Report 3c Teil A).

---

## 2. Stammdaten

| Casameta | bikosoc |
|---|---|
| Abrechnungszeitraum | Kalenderjahr aus dem Abrechnungslauf |
| Wohnung: Nr., Lage | `units.code`, `units.floor`/`units.position` |
| Nutzfläche HK / WW / NK | `units.living_area_qm` — bikosoc führt EINE Fläche; Casameta erlaubt drei getrennte. Abweichende Flächen gehören in `units.notes` und müssen im Portal von Hand gesetzt werden. |
| Nutzer-Zeitraum | `leases.start_date` / `end_date`, Leerstand als Lücke |
| Zähler: Pos., Nr., Raum, Typ, K-Wert | `meters.meter_number`, `medium`, `notes`; **Raum und K-Wert führt bikosoc nicht** |
| Zählerstand Alt / Neu | `meter_readings` zum Periodenanfang und -ende |
| Vorauszahlungen je Nutzer | `leases.advance_payment_*` |
| Direktkosten | `expense_bookings` mit gesetzter `unit_id` |

---

## 3. Lagerbestand — der offene Punkt

Casameta rechnet Brennstoff über **Anfangsbestand + Zukauf − Endbestand**.
bikosoc bucht nach Lieferdatum. Beide Wege sind vertretbar, führen aber zu
unterschiedlichen Beträgen, solange der Lagerbestand nicht geführt wird.

Konkret bei MG24: Die Lieferung vom **20.12.2024 über 1.695,84 € (5,00 t)**
liegt nach dem Leistungsprinzip in 2024 und damit nicht in der Abrechnung 2025
— verbrannt wurde sie aber 2025. Die Abrechnung 2025 enthält deshalb drei
Lieferungen über 5.435,13 € statt vier über 7.130,97 €.

**Arbeitsannahme, ausdrücklich keine Tatsache:** Anfangsbestand 01.01.2025 =
5,00 t, weil die letzte Lieferung am 20.12.2024 erfolgte und der Kessel in den
elf Tagen bis zum Jahreswechsel nur einen kleinen Teil davon verbraucht haben
kann. Belegt ist das nicht. Quellen, die es belegen könnten: die
KWB-Kesselsteuerung, die Gebäudeleittechnik oder eine Bestandsangabe von
Fa. Maurer.

Die Entscheidung zwischen Leistungsprinzip und Lagerbestandsrechnung gehört in
Paket 3c Teil C und ist eine Owner-Entscheidung.

---

## 4. Was bikosoc nicht liefern kann

| Feld | Grund |
|---|---|
| Raum je Zähler | nicht erfasst; steht teils in `meters.notes` |
| K-Wert / Umrechnungsfaktor je Zähler | nicht erfasst |
| Getrennte Nutzflächen HK / WW / NK | bikosoc führt eine Fläche je Einheit |
| Anfangs- und Endbestand Brennstoff | nicht geführt, siehe oben |

Diese Felder erscheinen im Eingabeblatt als `FEHLT` mit Hinweis, damit sie im
Portal bewusst gesetzt werden und nicht unbemerkt leer bleiben.
