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
  owner_l19: 'Owner-Angabe 16.10.2026; Grundlage Teilungsunterlagen Saile vom 30.11.2015. '
       + 'Die Unterlagen selbst liegen noch nicht vor (Owner legt sie in Dropbox transfer/L19-Teilung ab).',
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
  { objekt: 'mg24', feld: 'anschaffungskosten',  zahl: 359267.68,    quelle: Q.kv_mg + ' + ' + Q.grest_mg, typ: 'gerechnet', stand: '2021-12-01',
    notiz: 'Kaufpreis + Grunderwerbsteuer + Notar; Grundbuchkosten fehlen noch' },
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
  { objekt: 'l19', feld: 'flurstueck',           text: '8414/2',     quelle: Q.owner_l19, typ: 'owner', stand: '2015-11-30' },
  { objekt: 'l19', feld: 'grundstuecksflaeche',  zahl: 562,          quelle: Q.owner_l19, typ: 'owner', stand: '2015-11-30' },
  { objekt: 'l19', feld: 'wohnflaeche',          zahl: 438.99,       quelle: Q.owner_l19, typ: 'owner', stand: '2015-11-30',
    notiz: 'vier Sondereigentume laut Teilung' },
];

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
