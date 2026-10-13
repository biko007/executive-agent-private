/**
 * scripts/restluecken-l19-s28 — die offenen Zählerfragen aus der Inventur schließen.
 *
 * WAS DABEI HERAUSKAM. Die drei Zähler, die in L19 bisher als Liegenschaftszähler
 * geführt wurden, sind NICHT die Zähler, nach denen die Stadtwerke abrechnen:
 *
 *   - Wärmestrom rechnen die Stadtwerke über Zähler 64128135 ab
 *     (Kd 133224-237713, Vertrag 106952 „swtut Strom Wärme Zweitarif").
 *   - Allgemeinstrom über Zähler 64128140
 *     (Kd 133224-237714, Vertrag 106953 „Allgemeiner Tarif Gemeinschaftsanlage ET").
 *   - Wasser und Schmutzwasser über Zähler Z2001676
 *     (Kd 133224-239992, Verträge 108963 und 108964).
 *
 * Die beiden Apator-Zähler im Zählerschrank („Waermepumpe", „Allgemein") und der
 * Molliné-Zähler 40450611 kommen in keiner Versorgerrechnung vor. Sie bleiben
 * erfasst — als Unterzähler des Eigentümers —, aber der Nenner der
 * Verbrauchsverteilung sind die Zähler der Stadtwerke. 40450611 verliert deshalb
 * das Kennzeichen „Hauptzähler": sonst stünden zwei Nenner für dasselbe Medium
 * nebeneinander und die Engine summierte beide.
 *
 * Der Zenner-Zähler aus dem Hausfoto vom 23.12.2025 ist identifiziert: Die
 * Stadtwerke führen ihn als „Z2001676"; auf dem Gerät steht „20-2001676".
 *
 * Aufruf:  bun run scripts/restluecken-l19-s28.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';
const SWT = '/Apps/bikosoc-reports/bikosoc-reports/transfer/SWT-Rechnungen/';
/* Abrechnungszeitraum 16.07.2024–31.07.2025 — liefert die Anfangsstände 2025. */
const R_WAERME_24 = SWT + 'SWT_2025-09-03_Leutenbergstr_19_237713_0001-ARV-2025-16552.pdf';
const R_ALLG_24 = SWT + 'SWT_2025-09-03_Leutenbergstr_19_237714_0001-ARV-2025-16554.pdf';
/* Abrechnungszeitraum 01.08.2025–31.07.2026 — liefert die Endstände 2025, weil die
   Stadtwerke zum Preiswechsel 01.01.2026 einen Stand zum 31.12.2025 ausweisen. */
const R_WAERME_25 = SWT + 'SWT_2026-08-17_Leutenbergstr_19_237713_0001-ARV-2026-13852.pdf';
const R_ALLG_25 = SWT + 'SWT_2026-08-17_Leutenbergstr_19_237714_0001-ARV-2026-13853.pdf';
const R_WASSER_24 = SWT + 'SWT_2025-09-03_Leutenbergstr_19_239992_0001-ARV-2025-16565.pdf';
const R_WASSER_25 = SWT + 'SWT_2026-02-20_Leutenbergstr_19_239992_0001-ARV-2025-40158.pdf';
const R_S28_STROM = SWT + 'SWT_2026-01-08_Sch_nhalde_28_339065_0001-ARV-2025-27911.pdf';
const FOTO_HAUS = '5-L19/Nebenkostenabrechnungen Mieter/2025/Zählerstände_20251223_Haus.pdf';

interface Stand {
  tag: string; wert: number; typ: string; geschaetzt: boolean; methode?: string;
  leser: string; beleg: string; notiz: string;
}
interface NeuerZaehler {
  objekt: string; nummer: string; medium: string; einheit: string;
  hauptzaehler: boolean; notiz: string; staende: Stand[];
}

