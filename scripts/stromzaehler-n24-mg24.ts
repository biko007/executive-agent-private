/**
 * scripts/stromzaehler-n24-mg24 — die Stromzähler der beiden Kundenanlagen anlegen.
 *
 * Bis jetzt war in bikosoc kein einziger Stromzähler der beiden Mieterstromanlagen
 * erfasst. Dieses Skript legt die Stammdaten an und trägt die Stände ein, die in
 * den Abrechnungen belegt sind. KOSTEN WERDEN NICHT GEBUCHT.
 *
 * Zwei Dinge, die beim Lesen der Zahlen wichtig sind:
 *
 * 1. WANDLERFAKTOR. Die Übergabe- und Vorgängerzähler messen über Wandler mit
 *    Faktor 50. Die Rechnungen nennen den Registerstand, der Verbrauch ist das
 *    Fünfzigfache. Erfasst wird hier der BEREITS MULTIPLIZIERTE Wert in kWh,
 *    damit die Verbrauchsrechnung unmittelbar stimmt; der Registerstand steht
 *    jeweils in der Notiz der Ablesung.
 *
 * 2. ZWEI RICHTUNGEN AN EINEM ZÄHLER. Der MG24-Übergabezähler misst Bezug und
 *    Einspeisung getrennt (Register 1.8.0 und 2.8.0). Ein Zählerdatensatz trägt
 *    nur eine Reihe; erfasst ist der BEZUG, weil nur er in die Nebenkosten
 *    führt. Die Einspeisewerte stehen in der Zählernotiz.
 *
 * Nicht erfasst werden die Monatswerte der N24-RLM-Messung: Sie beginnen jeden
 * Monat wieder bei null und sind damit keine fortlaufenden Zählerstände.
 *
 * Aufruf:  bun run scripts/stromzaehler-n24-mg24.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';

const Q_JA2024 = 'Mailanhang 2025-09-18_TEST-JA2024_Tuttlingen-Möhringen.pdf '
  + '(energiekonzept, Testabrechnung 2024)';
const Q_JA2023 = 'Mailanhang 2025-09-18_TEST-JA2023_Tuttlingen-Möhringen.pdf '
  + '(energiekonzept, Testabrechnung 2023)';
const Q_KA2025 = '6-Marktgasse 24/Gebäudeakte/MG24/Energiekonzept/'
  + '2026-04-22_MG24_Energiekonzept_AbrechnungKundenanlage_2025.pdf';
const Q_SWT8728 = '/Apps/bikosoc-reports/bikosoc-reports/transfer/SWT-Rechnungen/'
  + 'SWT_2026-06-10_Marktgasse_24_348661_0001-ARV-2026-8728.pdf';
const Q_SWT16680 = '/Apps/bikosoc-reports/bikosoc-reports/transfer/SWT-Rechnungen/'
  + 'SWT_2026-10-01_Nonnenburgstr_24_318635_0001-ARV-2026-16680.pdf';
const Q_MESSKONZEPT = 'Mailanhang 2023-07-06_Messkonzept_Tuttlingen-Möhringen_Vers2.pdf '
  + '(energiekonzept, M. Huber)';

/** Kennzeichnung, die der Auftrag für die Wohnungszähler verlangt. */
const MIETERSTROM = 'MIETERSTROM – NICHT NK-RELEVANT. ';
const NK_RELEVANT = 'NK-RELEVANT. ';

interface Stand {
  tag: string; wert: number; typ: 'annual' | 'interim'; quelle: string; notiz: string;
}
interface Zaehler {
  objekt: 'n24' | 'mg24';
  nummer: string;
  einheit?: string;            // Wohnungscode, sonst Liegenschaftszähler
  hauptzaehler?: boolean;
  notiz: string;
  staende: Stand[];
}

