/**
 * scripts/zaehler-l19-s28 — Zähler und Zählerstände für L19 und S28 anlegen.
 *
 * QUELLEN
 *
 * L19 (Leutenbergstraße 19, Tuttlingen, eddi24-Objekt 0030757-1)
 *   - Stände 31.12.2023 und 31.12.2024: eddi24-Abrechnung 2024, erstellt am
 *     21.12.2025, Abschnitte „Wärmemengenzählerstände der Nutzer",
 *     „Wasserzählerstände der Nutzer" und „Liegenschaftszähler".
 *   - Stände Jahresende 2025: Zählerfotos vom 23.12.2025 (App-3, App-4, Haus),
 *     28.12.2025 (App-2) und 03.01.2026 (App-1), Bild für Bild abgelesen.
 *   - Die Fotos vom 02./03./12.01.2025 sind NICHT gesondert erfasst: Sie zeigen
 *     exakt die Werte, die eddi24 als Stand 31.12.2024 abgerechnet hat (geprüft
 *     für alle acht Wohnungszähler). Der eddi24-Wert ist der genauere Anker,
 *     weil er auf den Stichtag fällt.
 *
 * S28 (Schönhalde 28, Tuttlingen)
 *   - Stände 02.04.2025 und 24.04.2025: Zählerstandsdokumente mit Fotos,
 *     erstellt am 02.04.2025, aktualisiert am 26.05.2025.
 *   - Stände 31.12.2025: Ablesetabelle vom 21.01.2026.
 *   - Hauptwasserzähler und Allgemeinstrom zum Jahreswechsel: SWT-Rechnung
 *     0001-ARV-2025-27911 vom 08.01.2026 (Kd 133224-339065).
 *
 * ZUR EINHEIT DER L19-ZÄHLER. Alle acht Wohnungszähler sind baugleiche
 * WDV-Molliné Ultramess C. Auf den Fotos ist nicht zu erkennen, welche
 * Einheitenanzeige des Displays aktiv ist — die Legenden „MWh", „m³" und „kW"
 * sind fest aufgedruckt. Maßgeblich ist deshalb die Einordnung von eddi24: vier
 * Geräte als Wärmemengenzähler in MWh, vier als Kaltwasserzähler in m³. Die
 * Größenordnung bestätigt das; als MWh wären die Wasserwerte für eine Wohnung
 * nicht möglich. In der Notiz jedes betroffenen Zählers steht dieser Befund.
 *
 * Geschrieben wird über die bestehenden Core-Routen mit Audit. Mehrfacher
 * Aufruf ist unschädlich.
 *
 * Aufruf:  bun run scripts/zaehler-l19-s28.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';

const BELEG_EDDI24 = '5-L19/Nebenkostenabrechnungen Mieter/2024/Abrechnungen in 2025 erstellt/'
  + '{HK/Uebersicht_HK_21.12.2025 12_47.pdf | NK/Uebersicht_NK_21.12.2025 14_12.pdf}';
const FOTO_2025 = '5-L19/Nebenkostenabrechnungen Mieter/2025/';
const S28_FOTO = '11-S28/Haustechnik/Zählerstände/';
const S28_TABELLE = S28_FOTO + 'Zählerstände 02.04.2025 bis 31.12.2025/'
  + 'S28_Kalt+Warmwasser_Ablesewerte 02.04.2025 bis 31.12.2025.pdf';
const SWT_S28 = '/Apps/bikosoc-reports/bikosoc-reports/transfer/SWT-Rechnungen/'
  + 'SWT_2026-01-08_Sch_nhalde_28_339065_0001-ARV-2025-27911.pdf';

/** Hinweis für die vier L19-Geräte, die eddi24 als Kaltwasserzähler führt. */
const BEFUND_ULTRAMESS = 'BEFUND: Das Gerät ist ein WDV-Molliné Ultramess C, baugleich mit '
  + 'den vier Wärmemengenzählern der Liegenschaft, und sitzt auf einer gedämmten Leitung. '
  + 'eddi24 führt es als Kaltwasserzähler und verteilt damit die Wasserkosten (VKW). Ob '
  + 'das Gerät Trinkwasser oder das Volumen des Heizkreises misst, ist aus den Fotos nicht '
  + 'zu entscheiden; die Größenordnung der Werte passt zu Kubikmetern. Vor der ersten '
  + 'Abrechnung mit bikosoc zu klären.';

