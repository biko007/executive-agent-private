#!/usr/bin/env bun
/**
 * Objektsteckbrief aus den vorhandenen Belegen befuellen.
 *
 * Owner-Auftrag 16.10.2026, Teil 3: „nur belegte Werte". Jeder Eintrag hier
 * traegt die Fundstelle, aus der er stammt — Kaufvertrag, Bescheid,
 * Energieausweis oder eine ausdrueckliche Owner-Angabe. Was nicht belegt ist,
 * steht nicht drin; es erscheint im Report als offene Anfrage.
 *
 * Braucht V043. Aufruf:
 *   bun run scripts/steckbrief-befuellen.ts            (Probelauf)
 *   bun run scripts/steckbrief-befuellen.ts --apply
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function envWert(s: string): string {
  if (process.env[s]) return process.env[s]!;
  const d = join(homedir(), '.config', 'openclaw', 'env');
  if (!existsSync(d)) throw new Error(`${s} fehlt`);
  const t = readFileSync(d, 'utf-8').match(new RegExp(`^${s}=(.+)$`, 'm'));
  if (!t) throw new Error(`${s} fehlt in der Env-Datei`);
  return t[1].trim();
}
if (!process.env.POSTGRES_URL) process.env.POSTGRES_URL = envWert('POSTGRES_URL');

const { query } = await import('../src/shared/db/index.js');
const { setzeFeld, steckbriefBereit, vollstaendigkeit } = await import('../src/modules/assets/steckbrief.js');

/** Fundstellen, damit jede Quelle nur einmal geschrieben steht. */
const Q = {
  kv_mg: 'SharePoint 6-Marktgasse 24/Gebaeudeakte/MG24/Vertraege, Versicherungen/'
       + '2021-11-18 Kaufvertrag M24 Alter Kindergarten.pdf, Paragraf 1 und 4',
  kv_mg_besitz: 'SharePoint 6-Marktgasse 24/Gebaeudeakte/MG24/Vertraege, Versicherungen/'
       + '2021-11-18 Kaufvertrag M24 Alter Kindergarten.pdf, Paragraf 6 (Besitzuebergabe)',
  grest_mg: 'SharePoint 6-Marktgasse 24/2-Finanzen/Bescheide/'
       + '2022-01-03_Bescheid ueber Grunderwerbsteuer_MG24.pdf, Finanzamt Tuttlingen, StNr 21633/12800',
  notar_mg: 'SharePoint 6-Marktgasse 24/2-Finanzen/Eingangsrechnungen-Kredi/'
       + '2021-11-18_Rechnung Kaufvertrag M24 -UR 2353 2021.pdf, Summe 2.403,21 EUR',
  kv_s28: 'SharePoint ScannerPro/2023-08-02_S28 Kaufvertrag.pdf, Paragraf 1 und 4',
  gst_s28: 'SharePoint 11-S28/2024-09-04_S28 FA TUT Grundsteuerwertbescheid Zurech.pdf '
       + 'und 5-L19/2024-01-11_S28 Grundsteuerbescheid.pdf (Datei im L19-Ordner, Inhalt S28)',
  gst_n24: 'SharePoint 3-La Perla GmbH/N24/Sonstiges/2024-03-13_N24 Grundsteuerwertbescheid.pdf',
  ea_n24: 'SharePoint N24/N24 - Gebaeudeakte/2. Doku Gewerke/7006_Bauphysik_K&F/'
       + 'Energieausweis_EneV-GEG-BW-2023_N24.pdf',
  ea_mg24: 'SharePoint 6-Marktgasse 24/Gebaeudeakte/7. Haustechnik/Kurz & Fischer/'
       + '2024-11-20_MG24_Kurz+Fischer_ endgueltiger Energieausweis.pdf, Registriernummer '
       + 'BW-2024-005394132, ausgestellt 28.10.2024',
  elster_l19: 'SharePoint 8_Juergen Bickel privat/2-Finanzen/Grundsteuererklaerung/GrdSt JB/'
       + 'Leutenbergstr._19_ELSTER - Erklaerung zur Feststellung des Grundsteuerwerts.pdf',
  elster_mg24: 'SharePoint 8_Juergen Bickel privat/2-Finanzen/Grundsteuererklaerung/GrdSt JB/'
       + 'Marktgasse_24_ELSTER - Erklaerung zur Feststellung des Grundsteuerwerts.pdf',
  elster_d4: 'SharePoint 8_Juergen Bickel privat/2-Finanzen/Grundsteuererklaerung/GrdSt JB/'
       + 'Daimlerstr._4_ELSTER - Erklaerung zur Feststellung des Grundsteuerwerts.pdf',
  elster_i83: 'SharePoint 8_Juergen Bickel privat/2-Finanzen/Grundsteuererklaerung/GrdSt JB/'
       + 'Irisweg_83 Erklaerung zur Feststellung des Grundsteuerwerts.pdf, Zeile 8',
  mail_l19: 'Postfach juergen.bickel@bikolino.com, Mail von Henry Haslinger vom 11.09.2024, '
       + 'Betreff "L19 Mieterhoehung"',
  bk_n24: 'SharePoint 3-La Perla GmbH/N24/Kosten/Aufteilung Baukosten-USt/Auft. Baukosten.xlsx, '
       + 'Blatt Summary; Grundlage ist das DATEV-Kontoblatt 120 "Bauten im Bau" der La Perla GmbH',
  besch_mg24: 'Bescheinigung der Stadt Tuttlingen gemaess Paragrafen 7h, 10f, 11a EStG vom 01.08.2025 '
       + '(Anlage zur Einkommensteuer 2024, Postfach juergen.bickel@bikolino.com, Mail von Doris '
       + 'Hilsenbeck vom 07.05.2026, Archiv "EST 2024.zip")',
  owner1610: 'Owner-Angabe Herr Bickel vom 16.10.2026',
  hk_l19: 'Baukosten.xlsx, Mail Doris Hilsenbeck vom 20.01.2016 "Gesamtbaukosten Leutenbergstr. '
       + 'ohne Einrichtung", Blaetter "AK Grundstueck" und "AHK Gebaeude"; dazu LS19 AHK.xlsx, Mail '
       + 'Doris Hilsenbeck vom 15.12.2015 (Kontoblaetter 85 und 150, Rechnungswesen 238754/20000, '
       + 'Mandant Juergen Bickel). Quelle ausgewertet aus dem alten S&B-Postfach (PST, iCloud '
       + 'PST-Auswertung/L19) — Owner-Auswertung 16.10.2026.',
  karl_l19: 'Mail Anton Karl vom 27.09.2015 "Baukostenaufstellung" (PST, iCloud PST-Auswertung/L19)',
  kfw_l19: 'Mails Anton Karl vom 18.03.2014 "KfW-Kredit / Foerderung" und vom 27.05.2014 "KFW" '
       + '(PST, iCloud PST-Auswertung/L19)',
  ms26: 'Qualifizierter Mietspiegel der Stadt Tuttlingen, 17. Fortschreibung, Geltungsdauer '
       + '27.07.2026 bis 27.07.2028, Mietwerttabelle beschlossen am 27.05.2026, Gemeinderat '
       + '20.07.2026 (tuttlingen.de, Dokument id=34333, geladen am 16.10.2026)',
  /* Bis zum 16.10.2026 war dies eine blosse Owner-Angabe; seitdem liegen die
     Unterlagen vor und die Angaben sind aus dem Original belegt. */
  teil_l19: 'Dropbox transfer/L19-Teilungserklaerung/2015/2015-11-30_0914_G. Saile_Whs. '
       + 'Leutenbergstr. 19  Teilungsunterlagen/Bickel Teilung Antrag.pdf und '
       + 'Bickel Deckblatt Teilung .pdf — Teilung eines Wohngebaeudes in Sondereigentum, '
       + 'Ing.-Buero G. Saile, Sigmaringen, aufgestellt 26.11.2015, uebersandt 30.11.2015',
  lage_l19: 'Dropbox transfer/L19-Teilungserklaerung/2015/2015-11-30_0914_G. Saile_Whs. '
       + 'Leutenbergstr. 19  Teilungsunterlagen/Bickel Teilung Lageplan.pdf — Auszug aus dem '
       + 'Liegenschaftskataster mit Einzeichnungen nach Paragraf 4 LBOVVO, Massstab 1:500, '
       + 'Vermessungsbuero H. W. Heizmann, Immendingen-Hattingen, 12.11.2013',
  wfl_l19: 'Dropbox transfer/L19-Teilungserklaerung/2015/2015-11-30_0914_G. Saile_Whs. '
       + 'Leutenbergstr. 19  Teilungsunterlagen/Bickel Teilung Wohnflaeche.pdf — '
       + 'Aufteilungsberechnung nach DIN 283, Ing.-Buero G. Saile, 26.11.2015',
  ea_mg22: 'Paragraf 80 GEG: Ein Energieausweis ist nur fuer beheizte oder klimatisierte Gebaeude '
       + 'auszustellen. MG22 sind drei unbeheizte Garagen (bikosoc-Stammdaten: '
       + 'properties.heating_type = none; Owner-Entscheidung 16.10.2026).',
  kv_n24_jb: 'SharePoint 3-La Perla GmbH/N24/Vetraege/2020-12-14 Kaufvertrag N24 JB-La Perla.pdf, '
       + 'Paragraf 4: Kaufpreis 185.000,00 EUR, davon Grund und Boden 95.000,00, Abbruchkosten '
       + '40.000,00 und Bauplanung 50.000,00 EUR (Flst 1125/1 mit 488 qm und 1126/1 mit 160 qm)',
  kv_n24_stadt: 'SharePoint 3-La Perla GmbH/N24/Vetraege/Kaufvertrag_Zukaufsflaeche Stadt Tuttlingen.pdf, '
       + 'Paragraf 4; Notarin Harant-Strecker, UR 1491/2021, beurkundet 02.08.2021: Flst 1128/13, '
       + '4 ar 07 qm zu 135,00 EUR/qm = 54.945,00 EUR',
  kv_n24_schmutz: 'SharePoint 3-La Perla GmbH/N24/Vetraege/2021-10-07 Kaufvertrag Zusatzflaeche2 N24 '
       + 'A. Schmutz-La Perla.pdf, Paragraf 3: Flst 1123/1 (1.396 qm) und 1123/10 (303 qm), '
       + '10.226,25 EUR, beurkundet 07.10.2021',
};