const ZAEHLER: Zaehler[] = [
  // ───────────────────────── N24 ─────────────────────────
  {
    objekt: 'n24', nummer: '1MCS0010125165', hauptzaehler: true,
    notiz: NK_RELEVANT + 'ÜBERGABEMESSUNG (Z1) — Netzbezug der Kundenanlage aus dem Netz '
      + 'der allgemeinen Versorgung. Registrierende Leistungsmessung (RLM Lastgang HT/NT '
      + 'und Leistung). Stadtwerke Tuttlingen Kd 527415-318635, Vertrag 239575 '
      + '„SV Jahresleistung", Marktlokation 51422774963, Messlokation '
      + 'DE000642785320008406076024000S002. Messstellenbetreiber: wattline GmbH. '
      + 'Der Vertrag endet automatisch zum 31.12.2026. '
      + 'KEINE STÄNDE ERFASST: Die Stadtwerke rechnen monatlich ab und setzen den Zähler '
      + 'zum Monatsersten auf 0,000 zurück. Die Monatswerte sind daher keine '
      + 'fortlaufenden Zählerstände und würden die Verbrauchsrechnung verfälschen. '
      + 'Belegt ist: April 2026 = 1.046,843 kWh HT, Leistungsspitze 16,5 kW; von den '
      + 'Stadtwerken hochgerechneter Jahresverbrauch 12.736 kWh. '
      + 'Erste vorliegende Rechnung betrifft 04/2026 — für 2025 liegt für diesen '
      + 'Zählpunkt keine Abrechnung vor.',
    staende: [],
  },
  {
    objekt: 'n24', nummer: 'OHNE-NR-N24-Z2-SUMME',
    notiz: 'PLATZHALTER, Zählernummer unbekannt. SUMMENMESSUNG (Z2) laut Messkonzept vom '
      + '06.07.2023 — Wandlerzähler hinter der Übergabemessung. Die Nummer steht in '
      + 'keinem vorliegenden Dokument. Sie ist über die Messstellenliste von '
      + 'energiekonzept ortenau zu beschaffen (Projekt 34101).',
    staende: [],
  },
  {
    objekt: 'n24', nummer: 'OHNE-NR-N24-PV-ERZEUGUNG',
    notiz: 'PLATZHALTER, Zählernummer unbekannt. ERZEUGUNGSMESSUNG der PV-Anlage '
      + '(28,35 kWp) laut Messkonzept vom 06.07.2023, mit Batteriespeicher '
      + '(Sungrow, Marktstammdaten-Registrierung SEE953527857278). Die Nummer steht in '
      + 'keinem vorliegenden Dokument. '
      + 'Einspeisevergütung läuft über Stadtwerke Tuttlingen Kd 580080, Vertrag 348474 '
      + '(52,00 EUR monatlicher Abschlag an den Eigentümer).',
    staende: [],
  },
  {
    objekt: 'n24', nummer: '1LGZ0064308209',
    notiz: NK_RELEVANT + 'ALLGEMEINSTROM der Liegenschaft. Submeter der Kundenanlage, '
      + 'energiekonzept-Vertrag 341-V007, abgerechnet auf Kundennummer 341-002 '
      + '(La Perla GmbH selbst). Verbrauch 2024: 4.438,1 kWh; 19.10.–31.12.2023: '
      + '1.506,4 kWh. Mieterstromtarif 2023 und 2024 unverändert 31,54 ct/kWh zuzüglich '
      + '96,445 EUR Grundpreis im Jahr. '
      + 'FEHLT: der Stand zum 31.12.2025 — für 2025 liegt keine Jahresabrechnung der '
      + 'Kundenanlage vor.',
    staende: [
      { tag: '2023-10-19', wert: 0, typ: 'interim', quelle: Q_JA2023,
        notiz: 'Beginn der Messung. Die Zähler der Kundenanlage wurden am 19.10.2023 in '
          + 'Betrieb genommen; alle starten bei 0,0 kWh.' },
      { tag: '2023-12-31', wert: 1506.4, typ: 'annual', quelle: Q_JA2023,
        notiz: 'Verbrauch 19.10.–31.12.2023: 1.506,4 kWh.' },
      { tag: '2024-12-31', wert: 5944.5, typ: 'annual', quelle: Q_JA2024,
        notiz: 'Verbrauch 2024: 4.438,1 kWh (5.944,5 − 1.506,4).' },
    ],
  },
  {
    objekt: 'n24', nummer: '1LGZ0064308208',
    notiz: NK_RELEVANT + 'WÄRMEPUMPE UND HEIZUNG. Submeter der Kundenanlage, '
      + 'energiekonzept-Vertrag 341-V008, abgerechnet auf Kundennummer 341-002 '
      + '(La Perla GmbH selbst). Dies ist der Zähler, über den die Heizkosten des Hauses '
      + 'laufen; das Messkonzept vom 06.07.2023 führt ihn als „Wärmepumpe + Heizung". '
      + 'Verbrauch 2024: 13.961,7 kWh; 19.10.–31.12.2023: 3.234,1 kWh. '
      + 'Mieterstromtarif 2023 und 2024 unverändert 31,54 ct/kWh zuzüglich 96,445 EUR '
      + 'Grundpreis im Jahr; daraus 2024 rechnerisch 4.403,52 EUR netto. '
      + 'FEHLT: der Stand zum 31.12.2025 — für 2025 liegt keine Jahresabrechnung der '
      + 'Kundenanlage vor. Damit ist der Heizstromverbrauch 2025 nicht belegt.',
    staende: [
      { tag: '2023-10-19', wert: 0, typ: 'interim', quelle: Q_JA2023,
        notiz: 'Beginn der Messung am 19.10.2023.' },
      { tag: '2023-12-31', wert: 3234.1, typ: 'annual', quelle: Q_JA2023,
        notiz: 'Verbrauch 19.10.–31.12.2023: 3.234,1 kWh.' },
      { tag: '2024-12-31', wert: 17195.8, typ: 'annual', quelle: Q_JA2024,
        notiz: 'Verbrauch 2024: 13.961,7 kWh (17.195,8 − 3.234,1).' },
    ],
  },
  {
    objekt: 'n24', nummer: '1LGZ0064308154', einheit: 'W1',
    notiz: MIETERSTROM + 'Wohnungszähler Whg. 1, energiekonzept-Vertrag 341-V009, '
      + 'Kundennummer 341-003. Der Verbrauch wird dem Mieter unmittelbar in Rechnung '
      + 'gestellt und gehört nicht in die Nebenkostenabrechnung.',
    staende: [
      { tag: '2024-04-26', wert: 227.0, typ: 'interim', quelle: Q_JA2024,
        notiz: 'Beginn der Belieferung dieser Wohnung.' },
      { tag: '2024-12-31', wert: 1257.1, typ: 'annual', quelle: Q_JA2024,
        notiz: 'Verbrauch 26.04.–31.12.2024: 1.030,1 kWh.' },
    ],
  },
  {
    objekt: 'n24', nummer: '1LGZ0064308153', einheit: 'W2',
    notiz: MIETERSTROM + 'Wohnungszähler Whg. 2, energiekonzept-Vertrag 341-V010, '
      + 'Kundennummer 341-004.',
    staende: [
      { tag: '2024-03-25', wert: 183.0, typ: 'interim', quelle: Q_JA2024,
        notiz: 'Beginn der Belieferung dieser Wohnung.' },
      { tag: '2024-12-31', wert: 2071.0, typ: 'annual', quelle: Q_JA2024,
        notiz: 'Verbrauch 25.03.–31.12.2024: 1.888,0 kWh.' },
    ],
  },
  {
    objekt: 'n24', nummer: '1LGZ0064308152', einheit: 'W3',
    notiz: MIETERSTROM + 'Wohnungszähler Whg. 3, energiekonzept-Vertrag 341-V002, '
      + 'Kundennummer 341-002 (La Perla GmbH — die Wohnung war in beiden Jahren nicht '
      + 'an Dritte vermietet).',
    staende: [
      { tag: '2023-10-19', wert: 0, typ: 'interim', quelle: Q_JA2023,
        notiz: 'Beginn der Messung am 19.10.2023.' },
      { tag: '2023-12-31', wert: 128.7, typ: 'annual', quelle: Q_JA2023,
        notiz: 'Verbrauch 19.10.–31.12.2023: 128,7 kWh.' },
      { tag: '2024-12-31', wert: 2079.3, typ: 'annual', quelle: Q_JA2024,
        notiz: 'Verbrauch 2024: 1.950,6 kWh.' },
    ],
  },
  {
    objekt: 'n24', nummer: '1LGZ0064308151', einheit: 'W4',
    notiz: MIETERSTROM + 'Wohnungszähler Whg. 4, energiekonzept-Vertrag 341-V003, '
      + 'Kundennummer 341-002 (La Perla GmbH).',
    staende: [
      { tag: '2023-10-19', wert: 0, typ: 'interim', quelle: Q_JA2023,
        notiz: 'Beginn der Messung am 19.10.2023.' },
      { tag: '2023-12-31', wert: 91.1, typ: 'annual', quelle: Q_JA2023,
        notiz: 'Verbrauch 19.10.–31.12.2023: 91,1 kWh.' },
      { tag: '2024-12-31', wert: 687.4, typ: 'annual', quelle: Q_JA2024,
        notiz: 'Verbrauch 2024: 596,3 kWh.' },
    ],
  },
  {
    objekt: 'n24', nummer: 'OHNE-NR-N24-WHG5', einheit: 'W5',
    notiz: MIETERSTROM + 'PLATZHALTER, Zählernummer unbekannt. Wohnungszähler Whg. 5. '
      + 'Das Messkonzept vom 06.07.2023 sieht acht Submeter vor (Allgemein, Whg. 1–6, '
      + 'Wärmepumpe); sieben davon sind durch Nummer belegt, dieser nicht: In den '
      + 'Testabrechnungen 2023 und 2024 kommt Whg. 5 nicht vor. Aus der Korrespondenz '
      + 'zum Stromkonto vom 25.02.2025 geht hervor, dass Whg. 5 von den Eheleuten Bickel '
      + 'bewohnt wird und dafür ein SEPA-Mandat vorlag.',
    staende: [],
  },
  {
    objekt: 'n24', nummer: '1LGZ0064308210', einheit: 'W6',
    notiz: MIETERSTROM + 'Wohnungszähler Whg. 6, energiekonzept-Vertrag 341-V011, '
      + 'Kundennummer 341-005.',
    staende: [
      { tag: '2024-04-26', wert: 193.0, typ: 'interim', quelle: Q_JA2024,
        notiz: 'Beginn der Belieferung dieser Wohnung.' },
      { tag: '2024-12-31', wert: 1908.4, typ: 'annual', quelle: Q_JA2024,
        notiz: 'Verbrauch 26.04.–31.12.2024: 1.715,4 kWh.' },
    ],
  },

  // ───────────────────────── MG24 ─────────────────────────
  {
    objekt: 'mg24', nummer: '1LGZ0071678615', hauptzaehler: true,
    notiz: NK_RELEVANT + 'ÜBERGABEMESSUNG der Kundenanlage — Bezug aus dem Netz und '
      + 'Einspeisung ins Netz. Wandlerfaktor 50. '
      + 'ERFASST IST DER BEZUG (Register 1.8.0), weil nur er in die Nebenkosten führt; '
      + 'die Stände sind bereits mit 50 multipliziert. '
      + 'EINSPEISUNG (Register 2.8.0) im selben Zeitraum: Registerstand 0 am 23.06.2025 '
      + 'auf 102,004 am 31.12.2025, mal 50 = 5.100,2 kWh ins Netz. '
      + 'Derselbe Zähler wurde vorher von den Stadtwerken unter Kd 133224-348661 '
      + 'abgerechnet (Register 1-65:1.8.0 „Stand tariflos"): 17.06.2025 = 0,000, '
      + '01.07.2025 = 18,746, 01.08.2025 = 135,635, 21.08.2025 = 243,993 — mal 50 sind '
      + 'das 12.200 kWh für 17.06. bis 20.08.2025. '
      + 'WIDERSPRUCH, ungeklärt: energiekonzept weist für 23.06.–31.12.2025 nur 3.346 kWh '
      + 'Bezug aus, die Stadtwerke für die darin liegenden zwei Monate bereits 12.200 kWh. '
      + 'Die beiden Abrechnungen lesen verschiedene Register; welcher Wert den Netzbezug '
      + 'der Kundenanlage abbildet, ist aus den Unterlagen nicht zu entscheiden.',
    staende: [
      { tag: '2025-06-23', wert: 0, typ: 'interim', quelle: Q_KA2025,
        notiz: 'Registerstand 1.8.0 = 0, Beginn der Abrechnung der Kundenanlage.' },
      { tag: '2025-12-31', wert: 3346.3, typ: 'annual', quelle: Q_KA2025,
        notiz: 'Registerstand 1.8.0 = 66,926 mal Wandlerfaktor 50 = 3.346,3 kWh. '
          + 'Abrechnungsrelevante Reststrommenge 2025 laut energiekonzept: 3.346 kWh.' },
    ],
  },
  {
    objekt: 'mg24', nummer: '1EMH0012291975',
    notiz: NK_RELEVANT + 'VORGÄNGER der Übergabemessung — der Zählpunkt, über den MG24 vor '
      + 'dem Start der Kundenanlage mit Strom versorgt wurde. Stadtwerke Tuttlingen '
      + 'Kd 133224-348661, Vertrag 198440 „Allgemeiner Tarif Eintarif iM", Marktlokation '
      + '51422782924, Messstellenbetreiber metiundo GmbH. Wandlerfaktor 50; die erfassten '
      + 'Stände sind bereits multipliziert. '
      + 'DAMIT IST DIE LÜCKE 01.01.–23.06.2025 GESCHLOSSEN: Verbrauch 01.01.–16.06.2025 '
      + '900,0 kWh (Registerstände 15,0 auf 33,0). Die Kosten dieses Abschnitts weist die '
      + 'Endabrechnung 0001-ARV-2026-8728 getrennt aus: 378,22 EUR netto, '
      + '450,08 EUR brutto. Gebucht ist davon nichts.',
    staende: [
      { tag: '2024-11-15', wert: 495.0, typ: 'interim', quelle: Q_SWT8728,
        notiz: 'Registerstand 9,9 mal 50. Beginn des Abrechnungszeitraums der '
          + 'Endabrechnung.' },
      { tag: '2024-12-31', wert: 750.0, typ: 'annual', quelle: Q_SWT8728,
        notiz: 'Registerstand 15,0 mal 50, Ablesekennzeichen „Hochrechnung". '
          + 'Anfangsstand 2025.' },
      { tag: '2025-06-16', wert: 1650.0, typ: 'interim', quelle: Q_SWT8728,
        notiz: 'Registerstand 33,0 mal 50, Ablesekennzeichen „Ablesung MSB". '
          + 'Letzter Stand dieses Zählpunkts; ab 17.06.2025 übernimmt 1LGZ0071678615.' },
    ],
  },
  {
    objekt: 'mg24', nummer: '1LGZ0075676542',
    notiz: 'ERZEUGUNGSMESSUNG PV, erstes Gerät. Am 11.09.2025 gegen 1LGZ0075675536 '
      + 'getauscht. Erzeugung 16.06.–11.09.2025: 4.161 kWh. '
      + 'Nicht NK-relevant: Die Erzeugung selbst ist keine Nebenkostenposition; sie '
      + 'bestimmt nur den PV-Anteil der Kundenanlage (2025: 51,06 %).',
    staende: [
      { tag: '2025-06-16', wert: 0, typ: 'interim', quelle: Q_KA2025,
        notiz: 'Beginn der Erzeugungsmessung.' },
      { tag: '2025-09-11', wert: 4161, typ: 'interim', quelle: Q_KA2025,
        notiz: 'Endstand bei Ausbau des Geräts.' },
    ],
  },
  {
    objekt: 'mg24', nummer: '1LGZ0075675536',
    notiz: 'ERZEUGUNGSMESSUNG PV, Nachfolger von 1LGZ0075676542, eingebaut am 11.09.2025 '
      + 'mit Stand 0. Erzeugung 11.09.–31.12.2025: 4.430,98 kWh. '
      + 'Gesamterzeugung 2025 über beide Geräte: 8.591,98 kWh. '
      + 'Ein Zählerfoto liegt in SharePoint unter '
      + '„2026-03-23_MG24_Metiundo Zähler_1LGZ0075675536.jpg".',
    staende: [
      { tag: '2025-09-11', wert: 0, typ: 'interim', quelle: Q_KA2025,
        notiz: 'Einbau, Beginn bei 0.' },
      { tag: '2025-12-31', wert: 4430.98, typ: 'annual', quelle: Q_KA2025,
        notiz: 'Erzeugung 11.09.–31.12.2025: 4.430,98 kWh.' },
    ],
  },
  {
    objekt: 'mg24', nummer: '1LGZ0075661371',
    notiz: NK_RELEVANT + 'ALLGEMEINSTROM der Liegenschaft. Submeter der Kundenanlage, '
      + 'energiekonzept-Vertrag 390-V001; Lieferant ist Jürgen Bickel persönlich, Kunde '
      + 'ebenfalls — eine Selbstbelieferung mit förmlicher Lieferbestätigung. '
      + 'Verbrauch 24.06.–31.12.2025: 954 kWh. '
      + 'Preis: Die Lieferbestätigung vom 17.02.2026 nennt 38,00 ct/kWh und 95,00 EUR '
      + 'Grundpreis im Jahr ausdrücklich für den NÄCHSTEN Abrechnungszeitraum, also ab '
      + '2026. Der für 2025 geltende Preis steht in keinem vorliegenden Dokument; '
      + 'deshalb ist keine Kostenbuchung angelegt.',
    staende: [
      { tag: '2025-06-24', wert: 26, typ: 'interim', quelle: Q_KA2025,
        notiz: 'Anfangsstand laut Abrechnung der Kundenanlage. Die Lieferbestätigung '
          + 'nennt als Anfangsstand 22,6 kWh zu einem anderen Stichtag.' },
      { tag: '2025-12-31', wert: 979, typ: 'annual', quelle: Q_KA2025,
        notiz: 'Verbrauch 24.06.–31.12.2025: 954 kWh.' },
    ],
  },
  {
    objekt: 'mg24', nummer: '1LGZ0075661373', einheit: 'W1',
    notiz: MIETERSTROM + 'Wohnungszähler Wohnung 1 laut Abrechnung der Kundenanlage 2025. '
      + 'Verbrauch 16.06.–31.12.2025: 1.582 kWh.',
    staende: [
      { tag: '2025-06-16', wert: 0, typ: 'interim', quelle: Q_KA2025,
        notiz: 'Beginn der Belieferung.' },
      { tag: '2025-12-31', wert: 1582, typ: 'annual', quelle: Q_KA2025,
        notiz: 'Verbrauch 16.06.–31.12.2025: 1.582 kWh.' },
    ],
  },
  {
    objekt: 'mg24', nummer: '1LGZ0078617709', einheit: 'W2',
    notiz: MIETERSTROM + 'Wohnungszähler Wohnung 2 laut Abrechnung der Kundenanlage 2025. '
      + 'Verbrauch 24.06.–31.12.2025: 639 kWh.',
    staende: [
      { tag: '2025-06-24', wert: 28, typ: 'interim', quelle: Q_KA2025,
        notiz: 'Anfangsstand laut Abrechnung der Kundenanlage.' },
      { tag: '2025-12-31', wert: 667, typ: 'annual', quelle: Q_KA2025,
        notiz: 'Verbrauch 24.06.–31.12.2025: 639 kWh.' },
    ],
  },
  {
    objekt: 'mg24', nummer: '1LGZ0075661426', einheit: 'W3',
    notiz: MIETERSTROM + 'Wohnungszähler Wohnung 3 laut Abrechnung der Kundenanlage 2025. '
      + 'Verbrauch 24.06.–31.12.2025: 3.548 kWh.',
    staende: [
      { tag: '2025-06-24', wert: 10, typ: 'interim', quelle: Q_KA2025,
        notiz: 'Anfangsstand laut Abrechnung der Kundenanlage.' },
      { tag: '2025-12-31', wert: 3558, typ: 'annual', quelle: Q_KA2025,
        notiz: 'Verbrauch 24.06.–31.12.2025: 3.548 kWh.' },
    ],
  },
];