interface Zaehler {
  objekt: 'l19' | 's28';
  nummer: string;
  medium: 'heat' | 'cold_water' | 'warm_water' | 'electricity';
  zweck?: string | null;
  einheit: string;
  /** bikosoc-Einheitencode, leer für Liegenschaftszähler. */
  wohnung?: string;
  hauptzaehler?: boolean;
  notiz: string;
  staende: { tag: string; wert: number; typ: string; quelle: string; geschaetzt?: boolean;
    methode?: string; leser: string; beleg: string; notiz?: string }[];
}

const EDDI = (art: string) => `eddi24-Abrechnung 2024, Objekt 0030757-1, Abschnitt „${art}". `
  + 'Erstellt am 21.12.2025.';

function l19Wohnung(nr: string, code: string, bez: string, wmz: boolean,
  a23: number, a24: number, ende: number, endeTag: string, foto: string): Zaehler {
  return {
    objekt: 'l19', nummer: nr, medium: wmz ? 'heat' : 'cold_water',
    zweck: wmz ? 'space_heating_heat' : null,
    einheit: wmz ? 'MWh' : 'm3', wohnung: code,
    notiz: `${bez}. WDV-Molliné Ultramess C. In der eddi24-Abrechnung 2024 geführt als `
      + `${wmz ? 'WMZ (MWh)' : 'KWZ (m³)'}.` + (wmz ? '' : ' ' + BEFUND_ULTRAMESS),
    staende: [
      { tag: '2023-12-31', wert: a23, typ: 'annual', quelle: 'manual',
        leser: 'eddi24', beleg: BELEG_EDDI24,
        notiz: EDDI(wmz ? 'Wärmemengenzählerstände der Nutzer' : 'Wasserzählerstände der Nutzer') },
      { tag: '2024-12-31', wert: a24, typ: 'annual', quelle: 'manual',
        leser: 'eddi24', beleg: BELEG_EDDI24,
        notiz: EDDI(wmz ? 'Wärmemengenzählerstände der Nutzer' : 'Wasserzählerstände der Nutzer')
          + ' Die Zählerfotos vom 02./03./12.01.2025 zeigen exakt diesen Wert.' },
      { tag: endeTag, wert: ende, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung, Zählerfoto', beleg: FOTO_2025 + foto,
        notiz: 'Vom Zählerfoto abgelesen. Jahresendstand 2025.' },
    ],
  };
}