type Eintrag = {
  objekt: string; feld: string;
  text?: string; zahl?: number; datum?: string;
  quelle: string; typ: string; stand: string; notiz?: string;
};

const EINTRAEGE: Eintrag[] = [
  // ── MG22 ────────────────────────────────────────────────────────────────
  { objekt: 'mg22', feld: 'flurstueck',          text: '239/5',      quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18' },
  { objekt: 'mg22', feld: 'gemarkung',           text: 'Möhringen',  quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18' },
  { objekt: 'mg22', feld: 'grundbuchblatt',      text: '3528',       quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18' },
  { objekt: 'mg22', feld: 'grundstuecksflaeche', zahl: 160,          quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18' },
  { objekt: 'mg22', feld: 'erwerbsdatum',        datum: '2021-12-01', quelle: Q.kv_mg_besitz, typ: 'sharepoint', stand: '2021-12-01' },
  { objekt: 'mg22', feld: 'kaufpreis',           zahl: 20320,        quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18',
    notiz: '127,00 EUR je qm; Gesamtkaufpreis der Urkunde 360.320,00 EUR' },
  { objekt: 'mg22', feld: 'grunderwerbsteuer',   zahl: 1016,         quelle: Q.grest_mg, typ: 'gerechnet', stand: '2022-01-03',
    notiz: '5,00 Prozent von 20.320,00 EUR; der Bescheid setzt 18.016,00 EUR fuer beide Grundstuecke fest' },
  { objekt: 'mg22', feld: 'notarkosten',         zahl: 135.53,       quelle: Q.notar_mg, typ: 'gerechnet', stand: '2021-11-18',
    notiz: 'Anteil 5,6394 Prozent (20.320 von 360.320) an 2.403,21 EUR' },
  { objekt: 'mg22', feld: 'anschaffungskosten',  zahl: 21471.53,     quelle: Q.kv_mg + ' + ' + Q.grest_mg, typ: 'gerechnet', stand: '2021-12-01',
    notiz: 'Kaufpreis + Grunderwerbsteuer + Notar; Grundbuchkosten fehlen noch' },
  { objekt: 'mg22', feld: 'belastungen',         text: 'Beschränkte persönliche Dienstbarkeit Stadtwerke Tuttlingen (Erdkabel); Sanierungsverfahren',
    quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18' },
  { objekt: 'mg22', feld: 'stellplaetze',        zahl: 3,            quelle: 'bikosoc: units G1, G2, G3 (Owner-Entscheidung 16.10.2026)', typ: 'db', stand: '2026-10-16' },

  // ── MG24 ────────────────────────────────────────────────────────────────
  { objekt: 'mg24', feld: 'flurstueck',          text: '239',        quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18' },
  { objekt: 'mg24', feld: 'gemarkung',           text: 'Möhringen',  quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18' },
  { objekt: 'mg24', feld: 'grundbuchblatt',      text: '831',        quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18' },
  { objekt: 'mg24', feld: 'grundstuecksflaeche', zahl: 1596,         quelle: Q.grest_mg + ' (Grundstueck 01, Groesse 1.596,00 qm)', typ: 'sharepoint', stand: '2022-01-03',
    notiz: 'Der Kaufvertrag nennt 15 ar 96 qm, der Bescheid 1.596,00 qm — dieselbe Flaeche' },
  { objekt: 'mg24', feld: 'erwerbsdatum',        datum: '2021-12-01', quelle: Q.kv_mg_besitz, typ: 'sharepoint', stand: '2021-12-01',
    notiz: 'Besitzuebergang; die Eintragung im Grundbuch erfolgte am 31.03.2022' },
  { objekt: 'mg24', feld: 'kaufpreis',           zahl: 340000,       quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18',
    notiz: 'Kaufpreis der Urkunde. In properties.purchase_price_total stehen 2.500.000,00 EUR — das ist '
         + 'offenbar der Gesamtaufwand einschliesslich Umbau, nicht der Kaufpreis. Beide Zahlen beantworten '
         + 'verschiedene Fragen; welche in die AfA gehoert, klaert der Steuerberater.' },
  { objekt: 'mg24', feld: 'grunderwerbsteuer',   zahl: 17000,        quelle: Q.grest_mg, typ: 'gerechnet', stand: '2022-01-03',
    notiz: '5,00 Prozent von 340.000,00 EUR; Festsetzung 18.016,00 EUR fuer beide Grundstuecke' },
  { objekt: 'mg24', feld: 'notarkosten',         zahl: 2267.68,      quelle: Q.notar_mg, typ: 'gerechnet', stand: '2021-11-18',
    notiz: 'Anteil 94,3606 Prozent an 2.403,21 EUR' },
  { objekt: 'mg24', feld: 'anschaffungskosten',  zahl: 3032223.03,   quelle: Q.kv_mg + ' + ' + Q.grest_mg + ' + ' + Q.besch_mg24, typ: 'gerechnet', stand: '2025-08-01',
    notiz: 'Erwerb 359.267,68 (Kaufpreis 340.000,00 + Grunderwerbsteuer 17.000,00 + Notar 2.267,68) '
         + 'PLUS Modernisierung 2.672.955,35 EUR. Das Feld heisst "Anschaffungskosten gesamt" und ist '
         + 'die Bezugsgroesse der Rendite — nur der Erwerbsteil allein ergaebe fuer MG24 19,2 Prozent, '
         + 'weil der gesamte Umbau fehlte. Grundbuchkosten sind noch nicht enthalten.' },
  { objekt: 'mg24', feld: 'belastungen',         text: 'Sanierungsverfahren (Abt. II Nr. 52)', quelle: Q.kv_mg, typ: 'sharepoint', stand: '2021-11-18' },

  // ── S28 ─────────────────────────────────────────────────────────────────
  { objekt: 's28', feld: 'flurstueck',           text: '1154/3 (Gebäude- und Freifläche) sowie 1154 (Waldfläche, 426 m²)',
    quelle: Q.kv_s28, typ: 'sharepoint', stand: '2023-08-02' },
  { objekt: 's28', feld: 'gemarkung',            text: 'Tuttlingen', quelle: Q.kv_s28, typ: 'sharepoint', stand: '2023-08-02' },
  { objekt: 's28', feld: 'grundbuchblatt',       text: '1172 (Amtsgericht Sigmaringen für Tuttlingen)', quelle: Q.kv_s28, typ: 'sharepoint', stand: '2023-08-02' },
  { objekt: 's28', feld: 'grundstuecksflaeche',  zahl: 705,          quelle: Q.kv_s28, typ: 'sharepoint', stand: '2023-08-02',
    notiz: 'Flst. 1154/3; dazu 426 qm Waldflaeche auf Flst. 1154' },
  { objekt: 's28', feld: 'erwerbsdatum',         datum: '2023-08-02', quelle: Q.kv_s28 + ', Paragraf 6: Besitzuebergabe sofort', typ: 'sharepoint', stand: '2023-08-02' },
  { objekt: 's28', feld: 'kaufpreis',            zahl: 420000,       quelle: Q.kv_s28, typ: 'sharepoint', stand: '2023-08-02',
    notiz: 'Verkaeufer Klaus Bickel; Vertragsgegenstand beide Flurstuecke' },
  { objekt: 's28', feld: 'belastungen',          text: 'Abteilung II: keine', quelle: Q.kv_s28, typ: 'sharepoint', stand: '2023-08-02' },

  // ── N24 ─────────────────────────────────────────────────────────────────
  { objekt: 'n24', feld: 'grundstuecksflaeche',  zahl: 1055,         quelle: Q.gst_n24 + ', Abschnitt B', typ: 'sharepoint', stand: '2024-03-13' },
  { objekt: 'n24', feld: 'energieausweis_art',   text: 'Bedarfsausweis nach GEG (Kurz und Fischer)', quelle: Q.ea_n24, typ: 'sharepoint', stand: '2023-01-01' },
  { objekt: 'n24', feld: 'energieausweis_wert',  zahl: 24.6,         quelle: Q.ea_n24 + ', Endenergiebedarf', typ: 'sharepoint', stand: '2023-01-01',
    notiz: 'Primaerenergie 44,21 kWh/(m2a) ohne und 18,83 kWh/(m2a) mit Photovoltaik' },
  { objekt: 'n24', feld: 'energieausweis_klasse', text: 'A+',        quelle: Q.ea_n24, typ: 'sharepoint', stand: '2023-01-01' },
  { objekt: 'n24', feld: 'bruttogrundflaeche',   zahl: 1056.2,       quelle: Q.ea_n24 + ', Gebaeudenutzflaeche', typ: 'sharepoint', stand: '2023-01-01',
    notiz: 'Gebaeudenutzflaeche nach GEG, nicht Wohnflaeche' },
  { objekt: 'n24', feld: 'heizart',              text: 'Wärmepumpe mit Erdsonden', quelle: 'bikosoc property_heating_config und ' + Q.ea_n24, typ: 'db', stand: '2026-10-16' },
  { objekt: 'n24', feld: 'energietraeger',       text: 'Strom',      quelle: 'abgeleitet aus der Heizart', typ: 'gerechnet', stand: '2026-10-16' },
  { objekt: 'n24', feld: 'mieterstrom',          text: 'ja',         quelle: 'bikosoc: Mieterstromvertraege W1 und W2, 70,00 EUR je Monat (Paragraf 42a EnWG)', typ: 'db', stand: '2026-10-16' },

  // ── L19 ─────────────────────────────────────────────────────────────────
  { objekt: 'l19', feld: 'flurstueck',           text: '8414/2',     quelle: Q.teil_l19, typ: 'owner', stand: '2015-11-30' },
  { objekt: 'l19', feld: 'grundstuecksflaeche',  zahl: 562,          quelle: Q.teil_l19, typ: 'owner', stand: '2015-11-30' },
  { objekt: 'l19', feld: 'wohnflaeche',          zahl: 438.99,       quelle: Q.teil_l19, typ: 'owner', stand: '2015-11-30',
    notiz: 'vier Sondereigentume laut Teilung' },

  // ── Nachtrag 16.10.2026: Baujahr, Energie, Flurstuecke, Mietspiegel ─────
  { objekt: 'mg24', feld: 'baujahr',             zahl: 1929,         quelle: Q.ea_mg24, typ: 'sharepoint', stand: '2024-10-28',
    notiz: 'Baujahr Gebaeude laut Energieausweis; Baujahr des Waermeerzeugers 2024' },
  { objekt: 'mg24', feld: 'energieausweis_art',  text: 'Bedarfsausweis nach GEG (Kurz und Fischer)', quelle: Q.ea_mg24, typ: 'sharepoint', stand: '2024-10-28' },
  { objekt: 'mg24', feld: 'energieausweis_wert', zahl: 220.5,        quelle: Q.ea_mg24, typ: 'sharepoint', stand: '2024-10-28',
    notiz: 'Endenergiebedarf; Pflichtangabe in Immobilienanzeigen' },
  { objekt: 'mg24', feld: 'energieausweis_primaer', zahl: 43.9,      quelle: Q.ea_mg24, typ: 'sharepoint', stand: '2024-10-28' },
  { objekt: 'mg24', feld: 'energieausweis_klasse', text: 'G',        quelle: Q.ea_mg24 + ' (Klasse aus dem Endenergiebedarf nach Paragraf 86 GEG)', typ: 'gerechnet', stand: '2024-10-28',
    notiz: '220,5 kWh/(m2a) liegt in der Spanne 200 bis 250 und damit in Klasse G' },
  { objekt: 'mg24', feld: 'energieausweis_bis',  datum: '2034-10-28', quelle: Q.ea_mg24, typ: 'sharepoint', stand: '2024-10-28' },
  { objekt: 'mg24', feld: 'energietraeger',      text: 'Pellets',    quelle: Q.ea_mg24, typ: 'sharepoint', stand: '2024-10-28' },
  { objekt: 'mg24', feld: 'gesamtinvestition',   zahl: 3032223.03,   quelle: Q.kv_mg + ' + ' + Q.grest_mg + ' + ' + Q.besch_mg24, typ: 'gerechnet', stand: '2025-08-01',
    notiz: 'Kaufpreis 340.000,00 + Grunderwerbsteuer 17.000,00 + Notar 2.267,68 + Modernisierung '
         + '2.672.955,35 = 3.032.223,03 EUR, ohne Grundbuchkosten und vor Abzug der Zuschuesse. '
         + 'In properties.purchase_price_total standen 2.500.000,00 EUR — das kommt den um beide '
         + 'Zuschuesse gekuerzten Modernisierungskosten von 2.532.955,35 EUR nahe und war '
         + 'offenbar ein gerundeter Zwischenstand.' },

  { objekt: 'i83', feld: 'baujahr',              zahl: 1965,         quelle: Q.elster_i83, typ: 'sharepoint', stand: '2022-12-31',
    notiz: 'Erklaerung zur Feststellung des Grundsteuerwerts, Bundesmodell NRW: Baujahr des Gebaeudes 1965' },
  { objekt: 'i83', feld: 'flurstueck',           text: '442 und 443', quelle: Q.elster_i83, typ: 'sharepoint', stand: '2022-12-31' },
  { objekt: 'i83', feld: 'gemarkung',            text: 'Niederzuendorf (Koeln)', quelle: Q.elster_i83, typ: 'sharepoint', stand: '2022-12-31' },

  { objekt: 'd4',  feld: 'flurstueck',           text: '2084/7',     quelle: Q.elster_d4, typ: 'sharepoint', stand: '2022-12-31' },
  { objekt: 'd4',  feld: 'gemarkung',            text: 'Wurmlingen', quelle: Q.elster_d4, typ: 'sharepoint', stand: '2022-12-31' },
  { objekt: 'd4',  feld: 'grundstuecksflaeche',  zahl: 1125,         quelle: Q.elster_d4, typ: 'sharepoint', stand: '2022-12-31' },

  { objekt: 'l19', feld: 'gemarkung',            text: 'Tuttlingen', quelle: Q.elster_l19 + ' sowie ' + Q.teil_l19, typ: 'sharepoint', stand: '2022-12-31' },
  { objekt: 'l19', feld: 'lageplan',            text: 'Katasterauszug M 1:500, Vermessungsbüro H. W. Heizmann, 12.11.2013 (Teilungsunterlagen Saile)',
    quelle: Q.lage_l19, typ: 'dropbox', stand: '2013-11-12',
    notiz: 'Auszug aus dem Liegenschaftskataster mit Einzeichnungen nach Paragraf 4 LBOVVO: '
         + 'Kreis Tuttlingen, Gemeinde und Gemarkung Tuttlingen, Flurstueck 8414/2. Bestandteil '
         + 'des Teilungsantrags nach Paragraf 8 LBO und Paragraf 7 WEG.' },
  { objekt: 'l19', feld: 'aufteilungsplan',     text: 'Teilung in Sondereigentum 1 bis 4, Ing.-Büro G. Saile, 26.11.2015',
    quelle: Q.teil_l19, typ: 'dropbox', stand: '2015-11-26',
    notiz: 'Vier Sondereigentumseinheiten mit Grundrissen EG, 1. OG, 2. OG und DG, Schnitt A-A '
         + 'und Ansichten, jeweils auch als DXF. Miteigentumsanteile laut Berechnungsschluessel: '
         + 'SE1 284,11 / SE2 284,93 / SE3 155,03 / SE4 276,14 Tausendstel. ACHTUNG: Diese vier '
         + 'Werte ergeben zusammen 1.000,21 Tausendstel, nicht 1.000 — die Berechnung der Anlage '
         + 'teilt durch zwei verschiedene Summen (541,89 und 541,74) und nennt als Summe der '
         + 'Flaechen 308,31 qm statt 541,90 qm. Welche Anteile die notarielle Teilungserklaerung '
         + 'festschreibt, ist damit NICHT belegt; die Wohnflaechen selbst sind davon unberuehrt.' },
  { objekt: 'l19', feld: 'baujahr',              zahl: 2016,         quelle: 'Owner, Chat 15./16.10.2026 (Neubau Sechsfamilienhaus, vier Sondereigentume; '
         + 'Planung Saile, Bauleitung Karl). ' + Q.mail_l19 + ' bestaetigt den Mietbeginn der ersten Wohnung zum 01.10.2016.', typ: 'owner', stand: '2016-12-31' },
  { objekt: 'n24', feld: 'baujahr',              zahl: 2023,         quelle: 'Owner, Chat 15./16.10.2026; Flaechenberechnung Schreiber "IST 2023 nach '
         + 'Baufertigstellung" vom 04./13.07.2023 (SharePoint 3-La Perla GmbH/N24/Maklerunterlagen)', typ: 'owner', stand: '2023-07-13' },

  // Mietspiegel: gilt fuer alle Tuttlinger Objekte, je Objekt die Baujahrklasse
  { objekt: 'l19',  feld: 'mietspiegel_stand',   text: '17. Fortschreibung, gueltig 27.07.2026 bis 27.07.2028', quelle: Q.ms26, typ: 'extern', stand: '2026-07-20' },
  { objekt: 'l19',  feld: 'mietspiegel_klasse',  text: 'Neubau ab 01.01.2011 bis 31.12.2020', quelle: Q.ms26, typ: 'extern', stand: '2026-07-20' },
  { objekt: 'l19',  feld: 'mietspiegel_wert',    zahl: 9.32,         quelle: Q.ms26 + ', mittlere Wohnlage, ueber 90 qm, mit Bad und Zentralheizung, Mittelwert', typ: 'extern', stand: '2026-07-20',
    notiz: 'Spanne 8,84 bis 9,76 EUR/qm. Die Wohnlage ist eine Arbeitsannahme — die Wohnlagenkarte wurde nicht ausgewertet.' },
  { objekt: 'mg24', feld: 'mietspiegel_stand',   text: '17. Fortschreibung, gueltig 27.07.2026 bis 27.07.2028', quelle: Q.ms26, typ: 'extern', stand: '2026-07-20' },
  { objekt: 'mg24', feld: 'mietspiegel_klasse',  text: 'Altbau 1929, modernisiert 2024 — eingestuft nach dem Zeitpunkt der Modernisierung (Neubau ab 01.01.2021)', quelle: Q.ms26, typ: 'extern', stand: '2026-07-20' },
  { objekt: 'mg24', feld: 'mietspiegel_wert',    zahl: 10.37,        quelle: Q.ms26 + ', mittlere Wohnlage, ueber 90 qm, Mittelwert', typ: 'extern', stand: '2026-07-20',
    notiz: 'Spanne 9,83 bis 10,85 EUR/qm' },
  { objekt: 'n24',  feld: 'mietspiegel_stand',   text: '17. Fortschreibung, gueltig 27.07.2026 bis 27.07.2028', quelle: Q.ms26, typ: 'extern', stand: '2026-07-20' },
  { objekt: 'n24',  feld: 'mietspiegel_klasse',  text: 'Neubau ab 01.01.2021', quelle: Q.ms26, typ: 'extern', stand: '2026-07-20' },
  { objekt: 'n24',  feld: 'mietspiegel_wert',    zahl: 10.37,        quelle: Q.ms26 + ', mittlere Wohnlage, ueber 90 qm, Mittelwert', typ: 'extern', stand: '2026-07-20',
    notiz: 'Spanne 9,83 bis 10,85 EUR/qm' },
  { objekt: 's28',  feld: 'mietspiegel_stand',   text: '17. Fortschreibung, gueltig 27.07.2026 bis 27.07.2028', quelle: Q.ms26, typ: 'extern', stand: '2026-07-20',
    notiz: 'Eine Vergleichsmiete laesst sich fuer S28 noch nicht bilden: Das Baujahr ist unbekannt, und davon haengt die Baujahrklasse ab.' },

  // ── Nachtrag 16.10.2026: Bau- und Herstellungskosten ───────────────────
  { objekt: 'n24', feld: 'herstellungskosten',   zahl: 5866953.42,   quelle: Q.bk_n24, typ: 'sharepoint', stand: '2023-08-31',
    notiz: 'Aufteilung: Gebaeude 5.388.597,86 + Aussenanlage 191.049,08 + Einrichtung 287.117,20 + '
         + 'PV-Anlage 189,28 EUR. Einschliesslich der nicht abziehbaren Vorsteuer (zwei Drittel; '
         + 'W3 und W4 werden temporaer vermietet). OHNE Grundstueck.' },
  { objekt: 'n24', feld: 'gesamtinvestition',    zahl: 6600000,      quelle: 'bikosoc properties.purchase_price_total', typ: 'db', stand: '2026-10-16',
    notiz: 'Runde Planzahl ohne Beleg — NICHT die Bezugsgroesse der Rendite, dafuer stehen die '
         + 'Anschaffungskosten gesamt daneben. Die Differenz zu den belegten 6.027.124,67 EUR '
         + 'betraegt 572.875,33 EUR und ist nicht aufgeklaert; der Grundstuecksteil erklaert sie '
         + 'nicht, der ist mit 160.171,25 EUR belegt.' },
  { objekt: 'n24', feld: 'bodenanteil',         zahl: 160171.25,
    quelle: Q.kv_n24_jb + ' + ' + Q.kv_n24_stadt + ' + ' + Q.kv_n24_schmutz, typ: 'gerechnet', stand: '2021-10-07',
    notiz: 'Reine Kaufpreise fuer Grund und Boden: 95.000,00 (Uebertragung JB an La Perla 14.12.2020) '
         + '+ 54.945,00 (Stadt Tuttlingen 02.08.2021) + 10.226,25 EUR (A. Schmutz 07.10.2021). OHNE '
         + 'den Grundstuecksanteil der Grunderwerbsteuer und ohne Notarkosten. Das ist NICHT die '
         + 'steuerliche Aufteilung Gebaeude/Boden — die entscheidet der Owner.' },
  { objekt: 'n24', feld: 'gebaeudeanteil',      zahl: 5866953.42,   quelle: Q.bk_n24, typ: 'sharepoint', stand: '2023-08-31',
    notiz: 'Entspricht den Herstellungskosten; das Grundstueck ist dort nicht enthalten.' },
  { objekt: 'n24', feld: 'anschaffungskosten',  zahl: 6027124.67,
    quelle: Q.bk_n24 + ' + ' + Q.kv_n24_jb + ' + ' + Q.kv_n24_stadt + ' + ' + Q.kv_n24_schmutz, typ: 'gerechnet', stand: '2023-08-31',
    notiz: 'Herstellungskosten 5.866.953,42 + Grundstueck 160.171,25 EUR. Die Abbruchkosten (40.000,00) '
         + 'und die Bauplanung (50.000,00 EUR) aus demselben Kaufvertrag stecken bereits im Konto 120 '
         + 'und werden hier NICHT noch einmal gezaehlt. Nicht enthalten: der Grundstuecksanteil der '
         + 'Grunderwerbsteuer und die Notarkosten — die Zahl ist also eine Untergrenze, und die '
         + 'Rendite darauf eine Obergrenze.' },
  { objekt: 'mg24', feld: 'herstellungskosten',  zahl: 2672955.35,   quelle: Q.besch_mg24, typ: 'postfach', stand: '2025-08-01',
    notiz: 'Modernisierung vom 12.04.2023 bis 31.12.2024, einschliesslich Umsatzsteuer, durch '
         + 'Originalrechnungen nachgewiesen. Abzueglich der Zuschuesse (50.000,00 EUR '
         + 'Sanierungsgebiet, ausbezahlt 11.12.2024, und weitere 90.000,00 EUR) verbleiben '
         + '2.532.955,35 EUR beguenstigte Kosten.' },
  { objekt: 'mg24', feld: 'denkmalschutz',       text: 'ja',         quelle: Q.besch_mg24 + '; Foerdergrundsaetze der Stadt Tuttlingen (Foerdersatz 35 Prozent fuer denkmalgeschuetzte Gebaeude)', typ: 'postfach', stand: '2025-08-01' },
  { objekt: 'mg24', feld: 'sanierungsgebiet',    text: 'ja',         quelle: Q.besch_mg24 + ': Sanierungssatzung vom 18.06.2018, oeffentlich bekanntgemacht am 23.06.2018', typ: 'postfach', stand: '2025-08-01' },

  // ── Nachtrag 16.10.2026: L19 aus der PST-Auswertung ────────────────────
  { objekt: 'l19', feld: 'erwerbsdatum',         datum: '2013-05-24', quelle: Q.hk_l19 + ', Konto 85 (Grundstueck)', typ: 'owner', stand: '2016-01-20' },
  { objekt: 'l19', feld: 'kaufpreis',            zahl: 160000,       quelle: Q.hk_l19 + ', Konto 85', typ: 'owner', stand: '2013-05-24' },
  { objekt: 'l19', feld: 'notarkosten',          zahl: 1072.29,      quelle: Q.hk_l19 + ', Konto 85', typ: 'owner', stand: '2013-05-24',
    notiz: 'Zwei Rechnungen: 775,29 und 297,00 EUR. Dazu 30,00 EUR Negativbescheinigung.' },
  { objekt: 'l19', feld: 'grunderwerbsteuer',    zahl: 8000,         quelle: Q.hk_l19 + ', Konto 85', typ: 'owner', stand: '2013-05-24',
    notiz: '5,0 Prozent von 160.000,00 EUR' },
  { objekt: 'l19', feld: 'bodenanteil',          zahl: 169102.29,    quelle: Q.hk_l19 + ', Konto 85', typ: 'owner', stand: '2016-01-20',
    notiz: 'Kaufpreis 160.000,00 + Notar 775,29 + 297,00 + Negativbescheinigung 30,00 + '
         + 'Grunderwerbsteuer 8.000,00 EUR, brutto' },
  { objekt: 'l19', feld: 'herstellungskosten',   zahl: 1177918.05,   quelle: Q.hk_l19 + ', Konto 150 (Wohnbauten im Bau)', typ: 'owner', stand: '2016-01-20',
    notiz: 'Brutto, darin 185.977,14 EUR Umsatzsteuer. Buchungen vom 13.11.2013 bis 30.12.2015, '
         + 'OHNE Einrichtung. Plausibilisierung: Die Kostenschaetzung des Bauleiters Anton Karl vom '
         + '27.09.2015 nannte rund 884.000 EUR Baukosten und 66.000 EUR Nebenkosten, zusammen rund '
         + '950.000 EUR — das war der Stand vor den Schlussrechnungen (' + Q.karl_l19 + ').' },
  { objekt: 'l19', feld: 'gebaeudeanteil',       zahl: 1177918.05,   quelle: Q.hk_l19 + ', Konto 150', typ: 'owner', stand: '2016-01-20' },
  { objekt: 'l19', feld: 'anschaffungskosten',   zahl: 1347020.34,   quelle: Q.hk_l19, typ: 'owner', stand: '2016-01-20',
    notiz: 'Grundstueck 169.102,29 + Gebaeude 1.177.918,05 EUR, brutto. STAND 01/2016: Moegliche '
         + 'Nachrechnungen aus 2016 bis zur Schlussabnahme am 25.11.2016 sind nicht enthalten. '
         + 'Die Vorsteuer war teilweise abziehbar (Quote 43,2 Prozent laut Aufstellung); im '
         + 'Steckbrief wird brutto gefuehrt. In properties.purchase_price_total stehen 1.400.000,00 '
         + 'EUR — 52.979,66 EUR mehr, vermutlich Einrichtung und Nachrechnungen 2016. '
         + 'ZUR RENDITE: W3 und W4+ sind eigengenutzt, vermietet sind 255,70 von 438,99 qm '
         + '(58,25 Prozent). Auf den vermieteten Anteil der Kosten (784.603,52 EUR) gerechnet, '
         + 'ergeben 40.140,00 EUR Jahressoll rund 5,1 Prozent; auf das ganze Haus 2,98 Prozent. '
         + 'Die Kachel rechnet beides selbst (Feld bruttomietrendite_vermietet).' },
  { objekt: 'l19', feld: 'kfw_standard',         text: 'KfW-Effizienzhaus 55',
    quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16',
    notiz: 'Beleghinweis: Fuer den L-Bank- beziehungsweise KfW-Kredit (angefragt 50.000 EUR je '
         + 'Wohneinheit) wurde 2014 eine Effizienzhaus-Bestaetigung ausgestellt — Mails Anton Karl '
         + 'vom 18.03.2014 und 27.05.2014. Die Bestaetigung selbst liegt weder in SharePoint noch '
         + 'im heutigen Postfach; den Standard 55 hat der Owner am 16.10.2026 bestaetigt. '
         + 'NACHGESUCHT AM 18.10.2026, erfolglos, und zwar in: SharePoint-Index (12.266 Dateien), '
         + 'Postfach info@l19.de, Postfach doris.hilsenbeck@bikolino.com und im Yahoo-Archiv der '
         + 'Jahre 2013 bis 2017 (Begriffe Effizienzhaus, Energieausweis, KfW, L-Bank, Anton Karl, '
         + 'Leutenbergstr). GRUND, warum weiteres Suchen dort nichts bringt: Zu L19 gibt es in '
         + 'SharePoint ueberhaupt keine Gebaeudeakte. Gebaeudeakten existieren nur fuer MG24 '
         + '(2.885 Dateien) und N24 (1.660); die aeltesten L19-Dateien stammen von 2017. Die '
         + 'Bauunterlagen 2013 bis 2016 sind nie digitalisiert worden. Zu suchen waere noch: '
         + 'S&B-PST (dort fand der Owner die Karl-Mails), Papierakte, L-Bank als '
         + 'Kreditgeber, oder der Sachverstaendige, der die Bestaetigung unterschrieben hat.' },

  // ── Nachtrag 16.10.2026, 10:43: Owner-Angaben ──────────────────────────
  { objekt: 's28',  feld: 'baujahr',    zahl: 1967,                 quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16' },
  { objekt: 'd4',   feld: 'bauweise',   text: 'Massivbauweise',     quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16' },
  { objekt: 'i83',  feld: 'bauweise',   text: 'Massivbauweise',     quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16' },
  { objekt: 'mg22', feld: 'bauweise',   text: 'Massivbauweise',     quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16' },
  { objekt: 'mg24', feld: 'bauweise',   text: 'Massivbauweise',     quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16' },
  { objekt: 's28',  feld: 'bauweise',   text: 'Massivbauweise',     quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16' },
  { objekt: 'l19',  feld: 'bauweise',   text: 'Massivbauweise: Wände aus Porenbeton (Ytong), Außenputz, innen Kalkputz',
    quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16' },
  { objekt: 'n24',  feld: 'bauweise',   text: 'Holzbau',            quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16' },
  // Energietraeger folgt aus der Heizart — abgeleitet, nicht geraten.
  { objekt: 'd4',   feld: 'energietraeger', text: 'Gas',   quelle: 'abgeleitet aus der Heizart (bikosoc-Stammdaten: properties.heating_type = gas)', typ: 'gerechnet', stand: '2026-10-16' },
  { objekt: 'i83',  feld: 'energietraeger', text: 'Gas',   quelle: 'abgeleitet aus der Heizart (bikosoc-Stammdaten: properties.heating_type = gas)', typ: 'gerechnet', stand: '2026-10-16' },
  { objekt: 's28',  feld: 'energietraeger', text: 'Heizöl', quelle: 'abgeleitet aus der Heizart (bikosoc-Stammdaten: properties.heating_type = oil)', typ: 'gerechnet', stand: '2026-10-16' },
  { objekt: 'l19',  feld: 'energietraeger', text: 'Strom',  quelle: 'abgeleitet aus der Heizart (bikosoc-Stammdaten: properties.heating_type = heat_pump)', typ: 'gerechnet', stand: '2026-10-16' },
  { objekt: 'mg22', feld: 'energietraeger', text: 'keiner (unbeheizte Garagen)', quelle: 'bikosoc-Stammdaten: properties.heating_type = none; drei Garagen ohne Heizung', typ: 'db', stand: '2026-10-16' },
  { objekt: 'n24',  feld: 'energieausweis_bis', datum: '2033-05-10', quelle: Q.ea_n24 + ', ausgestellt am 10.05.2023, Registriernummer BW-2023-004539611', typ: 'gerechnet', stand: '2023-05-10',
    notiz: 'Zehn Jahre ab Ausstellung nach Paragraf 79 Abs. 4 GEG.' },
  // ── Nachtrag 16.10.2026, 11:00: Owner-Korrekturen ─────────────────────
  /* MG22 sind drei unbeheizte Garagen. Fuer ein Gebaeude ohne Heizung und ohne
     Klimatisierung verlangt Paragraf 80 GEG keinen Energieausweis. Das Feld
     stand deshalb zu Unrecht als Luecke in der Vollstaendigkeit; es zaehlt ab
     jetzt als beantwortet — die Antwort lautet nur eben "entfaellt". */
  { objekt: 'mg22', feld: 'energieausweis_art',    text: 'nicht erforderlich (unbeheizte Garagen)', quelle: Q.ea_mg22, typ: 'gerechnet', stand: '2026-10-16' },
  { objekt: 'mg22', feld: 'energieausweis_wert',   text: 'nicht erforderlich (unbeheizte Garagen)', quelle: Q.ea_mg22, typ: 'gerechnet', stand: '2026-10-16' },
  { objekt: 'mg22', feld: 'energieausweis_klasse', text: 'nicht erforderlich (unbeheizte Garagen)', quelle: Q.ea_mg22, typ: 'gerechnet', stand: '2026-10-16' },
  { objekt: 'mg22', feld: 'energieausweis_bis',    text: 'nicht erforderlich (unbeheizte Garagen)', quelle: Q.ea_mg22, typ: 'gerechnet', stand: '2026-10-16' },

  { objekt: 'n24',  feld: 'kfw_standard', text: 'KfW-Effizienzhaus 40 Plus', quelle: Q.owner1610, typ: 'owner', stand: '2026-10-16',
    notiz: 'Owner 16.10.2026: bewusst der hoechstmoegliche Standard. Das erklaert die niedrige '
         + 'Bruttomietrendite von 1,29 Prozent — die Ausfuehrung waere nach Einschaetzung des '
         + 'Owners rund 1,5 Mio. EUR guenstiger moeglich gewesen. Bei der Renditeanzeige fuer N24 '
         + 'als Hinweis zeigen.' },
];

/* Pruefung vor dem Schreiben: "Anschaffungskosten gesamt" ist die Bezugsgroesse
   der Rendite und muss die Herstellungs- beziehungsweise Modernisierungskosten
   enthalten. Steht dort weniger, ist nur der Erwerbsteil erfasst — genau der
   Fehler, der fuer MG24 eine Rendite von 19,2 statt 2,27 Prozent ergeben haette.
   Lieber hier abbrechen als eine falsche Kennzahl auf die Kachel schreiben. */
{
  const je = new Map<string, { ak?: number; hk?: number }>();
  for (const e of EINTRAEGE) {
    if (e.zahl === undefined) continue;
    if (e.feld !== 'anschaffungskosten' && e.feld !== 'herstellungskosten') continue;
    const m = je.get(e.objekt) || {};
    if (e.feld === 'anschaffungskosten') m.ak = e.zahl; else m.hk = e.zahl;
    je.set(e.objekt, m);
  }
  const krumm = [...je.entries()].filter(([, m]) => m.ak !== undefined && m.hk !== undefined && m.ak < m.hk);
  if (krumm.length) {
    console.error('Anschaffungskosten kleiner als Herstellungskosten — das Feld ist "gesamt" gemeint:');
    for (const [o, m] of krumm) console.error(`  ${o}: ${m.ak} < ${m.hk}`);
    process.exit(3);
  }
}

const apply = process.argv.includes('--apply');
if (!(await steckbriefBereit())) {
  console.error('V043 ist nicht angewandt — der Steckbrief hat noch keine Tabellen.');
  process.exit(2);
}

const { rows: objekte } = await query<any>(`SELECT id, code FROM properties`);
const idVon = new Map<string, number>(objekte.map((o: any) => [o.code, o.id]));

let geschrieben = 0; const fehlend: string[] = [];
for (const e of EINTRAEGE) {
  const id = idVon.get(e.objekt);
  if (!id) { fehlend.push(`${e.objekt} (Objekt unbekannt)`); continue; }
  const wert = e.text ?? e.datum ?? (e.zahl !== undefined ? String(e.zahl) : '');
  console.log(`${e.objekt.padEnd(6)} ${e.feld.padEnd(22)} ${String(wert).slice(0, 44).padEnd(46)} ${e.typ}`);
  if (!apply) continue;
  await setzeFeld({
    property_id: id, feld: e.feld,
    wert_text: e.text ?? null, wert_zahl: e.zahl ?? null, wert_datum: e.datum ?? null,
    quelle: e.quelle, quelle_typ: e.typ, stand: e.stand, notes: e.notiz ?? null,
  });
  geschrieben++;
}

console.log(`\n${apply ? 'geschrieben' : 'zu schreiben'}: ${EINTRAEGE.length} Werte`
  + (fehlend.length ? `, uebersprungen: ${fehlend.join(', ')}` : ''));

if (apply) {
  console.log('\nVollstaendigkeit je Objekt:');
  for (const o of objekte) {
    const v = await vollstaendigkeit(o.id);
    console.log(`  ${o.code.padEnd(6)} ${String(v.prozent).padStart(3)} %  (${v.belegt} von ${v.pflicht} Pflichtfeldern)`);
  }
}
process.exit(0);