const HR = 'Hochrechnung der Stadtwerke Tuttlingen';
const HR_GRUND = 'Zum Stichtag wurde nicht abgelesen; die Stadtwerke rechnen den Stand '
  + 'auf den Stichtag hoch und legen ihn ihrer eigenen Abrechnung zugrunde.';

const NEU: NeuerZaehler[] = [
  {
    objekt: 'l19', nummer: '64128135', medium: 'electricity', einheit: 'kWh',
    hauptzaehler: true,
    notiz: 'WÄRMESTROM — Abrechnungszähler der Stadtwerke Tuttlingen für die Wärmepumpe. '
      + 'Kd 133224-237713, Vertrag 106952 „swtut Strom Wärme Zweitarif", Marktlokation '
      + '51422512785, Messlokation DE000642785320001005760019000S005. Zweitarifzähler; '
      + 'die erfassten Stände sind die Summe aus Register 1.8.1 (HT) und 1.8.2 (NT). '
      + 'Über diesen Zähler laufen die Heizkosten. Verbrauch 2025: 12.708 kWh '
      + '(123.227 − 110.519) — die eddi24-Abrechnung 2024 weist als Brennstoffbezug '
      + '12.742 kWh aus, also praktisch dieselbe Größenordnung. '
      + 'Der Apator-Zähler 1APA015114436 im Zählerschrank („Waermepumpe") kommt in keiner '
      + 'Versorgerrechnung vor und ist ein Unterzähler.',
    staende: [
      { tag: '2024-07-15', wert: 104616, typ: 'interim', geschaetzt: false,
        leser: 'Stadtwerke Tuttlingen', beleg: R_WAERME_24,
        notiz: 'HT 74.788 + NT 29.828 kWh. Beginn des Abrechnungszeitraums der Rechnung '
          + '0001-ARV-2025-16552.' },
      { tag: '2024-12-31', wert: 110519, typ: 'annual', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2025-16552', beleg: R_WAERME_24,
        notiz: 'HT 79.131 + NT 31.388 kWh, Ablesekennzeichen „Hochrechnung". '
          + 'Anfangsstand 2025.' },
      { tag: '2025-06-30', wert: 116804, typ: 'interim', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2025-16552', beleg: R_WAERME_24,
        notiz: 'HT 83.755 + NT 33.049 kWh, Ablesekennzeichen „Hochrechnung System".' },
      { tag: '2025-07-31', wert: 117880, typ: 'interim', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2025-16552', beleg: R_WAERME_24,
        notiz: 'HT 84.547 + NT 33.333 kWh. Ende des Abrechnungszeitraums 2024/25 und '
          + 'Beginn des Zeitraums 2025/26 — beide Rechnungen nennen denselben Wert.' },
      { tag: '2025-12-31', wert: 123227, typ: 'annual', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2026-13852', beleg: R_WAERME_25,
        notiz: 'HT 88.481 + NT 34.746 kWh, Ablesekennzeichen „Hochrechnung". ENDSTAND 2025. '
          + 'Die Stadtwerke weisen diesen Stand aus, weil zum 01.01.2026 die Preise '
          + 'wechselten und sie den Abrechnungszeitraum 01.08.2025–31.07.2026 an diesem '
          + 'Tag teilen mussten.' },
    ],
  },
  {
    objekt: 'l19', nummer: '64128140', medium: 'electricity', einheit: 'kWh',
    hauptzaehler: true,
    notiz: 'ALLGEMEINSTROM — Abrechnungszähler der Stadtwerke Tuttlingen. '
      + 'Kd 133224-237714, Vertrag 106953 „Allgemeiner Tarif Gemeinschaftsanlage ET", '
      + 'Marktlokation 51422620702, Messlokation DE000642785320001005760019000S006. '
      + 'Die Vertragsbezeichnung entspricht wörtlich der Position „Allgemeinstrom — '
      + 'Stadtwerke: Gemeinschaftsanlage" der eddi24-Abrechnung 2024 (238,12 €). '
      + 'Verbrauch 2025: 419 kWh (4.131 − 3.712), Vorjahr 437 kWh. '
      + 'Der Apator-Zähler 1APA015114433 im Zählerschrank („Allgemein") kommt in keiner '
      + 'Versorgerrechnung vor und ist ein Unterzähler.',
    staende: [
      { tag: '2024-07-15', wert: 3518, typ: 'interim', geschaetzt: false,
        leser: 'Stadtwerke Tuttlingen', beleg: R_ALLG_24,
        notiz: 'Beginn des Abrechnungszeitraums der Rechnung 0001-ARV-2025-16554.' },
      { tag: '2024-12-31', wert: 3712, typ: 'annual', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2025-16554', beleg: R_ALLG_24,
        notiz: 'Ablesekennzeichen „Hochrechnung". Anfangsstand 2025.' },
      { tag: '2025-06-30', wert: 3926, typ: 'interim', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2025-16554', beleg: R_ALLG_24,
        notiz: 'Ablesekennzeichen „Hochrechnung System".' },
      { tag: '2025-07-31', wert: 3955, typ: 'interim', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2025-16554', beleg: R_ALLG_24,
        notiz: 'Ende des Abrechnungszeitraums 2024/25 und Beginn des Zeitraums 2025/26 — '
          + 'beide Rechnungen nennen denselben Wert.' },
      { tag: '2025-12-31', wert: 4131, typ: 'annual', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2026-13853', beleg: R_ALLG_25,
        notiz: 'Ablesekennzeichen „Hochrechnung". ENDSTAND 2025, ausgewiesen wegen des '
          + 'Preiswechsels zum 01.01.2026.' },
    ],
  },
  {
    objekt: 'l19', nummer: 'Z2001676', medium: 'cold_water', einheit: 'm3',
    hauptzaehler: true,
    notiz: 'HAUPTWASSERZÄHLER — Abrechnungszähler der Stadtwerke Tuttlingen für Wasser und '
      + 'Schmutzwasser. Kd 133224-239992, Verträge 108963 (Wasser) und 108964 '
      + '(Schmutzwasser). Auf dem Gerät steht „20-2001676" (Zenner, Eichung M20); die '
      + 'Stadtwerke führen ihn als „Z2001676". Dies ist der Zähler aus dem Hausfoto vom '
      + '23.12.2025, dessen Funktion in der Inventur offen war. '
      + 'Verbrauch 2025: 476 m³ (2.330 − 1.854); die beiden Vorjahreszeiträume 477 und '
      + '493 m³. '
      + 'BEFUND: Der bisher als Hauptzähler geführte Molliné-Zähler 40450611 zählt im '
      + 'selben Jahr nur 37,865 m³ — ein Zwölftel davon. Der Nenner der Wasserverteilung '
      + 'ist dieser Zähler, nicht 40450611.',
    staende: [
      { tag: '2024-07-15', wert: 1640, typ: 'interim', geschaetzt: false,
        leser: 'Stadtwerke Tuttlingen', beleg: R_WASSER_24,
        notiz: 'Beginn des Abrechnungszeitraums der Rechnung 0001-ARV-2025-16565.' },
      { tag: '2024-12-31', wert: 1854, typ: 'annual', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2025-16565', beleg: R_WASSER_24,
        notiz: 'Ablesekennzeichen „Hochrechnung System". Anfangsstand 2025.' },
      { tag: '2025-07-31', wert: 2133, typ: 'interim', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2025-16565', beleg: R_WASSER_24,
        notiz: 'Ablesekennzeichen „Hochrechnung". Ende des Abrechnungszeitraums 2024/25.' },
      { tag: '2025-12-23', wert: 2243, typ: 'interim', geschaetzt: false,
        leser: 'Owner-Ablesung, Zählerfoto', beleg: FOTO_HAUS,
        notiz: 'Vom Zählerfoto abgelesen. Der Wert liegt zwischen den beiden Hochrechnungen '
          + 'der Stadtwerke (2.133 am 31.07.2025 und 2.330 am 31.12.2025) und bestätigt '
          + 'sie der Größenordnung nach. Die Stadtwerke verteilen ihre Hochrechnung '
          + 'linear über den Abrechnungszeitraum, nicht auf den Fototag; eine exakte '
          + 'Übereinstimmung ist deshalb nicht zu erwarten.' },
      { tag: '2025-12-31', wert: 2330, typ: 'annual', geschaetzt: true, methode: HR,
        leser: 'SWT-Endabrechnung 0001-ARV-2025-40158', beleg: R_WASSER_25,
        notiz: 'Ablesekennzeichen „Hochrechnung". ENDSTAND 2025. Abgerechnete Menge '
          + '01.08.–31.12.2025: 197 m³ (2.133 + 197 = 2.330).' },
    ],
  },
];