const ZAEHLER: Zaehler[] = [
  // ── L19 Wohnungszähler ───────────────────────────────────────────────────
  l19Wohnung('53650410', 'W1', 'Wärmemenge Wohnung 1-1 Erdgeschoss', true,
    15.834, 17.553, 19.378, '2026-01-03', 'Zählerstände_20260103_App-1.pdf'),
  l19Wohnung('53650736', 'W2', 'Wärmemenge Wohnung 2-1 1. Obergeschoss', true,
    10.815, 14.591, 18.177, '2025-12-28', 'Zählerstände_20251228_App-2.pdf'),
  l19Wohnung('53650511', 'W3', 'Wärmemenge Wohnung 3-1 2. Obergeschoss links', true,
    5.123, 6.626, 7.040, '2025-12-23', 'Zählerstände_20251223_App-3.pdf'),
  l19Wohnung('53650519', 'W4+', 'Wärmemenge Wohnung 4-1 2. Obergeschoss rechts', true,
    5.790, 6.493, 6.912, '2025-12-23', 'Zählerstände_20251223_App-4.pdf'),
  l19Wohnung('53650437', 'W1', 'Wasser Wohnung 1-1 Erdgeschoss', false,
    65.916, 73.932, 81.226, '2026-01-03', 'Zählerstände_20260103_App-1.pdf'),
  l19Wohnung('53650518', 'W2', 'Wasser Wohnung 2-1 1. Obergeschoss', false,
    52.454, 56.112, 60.789, '2025-12-28', 'Zählerstände_20251228_App-2.pdf'),
  l19Wohnung('53650734', 'W3', 'Wasser Wohnung 3-1 2. Obergeschoss links', false,
    42.954, 49.676, 55.027, '2025-12-23', 'Zählerstände_20251223_App-3.pdf'),
  l19Wohnung('53650737', 'W4+', 'Wasser Wohnung 4-1 2. Obergeschoss rechts', false,
    69.769, 80.489, 89.512, '2025-12-23', 'Zählerstände_20251223_App-4.pdf'),

  // ── L19 Liegenschaftszähler ──────────────────────────────────────────────
  {
    objekt: 'l19', nummer: '40450611', medium: 'cold_water', einheit: 'm3',
    hauptzaehler: true,
    notiz: 'Gemeindewasserzähler der Liegenschaft, WDV-Molliné SensoStar 2. In der '
      + 'eddi24-Abrechnung 2024 mit der Funktion „nur informativ" geführt — die Wasserkosten '
      + 'werden dort vollständig auf die Wohnungszähler verteilt. In bikosoc ist er der '
      + 'Nenner: der ungemessene Rest bleibt beim Eigentümer. 2024 standen 43,169 m³ am '
      + 'Hausanschluss gegen 29,116 m³ in den Wohnungen (32,6 % ungemessen).',
    staende: [
      { tag: '2023-12-31', wert: 319.543, typ: 'annual', quelle: 'manual', leser: 'eddi24',
        beleg: BELEG_EDDI24, notiz: EDDI('Liegenschaftszähler') },
      { tag: '2024-12-31', wert: 362.712, typ: 'annual', quelle: 'manual', leser: 'eddi24',
        beleg: BELEG_EDDI24, notiz: EDDI('Liegenschaftszähler') },
      { tag: '2025-12-23', wert: 400.577, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung, Zählerfoto', beleg: FOTO_2025 + 'Zählerstände_20251223_Haus.pdf',
        notiz: 'Vom Zählerfoto abgelesen. Jahresendstand 2025.' },
    ],
  },
  {
    objekt: 'l19', nummer: '1APA015114436', medium: 'electricity', einheit: 'kWh',
    hauptzaehler: true,
    notiz: 'Stromzähler der WÄRMEPUMPE, Apator PICUS eHZ, Zweirichtungszähler, im '
      + 'Zählerschrank mit „Waermepumpe" beschriftet. Liefert die Energie, die die '
      + 'eddi24-Abrechnung als „Brennstoffbezug Stadtwerke: Wärmepumpe" abrechnet (2024: '
      + '12.742 kWh). Der Stand zum 23.12.2025 ist die Summe der Register 1.8.1 (11.275 kWh) '
      + 'und 1.8.2 (7.327 kWh). FEHLT: ein Stand zum Jahreswechsel 2024/25 — ohne ihn ist '
      + 'der Verbrauch 2025 nicht bestimmbar.',
    staende: [
      { tag: '2025-12-23', wert: 18602, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung, Zählerfoto', beleg: FOTO_2025 + 'Zählerstände_20251223_Haus.pdf',
        notiz: 'Vom Zählerfoto abgelesen: Register 1.8.1 = 11.275 kWh, Register 1.8.2 = '
          + '7.327 kWh, Summe 18.602 kWh.' },
    ],
  },
  {
    objekt: 'l19', nummer: '1APA015114433', medium: 'electricity', einheit: 'kWh',
    hauptzaehler: true,
    notiz: 'ALLGEMEINSTROM der Liegenschaft, Apator PICUS eHZ, im Zählerschrank mit '
      + '„Allgemein" beschriftet. Entspricht der Position „Allgemeinstrom — Stadtwerke: '
      + 'Gemeinschaftsanlage" der eddi24-Abrechnung 2024 (238,12 €). Register 2.8.0 '
      + '(Einspeisung) steht auf 0. FEHLT: ein Stand zum Jahreswechsel 2024/25.',
    staende: [
      { tag: '2025-12-23', wert: 1367, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung, Zählerfoto', beleg: FOTO_2025 + 'Zählerstände_20251223_Haus.pdf',
        notiz: 'Vom Zählerfoto abgelesen: Register 1.8.0 = 1.367 kWh.' },
    ],
  },

  // ── S28 ──────────────────────────────────────────────────────────────────
  {
    objekt: 's28', nummer: '2201028', medium: 'cold_water', einheit: 'm3', hauptzaehler: true,
    notiz: 'Hauptwasserzähler der Liegenschaft, zugleich Abrechnungszähler der Stadtwerke '
      + 'Tuttlingen (Kd 133224-339065, Verträge 189569 Wasser und 189573 Schmutzwasser).',
    staende: [
      { tag: '2023-12-31', wert: 260, typ: 'annual', quelle: 'manual', geschaetzt: true,
        methode: 'Hochrechnung System der Stadtwerke Tuttlingen',
        leser: 'SWT-Rechnung 0001-ARV-2025-27911', beleg: SWT_S28,
        notiz: 'Ablesekennzeichen „Hochrechnung System". Keine Ablesung.' },
      { tag: '2024-12-31', wert: 365, typ: 'annual', quelle: 'manual', geschaetzt: true,
        methode: 'Hochrechnung System der Stadtwerke Tuttlingen',
        leser: 'SWT-Rechnung 0001-ARV-2025-27911', beleg: SWT_S28,
        notiz: 'Ablesekennzeichen „Hochrechnung System". Berechnungsgrundlage ist laut '
          + 'Rechnung der Stand 377 m³ vom 13.02.2025. Dies ist der Anfangsstand 2025.' },
      { tag: '2025-02-13', wert: 377, typ: 'interim', quelle: 'manual',
        leser: 'Stadtwerke Tuttlingen', beleg: SWT_S28,
        notiz: 'Echte Ablesung, in der SWT-Rechnung als Berechnungsgrundlage für den '
          + 'hochgerechneten Stand zum 31.12.2024 genannt.' },
      { tag: '2025-04-02', wert: 397, typ: 'interim', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_TABELLE,
        notiz: 'Ablesung am 02.04.2025, Beginn der Owner-Ablesereihe.' },
      { tag: '2025-11-08', wert: 506, typ: 'interim', quelle: 'manual',
        leser: 'Owner-Ablesung, an die Stadtwerke gemeldet', beleg: SWT_S28,
        notiz: 'Ablesekennzeichen „Ablesung Kunde" in der SWT-Rechnung.' },
      { tag: '2025-12-31', wert: 536, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_TABELLE,
        notiz: 'Jahresendstand 2025 aus der Ablesetabelle vom 21.01.2026.' },
    ],
  },
  {
    objekt: 's28', nummer: 'BWGN0023133801', medium: 'cold_water', einheit: 'm3', wohnung: 'W2',
    notiz: 'Kaltwasser Hauptwohnung Obergeschoss. Seriennummer nach dem Geräteschild im '
      + 'Foto vom 02.04.2025. ABWEICHUNG: Die Ablesetabelle vom 21.01.2026 führt denselben '
      + 'Zähler als „8WGN0023133801" — eine Ziffer Unterschied. Maßgeblich ist hier das '
      + 'Geräteschild.',
    staende: [
      { tag: '2025-04-02', wert: 10.5915, typ: 'move_in', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_FOTO + 'Hauptwohnung/2025-04-02_S28_Miguel Santarcieri_Zählerstände_aktualisert Zählertausch SWT am 24.04.2025.pdf',
        notiz: 'Ablesung einen Tag nach Mietbeginn (01.04.2025).' },
      { tag: '2025-12-31', wert: 60.747, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_TABELLE, notiz: 'Jahresendstand 2025.' },
    ],
  },
  {
    objekt: 's28', nummer: '9WGNWG24111294', medium: 'cold_water', einheit: 'm3', wohnung: 'W2',
    notiz: 'Kaltwasser Hauptwohnung Obergeschoss, Anbau/Wintergarten. Zweiter '
      + 'Kaltwasserzähler derselben Wohnung.',
    staende: [
      { tag: '2025-04-02', wert: 0.2145, typ: 'move_in', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_FOTO + 'Hauptwohnung/2025-04-02_1.OG_Kaltwasser Anbau_SN_9WGNWG24111294.jpg',
        notiz: 'Ablesung einen Tag nach Mietbeginn (01.04.2025).' },
      { tag: '2025-12-31', wert: 11.962, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_TABELLE, notiz: 'Jahresendstand 2025.' },
    ],
  },
  {
    objekt: 's28', nummer: '2481442005', medium: 'warm_water', einheit: 'm3', wohnung: 'W2',
    notiz: 'Warmwasser Hauptwohnung Obergeschoss. Seriennummer nach dem Geräteschild im '
      + 'Foto vom 02.04.2025. ABWEICHUNG: Die Ablesetabelle führt „2481442004" — eine Ziffer '
      + 'Unterschied. Maßgeblich ist hier das Geräteschild.',
    staende: [
      { tag: '2025-04-02', wert: 0.912, typ: 'move_in', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_FOTO + 'Hauptwohnung/2025-04-02_1.OG_Warmwasser_SN2481442005.jpg',
        notiz: 'Ablesung einen Tag nach Mietbeginn (01.04.2025).' },
      { tag: '2025-12-31', wert: 16.794, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_TABELLE, notiz: 'Jahresendstand 2025.' },
    ],
  },
  {
    objekt: 's28', nummer: '23000185404', medium: 'cold_water', einheit: 'm3', wohnung: 'W1',
    notiz: 'Kaltwasser Einliegerwohnung Erdgeschoss. Seriennummer nach dem Geräteschild im '
      + 'Foto vom 02.04.2025. ABWEICHUNG: Die Ablesetabelle führt „2300185404" — eine Ziffer '
      + 'weniger. Maßgeblich ist hier das Geräteschild.',
    staende: [
      { tag: '2025-04-02', wert: 68.748, typ: 'interim', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_FOTO + 'Einliegerwohnung/2025-04-02_Einlieger_Kaltwasser_SN23000185404.jpg',
        notiz: 'Zwischenablesung. Das Mietverhältnis läuft seit dem 01.03.2024 weiter.' },
      { tag: '2025-12-31', wert: 103.684, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_TABELLE, notiz: 'Jahresendstand 2025.' },
    ],
  },
  {
    objekt: 's28', nummer: '2300199115', medium: 'warm_water', einheit: 'm3', wohnung: 'W1',
    notiz: 'Warmwasser Einliegerwohnung Erdgeschoss.',
    staende: [
      { tag: '2025-04-02', wert: 40.247, typ: 'interim', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_FOTO + 'Einliegerwohnung/2025-04-02_Einlieger_Warmwasser_2300199115.jpg',
        notiz: 'Zwischenablesung. Das Mietverhältnis läuft seit dem 01.03.2024 weiter.' },
      { tag: '2025-12-31', wert: 56.609, typ: 'annual', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_TABELLE, notiz: 'Jahresendstand 2025.' },
    ],
  },
  {
    objekt: 's28', nummer: '44085877', medium: 'electricity', einheit: 'kWh', wohnung: 'W2',
    notiz: 'ZWISCHENSTROMZÄHLER der Hauptwohnung, hinter dem Hauptstromzähler der '
      + 'Liegenschaft. AM 24.04.2025 VON FA. WALDMANN GEGEN EINEN SWT-ZÄHLER GETAUSCHT; '
      + 'seither rechnet der Mieter direkt mit den Stadtwerken ab. Ab diesem Tag ist der '
      + 'Strom der Hauptwohnung keine Nebenkostenposition mehr.',
    staende: [
      { tag: '2025-04-02', wert: 37201.25, typ: 'move_in', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_FOTO + 'Hauptwohnung/2025-04-02_Zwischenstromzähler_1.OG_SN44085877.jpg',
        notiz: 'Ablesung einen Tag nach Mietbeginn (01.04.2025).' },
      { tag: '2025-04-24', wert: 37319.23, typ: 'move_out', quelle: 'manual',
        leser: 'Fa. Waldmann beim Zählertausch', beleg: S28_FOTO + 'Hauptwohnung/2025-04-02_S28_Miguel Santarcieri_Zählerstände_aktualisert Zählertausch SWT am 24.04.2025.pdf',
        notiz: 'Endstand beim Ausbau am 24.04.2025.' },
    ],
  },
  {
    objekt: 's28', nummer: '1APA0116005300', medium: 'electricity', einheit: 'kWh',
    hauptzaehler: true,
    notiz: 'HAUPTSTROMZÄHLER der Liegenschaft, Abrechnungszähler der Stadtwerke Tuttlingen '
      + '(Kd 133224-339065, Vertrag 189545, Marktlokation 51422547980). Im Fotodokument als '
      + '„Hauptstromzähler Einliegerwohnung" bezeichnet, weil er die Einliegerwohnung '
      + 'unmittelbar versorgt; der Zwischenzähler 44085877 trennte davon die Hauptwohnung ab. '
      + 'AM 26./27.11.2025 AUSGEBAUT und durch 1ISK0092761948 ersetzt.',
    staende: [
      { tag: '2023-12-31', wert: 6254, typ: 'annual', quelle: 'manual', geschaetzt: true,
        methode: 'Hochrechnung der Stadtwerke Tuttlingen',
        leser: 'SWT-Rechnung 0001-ARV-2025-27911', beleg: SWT_S28, notiz: 'Ablesekennzeichen „Hochrechnung".' },
      { tag: '2024-12-31', wert: 10654, typ: 'annual', quelle: 'manual', geschaetzt: true,
        methode: 'Hochrechnung System der Stadtwerke Tuttlingen',
        leser: 'SWT-Rechnung 0001-ARV-2025-27911', beleg: SWT_S28,
        notiz: 'Ablesekennzeichen „Hochrechnung System". Dies ist der Anfangsstand 2025.' },
      { tag: '2025-04-02', wert: 11935, typ: 'interim', quelle: 'manual',
        leser: 'Owner-Ablesung vor Ort', beleg: S28_FOTO + 'Einliegerwohnung/2025-04-02_Hauptstromzähler_Einlieger_SN_1APA0116005300.jpg',
        notiz: 'Zwischenablesung.' },
      { tag: '2025-04-24', wert: 12063, typ: 'interim', quelle: 'manual',
        leser: 'Fa. Waldmann beim Tausch des Zwischenzählers', beleg: S28_FOTO + 'Einliegerwohnung/2025-04-02_S28_Shaqir Krasniqi_Zählerstände_aktualisiert 26.05.2025.pdf',
        notiz: 'Stand am Tag des Zählertauschs der Hauptwohnung.' },
      { tag: '2025-11-26', wert: 13299, typ: 'move_out', quelle: 'manual',
        leser: 'Ablesung Netzbetreiber', beleg: SWT_S28,
        notiz: 'Ablesekennzeichen „Ablesung Netzbetreiber". Endstand beim Ausbau.' },
    ],
  },
  {
    objekt: 's28', nummer: '1ISK0092761948', medium: 'electricity', einheit: 'kWh',
    hauptzaehler: true,
    notiz: 'NACHFOLGER des Hauptstromzählers 1APA0116005300, eingebaut am 27.11.2025. '
      + 'Beginnt bei 0 kWh. Quelle: SWT-Rechnung 0001-ARV-2025-27911.',
    staende: [
      { tag: '2025-11-27', wert: 0, typ: 'meter_reset', quelle: 'manual',
        leser: 'Stadtwerke Tuttlingen', beleg: SWT_S28,
        notiz: 'Einbaustand 0 kWh. FEHLT: der Stand zum 31.12.2025.' },
    ],
  },
];

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt`);
  return treffer[1].trim();
}

async function ruf(pfad: string, methode = 'GET', rumpf?: unknown, idempotenz?: string) {
  const kopf: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env('CORE_SERVICE_TOKEN')}`,
    'X-Actor': 'owner',
  };
  if (idempotenz) kopf['Idempotency-Key'] = idempotenz;
  const res = await fetch(`${BASIS}${pfad}`, {
    method: methode, headers: kopf, ...(rumpf ? { body: JSON.stringify(rumpf) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${methode} ${pfad} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const anwenden = process.argv.includes('--apply');

  const { rows: objekte } = await dbQuery<any>(
    "SELECT id, code FROM properties WHERE code IN ('l19','s28')");
  const objektId = new Map<string, number>(objekte.map(o => [o.code, o.id]));
  const { rows: einheiten } = await dbQuery<any>(
    'SELECT u.id, u.code, p.code AS objekt FROM units u JOIN properties p ON u.property_id = p.id '
    + "WHERE p.code IN ('l19','s28')");
  const einheitId = new Map<string, number>(einheiten.map(u => [`${u.objekt}/${u.code}`, u.id]));

  const { rows: bestand } = await dbQuery<any>(
    `SELECT m.id, m.meter_number, COALESCE(p1.code, p2.code) AS objekt FROM meters m
       LEFT JOIN properties p1 ON m.property_id = p1.id
       LEFT JOIN units u ON m.unit_id = u.id
       LEFT JOIN properties p2 ON u.property_id = p2.id
      WHERE COALESCE(p1.code, p2.code) IN ('l19','s28')`);
  const idVon = new Map<string, number>(bestand.map(m => [`${m.objekt}/${m.meter_number}`, m.id]));

  let neueZaehler = 0; let neueStaende = 0;
  let objektJetzt = '';
  for (const z of ZAEHLER) {
    if (z.objekt !== objektJetzt) { objektJetzt = z.objekt; console.log(`\n=== ${z.objekt.toUpperCase()} ===`); }
    const schluessel = `${z.objekt}/${z.nummer}`;
    let meterId = idVon.get(schluessel);
    const ort = z.wohnung ? z.wohnung : 'Liegenschaft';
    if (!meterId) {
      console.log(`${z.nummer.padEnd(16)} ${z.medium.padEnd(13)} ${z.einheit.padEnd(4)} ${ort.padEnd(13)} anlegen`);
      if (anwenden) {
        const unitId = z.wohnung ? einheitId.get(`${z.objekt}/${z.wohnung}`) : null;
        if (z.wohnung && !unitId) throw new Error(`Einheit ${z.objekt}/${z.wohnung} fehlt`);
        const erzeugt: any = await ruf('/api/assets/meters', 'POST', {
          scope_type: z.wohnung ? 'unit' : 'property',
          unit_id: unitId ?? null,
          property_id: z.wohnung ? null : objektId.get(z.objekt),
          medium: z.medium,
          meter_number: z.nummer,
          is_main_meter: z.hauptzaehler ?? false,
          submetering_purpose: z.zweck ?? null,
          notes: z.notiz,
        });
        meterId = erzeugt.id;
        idVon.set(schluessel, erzeugt.id);
        neueZaehler++;
      }
    } else {
      console.log(`${z.nummer.padEnd(16)} ${z.medium.padEnd(13)} ${z.einheit.padEnd(4)} ${ort.padEnd(13)} vorhanden`);
    }
    if (!meterId) continue;

    const { rows: da } = await dbQuery<any>(
      'SELECT read_at::date AS tag FROM meter_readings WHERE meter_id = $1', [meterId]);
    const schonDa = new Set(da.map(d => String(d.tag).slice(0, 10)));
    const offen = z.staende.filter(s => !schonDa.has(s.tag));
    if (offen.length === 0) continue;
    console.log('   ' + offen.map(s => `${s.tag}=${s.wert}`).join('  '));
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}/readings/bulk`, 'POST', {
      readings: offen.map(s => ({
        value: s.wert,
        unit: z.einheit,
        reading_type: s.typ,
        read_at: `${s.tag}T00:00:00Z`,
        source: s.quelle,
        reader_name: s.leser,
        is_estimated: s.geschaetzt ?? false,
        estimate_method: s.methode ?? null,
        estimate_reason: s.geschaetzt
          ? 'Zum Stichtag wurde nicht abgelesen; der Versorger rechnet den Stand hoch.' : null,
        document_path: s.beleg,
        notes: s.notiz ?? '',
      })),
    }, `${z.objekt}-${z.nummer}-${offen.map(s => s.tag).join('-')}`);
    neueStaende += offen.length;
  }

  // ── Plausibilität: Verbrauch 2025 gegen Verbrauch 2024 ───────────────────
  console.log('\nPlausibilität L19, Verbrauch 2025 gegen 2024:');
  for (const z of ZAEHLER.filter(x => x.objekt === 'l19' && x.staende.length === 3)) {
    const [a23, a24, e25] = z.staende.map(s => s.wert);
    const v24 = a24 - a23; const v25 = e25 - a24;
    const ab = v24 > 0 ? ((v25 - v24) / v24) * 100 : 0;
    console.log(`  ${z.nummer}  ${z.einheit.padEnd(4)} 2024 ${v24.toFixed(3).padStart(9)}  `
      + `2025 ${v25.toFixed(3).padStart(9)}  ${ab >= 0 ? '+' : ''}${ab.toFixed(0)} %`
      + (v25 < 0 ? '   NEGATIV — PRÜFEN' : ''));
  }

  console.log(anwenden
    ? `\n${neueZaehler} Zähler und ${neueStaende} Stände angelegt.`
    : '\nProbelauf — nichts geschrieben.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