/* Die vier L19-Geräte, die eddi24 als Kaltwasserzähler abrechnet. Geändert wird nur
   die Notiz — das Medium bleibt, weil der Beleg zwar die Bauart klärt, nicht aber,
   welches Volumen das Register zählt. Siehe Report. */
const L19_NOTIZ = (bez: string, nr: string) => `${bez}. WDV-Molliné Ultramess C, `
  + 'SensoStar 2U, Art. 1100104803. In der eddi24-Abrechnung 2024 als „KWZ" geführt und '
  + 'als Schlüssel VKW (Verbrauch Kaltwasser) für die Wasserkosten verwendet. '
  + 'BAUART GEKLÄRT AM 13.10.2026: Das Gerät ist ein WÄRMEZÄHLER. Beleg: Das Zählerfoto '
  + `vom 23.12.2025 zeigt für ${nr} dasselbe Typenschild wie für den Wärmemengenzähler `
  + '53650511 derselben Liegenschaft — gleiche Artikelnummer 1100104803, gleiche Bauform '
  + 'Ultramess C / SensoStar 2U, mit den Angaben Θ 0–105 °C und ΔΘ 3–100 K; auf dem Foto '
  + 'von 53650734 steht zusätzlich der Aufdruck „Heat Meter". Ein Trinkwasserzähler führt '
  + 'keine Temperaturangaben. Ein Wärmezähler besitzt ein Energieregister (kWh/MWh) UND '
  + 'ein Volumenregister (m³); die hier erfassten m³-Werte sind das Volumenregister. '
  + 'Die Einheit allein unterscheidet also nicht zwischen Trink- und Heizwasser. '
  + 'NICHT GEKLÄRT: welches Volumen das Register zählt — Warmwasserzapfung oder '
  + 'Heizkreis. Deshalb ist das Medium dieses Zählers unverändert gelassen; eine '
  + 'Umtypisierung ohne Beleg würde die Abrechnung verfälschen. '
  + 'MENGENVERGLEICH 2024: die vier Geräte zusammen 29,116 m³, der Molliné-Zähler '
  + '40450611 („Gemeindewasserzähler", bei eddi24 „nur informativ") 43,169 m³, der '
  + 'Abrechnungszähler der Stadtwerke Z2001676 dagegen 477 m³. eddi24 verteilt die '
  + 'gesamten Wasserkosten von 1.298,58 EUR allein im Verhältnis der vier Geräte '
  + '(44,6002 EUR je m³) — der Hauptzähler geht in die Verteilung nicht ein.';