/** Stände, die zu einem bereits erfassten Zähler nachzutragen sind. */
const NACHTRAG: { objekt: string; nummer: string; einheit: string; staende: Stand[] }[] = [
  {
    objekt: 's28', nummer: '1ISK0092761948', einheit: 'kWh',
    staende: [
      { tag: '2025-11-30', wert: 0, typ: 'interim', geschaetzt: true, methode: HR,
        leser: 'SWT-Rechnung 0001-ARV-2025-27911', beleg: R_S28_STROM,
        notiz: 'Ablesekennzeichen „Hochrechnung". Vom Einbau am 27.11.2025 bis zum '
          + '30.11.2025 rechnen die Stadtwerke 0 kWh ab; für diese vier Tage stellen sie '
          + 'nur Grundpreise in Rechnung. Der Stand zum 31.12.2025 fehlt weiterhin.' },
    ],
  },
];

/** Notizen, die nach dem Fund zu berichtigen sind. */
interface Korrektur { objekt: string; nummer: string; notiz: string; hauptzaehler?: boolean }

const KORREKTUREN: Korrektur[] = [
  {
    objekt: 'l19', nummer: '40450611', hauptzaehler: false,
    notiz: 'Wasserzähler der Liegenschaft, WDV-Molliné. In der eddi24-Abrechnung 2024 als '
      + '„Gemeindewasserzähler" mit der Funktion „nur informativ" geführt. '
      + 'BERICHTIGT AM 13.10.2026: Der Abrechnungszähler der Stadtwerke ist Z2001676, '
      + 'nicht dieser. 2025 zählt Z2001676 476 m³, dieser Zähler 37,865 m³ — ein '
      + 'Zwölftel. Er erfasst also nur einen Teilstrang des Hauses. Deshalb ist er NICHT '
      + 'mehr als Hauptzähler gekennzeichnet; sonst stünden zwei Nenner für dasselbe '
      + 'Medium nebeneinander und die Verteilung zählte den Nenner doppelt. '
      + 'Was er genau erfasst, ist offen und für die Abrechnung 2025 ohne Bedeutung.',
  },
  {
    objekt: 'l19', nummer: '1APA015114436', hauptzaehler: false,
    notiz: 'Stromzähler im Zählerschrank, beschriftet „Waermepumpe", Apator (Eichung 2023), '
      + 'Zweirichtungszähler. Stand 23.12.2025: Register 1.8.1 = 11.275 kWh, Register '
      + '1.8.2 = 7.327 kWh, Summe 18.602 kWh. '
      + 'BERICHTIGT AM 13.10.2026: Dieser Zähler kommt in KEINER Versorgerrechnung vor. '
      + 'Die Stadtwerke rechnen den Wärmestrom über Zähler 64128135 ab '
      + '(Kd 133224-237713). Dieses Gerät ist ein Unterzähler des Eigentümers; sein '
      + 'Verhältnis zum Abrechnungszähler ist nicht belegt. Für die Verteilung nicht '
      + 'verwenden; das Kennzeichen „Hauptzähler" ist deshalb entfernt.',
  },
  {
    objekt: 'l19', nummer: '1APA015114433', hauptzaehler: false,
    notiz: 'Stromzähler im Zählerschrank, beschriftet „Allgemein", Apator (Eichung 2023). '
      + 'Stand 23.12.2025: Register 1.8.0 = 1.367 kWh, Register 2.8.0 (Einspeisung) = 0. '
      + 'BERICHTIGT AM 13.10.2026: Dieser Zähler kommt in KEINER Versorgerrechnung vor. '
      + 'Die Stadtwerke rechnen den Allgemeinstrom über Zähler 64128140 ab '
      + '(Kd 133224-237714, Vertrag „Allgemeiner Tarif Gemeinschaftsanlage ET"). '
      + 'Dieses Gerät ist ein Unterzähler des Eigentümers. Für die Verteilung nicht '
      + 'verwenden; das Kennzeichen „Hauptzähler" ist deshalb entfernt.',
  },
  {
    objekt: 's28', nummer: '2201028',
    notiz: 'HAUPTWASSERZÄHLER Schönhalde 28, Abrechnungszähler der Stadtwerke Tuttlingen '
      + '(Kd 133224-339065, Verträge 189569 Wasser, 189573 Schmutzwasser). '
      + 'Der Stand 365 m³ zum 31.12.2024 ist eine Hochrechnung der Stadtwerke; sie beruht '
      + 'ausdrücklich auf der echten Ablesung 377 m³ vom 13.02.2025. '
      + 'Der Stand 506 m³ zum 08.11.2025 ist eine Kundenablesung. '
      + 'ABWEICHUNG, geprüft am 13.10.2026: Die Endabrechnung 0001-ARV-2025-37909 rechnet '
      + 'bis 31.12.2025 mit 525 m³ (Hochrechnung: 506 + 19 m³). Erfasst ist dagegen die '
      + 'Ablesung des Owners mit 536 m³. Differenz 11 m³. Für die Abrechnung 2025 gilt der '
      + 'abgelesene Wert; die 11 m³ rechnen die Stadtwerke erst im Folgejahr ab.',
  },
  {
    objekt: 's28', nummer: '1ISK0092761948',
    notiz: 'NACHFOLGER des Hauptstromzählers 1APA0116005300, eingebaut am 27.11.2025, '
      + 'Beginn bei 0 kWh (Vertrag 189545 „Allgemeiner Tarif Eintarif"). '
      + 'FEHLT WEITERHIN: der Stand zum 31.12.2025. Geprüft am 13.10.2026: Die '
      + 'SWT-Endabrechnung 0001-ARV-2025-37909 vom 19.02.2026 rechnet nur Wasser, '
      + 'Schmutz- und Niederschlagswasser ab — keinen Strom. Der Stromvertrag läuft '
      + 'weiter (Abschläge 162,00 € monatlich); die Stromabrechnung endete am 30.11.2025, '
      + 'die nächste beginnt am 01.12.2025 und lag am 13.10.2026 noch nicht vor. '
      + 'Der Stand ist daher nur über eine Ablesung vor Ort oder eine Zwischenabrechnung '
      + 'der Stadtwerke zu bekommen.',
  },
  {
    objekt: 's28', nummer: '1APA0116005300',
    notiz: 'FRÜHERER Hauptstromzähler Schönhalde 28, ausgebaut am 26./27.11.2025. '
      + 'Letzter Stand 13.299 kWh am 26.11.2025 00:00 — Ablesekennzeichen „Ablesung '
      + 'Netzbetreiber", also eine echte Ablesung, keine Hochrechnung. '
      + 'Anfangsstand 2025: 10.654 kWh zum 31.12.2024 (Hochrechnung System). '
      + 'Verbrauch 2025 bis zum Ausbau: 2.645 kWh. Quelle für beide Stände: '
      + 'SWT-Rechnung 0001-ARV-2025-27911 vom 08.01.2026.',
  },
];

/* Die vier Geräte, die eddi24 als Kaltwasserzähler abrechnet. Der Befund ist bei allen
   vier derselbe — nur die Wohnungsbezeichnung wechselt. */
const ULTRAMESS_BEFUND = (bez: string) => `${bez}. WDV-Molliné Ultramess C. In der `
  + 'eddi24-Abrechnung 2024 als Kaltwasserzähler (m³) abgerechnet. '
  + 'BEFUND, geprüft am 13.10.2026 an den Typenschildern auf den Zählerfotos: Das Gerät '
  + 'trägt dieselbe Artikelnummer 1100104803 und dasselbe Typenschild wie die vier '
  + 'Wärmemengenzähler der Liegenschaft, mit den Angaben Θ 0–105 °C und ΔΘ 3–100 K. '
  + 'Diese Temperaturangaben führt nur ein Wärmezähler; ein Trinkwasserzähler hat keine. '
  + 'Es ist also ein WÄRMEZÄHLER, dessen Volumenregister eddi24 als Wasserverbrauch '
  + 'abrechnet. Drei der vier Geräte sitzen auf rot gedämmten Leitungen. '
  + 'GEGENPROBE über die Menge: Die vier Geräte zählen 2025 zusammen 26,345 m³, der '
  + 'Hauptwasserzähler Z2001676 dagegen 476 m³. Das wären 6,6 m³ je Wohnung und Jahr, '
  + 'also etwa 18 Liter am Tag — ein Bruchteil dessen, was ein Haushalt an Trinkwasser '
  + 'braucht. Für einen Heizkreis ist diese Menge dagegen normal. '
  + 'FOLGE: Die Wohnungen in L19 haben keine Trinkwasserzähler. Wasser und Schmutzwasser '
  + '2025 können nicht nach Verbrauch verteilt werden; der Schlüssel muss ein anderer sein '
  + '(Fläche oder Personen). Das Medium dieses Zählers bleibt bis zu dieser Entscheidung '
  + 'unverändert erfasst, damit die bisherige Datenlage nachvollziehbar bleibt.';