const L19_GERAETE: { nummer: string; bez: string }[] = [
  { nummer: '53650437', bez: 'Wohnung W1, Erdgeschoss' },
  { nummer: '53650518', bez: 'Wohnung W2, 1. Obergeschoss' },
  { nummer: '53650734', bez: 'Wohnung W3, 2. Obergeschoss links' },
  { nummer: '53650737', bez: 'Wohnung W4, 2. Obergeschoss rechts' },
];

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt in ~/.config/openclaw/env`);
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

  const { rows: objekte } = await dbQuery<{ id: number; code: string }>(
    "SELECT id, code FROM properties WHERE code IN ('n24','mg24','l19')");
  const objektId = new Map(objekte.map(o => [o.code, o.id]));

  const { rows: einheiten } = await dbQuery<{ id: number; code: string; objekt: string }>(
    `SELECT u.id, u.code, p.code AS objekt FROM units u JOIN properties p ON u.property_id = p.id
      WHERE p.code IN ('n24','mg24')`);
  const einheitId = new Map(einheiten.map(u => [`${u.objekt}/${u.code}`, u.id]));

  const { rows: bestand } = await dbQuery<{ id: number; meter_number: string; objekt: string }>(
    `SELECT m.id, m.meter_number, COALESCE(p1.code, p2.code) AS objekt FROM meters m
       LEFT JOIN properties p1 ON m.property_id = p1.id
       LEFT JOIN units u ON m.unit_id = u.id
       LEFT JOIN properties p2 ON u.property_id = p2.id
      WHERE COALESCE(p1.code, p2.code) IN ('n24','mg24','l19')`);
  const idVon = new Map(bestand.map(m => [`${m.objekt}/${m.meter_number}`, m.id]));

  let neueZaehler = 0; let neueStaende = 0; let notizen = 0;

  console.log('Stromzähler der Kundenanlagen:');
  for (const z of ZAEHLER) {
    const schluessel = `${z.objekt}/${z.nummer}`;
    let meterId = idVon.get(schluessel);
    if (!meterId) {
      const einheitSchluessel = z.einheit ? `${z.objekt}/${z.einheit}` : null;
      if (einheitSchluessel && !einheitId.has(einheitSchluessel)) {
        throw new Error(`Einheit ${einheitSchluessel} fehlt`);
      }
      console.log(`  ${z.objekt.padEnd(5)} ${z.nummer.padEnd(26)} `
        + `${(z.einheit ?? 'Liegenschaft').padEnd(12)} anlegen`);
      if (anwenden) {
        const erzeugt = await ruf('/api/assets/meters', 'POST', {
          scope_type: z.einheit ? 'unit' : 'property',
          property_id: z.einheit ? null : objektId.get(z.objekt),
          unit_id: z.einheit ? einheitId.get(einheitSchluessel!) : null,
          medium: 'electricity', meter_number: z.nummer,
          is_main_meter: z.hauptzaehler ?? false, notes: z.notiz,
        });
        meterId = erzeugt.id as number;
        idVon.set(schluessel, meterId);
        neueZaehler++;
      }
    } else {
      console.log(`  ${z.objekt.padEnd(5)} ${z.nummer.padEnd(26)} vorhanden`);
    }
    if (!meterId || z.staende.length === 0) continue;

    const { rows } = await dbQuery<{ tag: string }>(
      "SELECT to_char(read_at,'YYYY-MM-DD') AS tag FROM meter_readings WHERE meter_id = $1",
      [meterId]);
    const schonDa = new Set(rows.map(r => r.tag));
    const offen = z.staende.filter(s => !schonDa.has(s.tag));
    if (offen.length === 0) continue;
    console.log('        ' + offen.map(s => `${s.tag} = ${s.wert}`).join('   '));
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}/readings/bulk`, 'POST', {
      readings: offen.map(s => ({
        value: s.wert, unit: 'kWh', reading_type: s.typ,
        read_at: `${s.tag}T00:00:00Z`, source: 'manual', reader_name: 'energiekonzept/SWT',
        is_estimated: false, document_path: s.quelle, notes: s.notiz,
      })),
    }, `strom-${z.objekt}-${z.nummer}-${offen.map(s => s.tag).join('-')}`);
    neueStaende += offen.length;
  }

  console.log('\nL19 Ultramess — Bauart in der Notiz festgehalten (Medium unverändert):');
  for (const g of L19_GERAETE) {
    const meterId = idVon.get(`l19/${g.nummer}`);
    if (!meterId) { console.log(`  ${g.nummer} FEHLT in der Datenbank`); continue; }
    const neu = L19_NOTIZ(g.bez, g.nummer);
    const { rows: vorher } = await dbQuery<{ notes: string | null }>(
      'SELECT notes FROM meters WHERE id = $1', [meterId]);
    if (vorher[0]?.notes === neu) { console.log(`  ${g.nummer} unveraendert`); continue; }
    console.log(`  ${g.nummer} Notiz`);
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}`, 'PATCH', { notes: neu });
    notizen++;
  }

  console.log(anwenden
    ? `\n${neueZaehler} Zähler angelegt, ${neueStaende} Stände erfasst, `
      + `${notizen} Notizen berichtigt.`
    : '\nProbelauf — nichts geschrieben. Mit --apply ausführen.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