const ULTRAMESS: { nummer: string; bez: string }[] = [
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

async function schreibeStaende(
  meterId: number, einheit: string, staende: Stand[], schluessel: string, anwenden: boolean,
): Promise<number> {
  const { rows } = await dbQuery<{ tag: string }>(
    "SELECT to_char(read_at,'YYYY-MM-DD') AS tag FROM meter_readings WHERE meter_id = $1",
    [meterId]);
  const schonDa = new Set(rows.map(r => r.tag));
  const offen = staende.filter(s => !schonDa.has(s.tag));
  if (offen.length === 0) return 0;
  console.log('       ' + offen.map(s => `${s.tag} = ${s.wert}`).join('   '));
  if (!anwenden) return 0;
  await ruf(`/api/assets/meters/${meterId}/readings/bulk`, 'POST', {
    readings: offen.map(s => ({
      value: s.wert, unit: einheit, reading_type: s.typ,
      read_at: `${s.tag}T00:00:00Z`, source: 'manual', reader_name: s.leser,
      is_estimated: s.geschaetzt,
      estimate_method: s.geschaetzt ? (s.methode ?? HR) : null,
      estimate_reason: s.geschaetzt ? HR_GRUND : null,
      document_path: s.beleg, notes: s.notiz,
    })),
  }, `restluecken-${schluessel}-${offen.map(s => s.tag).join('-')}`);
  return offen.length;
}

async function main() {
  const anwenden = process.argv.includes('--apply');

  const { rows: objekte } = await dbQuery<{ id: number; code: string }>(
    "SELECT id, code FROM properties WHERE code IN ('l19','s28')");
  const objektId = new Map(objekte.map(o => [o.code, o.id]));
  for (const code of ['l19', 's28']) {
    if (!objektId.has(code)) throw new Error(`Objekt ${code} fehlt in properties`);
  }

  const { rows: bestand } = await dbQuery<{ id: number; meter_number: string; objekt: string }>(
    `SELECT m.id, m.meter_number, COALESCE(p1.code, p2.code) AS objekt FROM meters m
       LEFT JOIN properties p1 ON m.property_id = p1.id
       LEFT JOIN units u ON m.unit_id = u.id
       LEFT JOIN properties p2 ON u.property_id = p2.id
      WHERE COALESCE(p1.code, p2.code) IN ('l19','s28')`);
  const idVon = new Map(bestand.map(m => [`${m.objekt}/${m.meter_number}`, m.id]));

  let neueZaehler = 0; let neueStaende = 0; let korrigiert = 0;

  console.log('Abrechnungszähler der Versorger:');
  for (const z of NEU) {
    const schluessel = `${z.objekt}/${z.nummer}`;
    let meterId = idVon.get(schluessel);
    if (!meterId) {
      console.log(`  ${z.nummer.padEnd(16)} ${z.medium.padEnd(13)} anlegen`);
      if (anwenden) {
        const erzeugt = await ruf('/api/assets/meters', 'POST', {
          scope_type: 'property', property_id: objektId.get(z.objekt),
          medium: z.medium, meter_number: z.nummer, provider: 'Stadtwerke Tuttlingen GmbH',
          is_main_meter: z.hauptzaehler, notes: z.notiz,
        });
        meterId = erzeugt.id as number;
        idVon.set(schluessel, meterId);
        neueZaehler++;
      }
    } else {
      console.log(`  ${z.nummer.padEnd(16)} vorhanden`);
    }
    if (meterId) {
      neueStaende += await schreibeStaende(
        meterId, z.einheit, z.staende, `${z.objekt}-${z.nummer}`, anwenden);
    }
  }

  console.log('\nNachgetragene Stände:');
  for (const n of NACHTRAG) {
    const meterId = idVon.get(`${n.objekt}/${n.nummer}`);
    if (!meterId) { console.log(`  ${n.nummer} FEHLT in der Datenbank`); continue; }
    console.log(`  ${n.nummer.padEnd(16)} ${n.objekt}`);
    neueStaende += await schreibeStaende(
      meterId, n.einheit, n.staende, `${n.objekt}-${n.nummer}`, anwenden);
  }

  console.log('\nBerichtigte Notizen:');
  const alle: Korrektur[] = [
    ...KORREKTUREN,
    ...ULTRAMESS.map(u => ({ objekt: 'l19', nummer: u.nummer, notiz: ULTRAMESS_BEFUND(u.bez) })),
  ];
  for (const k of alle) {
    const meterId = idVon.get(`${k.objekt}/${k.nummer}`);
    if (!meterId) { console.log(`  ${k.nummer} FEHLT in der Datenbank`); continue; }
    const { rows: vorher } = await dbQuery<{ notes: string | null; is_main_meter: boolean }>(
      'SELECT notes, is_main_meter FROM meters WHERE id = $1', [meterId]);
    const rumpf: Record<string, unknown> = {};
    if (vorher[0]?.notes !== k.notiz) rumpf.notes = k.notiz;
    if (k.hauptzaehler !== undefined && vorher[0]?.is_main_meter !== k.hauptzaehler) {
      rumpf.is_main_meter = k.hauptzaehler;
    }
    if (Object.keys(rumpf).length === 0) {
      console.log(`  ${k.nummer.padEnd(16)} ${k.objekt}  unveraendert`);
      continue;
    }
    console.log(`  ${k.nummer.padEnd(16)} ${k.objekt}  ${Object.keys(rumpf).join(' + ')}`);
    if (!anwenden) continue;
    await ruf(`/api/assets/meters/${meterId}`, 'PATCH', rumpf);
    korrigiert++;
  }

  console.log(anwenden
    ? `\n${neueZaehler} Zähler angelegt, ${neueStaende} Stände erfasst, `
      + `${korrigiert} Notizen berichtigt.`
    : '\nProbelauf — nichts geschrieben. Mit --apply ausführen.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
