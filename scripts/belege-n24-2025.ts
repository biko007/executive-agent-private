/**
 * scripts/belege-n24-2025 — Kostenbuchungen 2025 für N24 aus den gefundenen Belegen.
 *
 * HERKUNFT. Die Rechnungen liegen in SharePoint unter
 * `N24/N24 - Gebäudeakte/8. Rechnungen/` und
 * `N24/N24 - Gebäudeakte/4. Wartung/Rapporte+Protokolle/`. Im Bericht
 * `n24-kosten-umlage-2025` stand, es gebe dort keine Belege für 2025 — das war
 * falsch: Die damalige Suche lieferte mehr Treffer, als die Ausgabe anzeigte,
 * und der Ordner stand jenseits des Abschnitts.
 *
 * ZUORDNUNG ÜBER DEN LEISTUNGSZEITRAUM, nicht über den Zahltag. Zwei Belege
 * zeigen, warum das nötig ist: Die Störungsrechnung von Schmitt + Sohn vom
 * 04.03.2025 betrifft einen Einsatz am 17.11.2024, und die Wartungsrechnung
 * der Fa. Maurer über 1.786,49 € vom Februar 2025 ist die Wartung 2024. Beide
 * sind deshalb NICHT für 2025 gebucht.
 *
 * UMLAGEFÄHIGKEIT. Wiederkehrende Wartung und gesetzlich vorgeschriebene
 * Prüfungen sind Betriebskosten. Einmalige Herstellung, Nachrüstung und
 * Reparatur sind es nicht (§ 1 Abs. 2 Nr. 2 BetrKV: Instandhaltung und
 * Instandsetzung gehören nicht zu den Betriebskosten). Sie werden trotzdem
 * gebucht — mit `umlagefaehig = false`, damit die Kosten des Objekts
 * vollständig sind und die Abrechnung sie nicht verteilt.
 *
 * Geschrieben wird über `POST /api/assets/properties/n24/expense-bookings`
 * mit Audit und Belegpfad. Mehrfacher Aufruf ist unschädlich.
 *
 * Aufruf:  bun run scripts/belege-n24-2025.ts [--apply]
 */
import { readFileSync } from 'node:fs';
import { query as dbQuery } from '../src/shared/db/index.js';

const BASIS = 'http://127.0.0.1:18789';
const OBJEKT = 'n24';

/** Wurzel der Gebäudeakte in SharePoint. */
const G = 'N24/N24 - Gebäudeakte';

interface Buchung {
  source_key: string;
  kostenart: string;
  betrag: number;
  umlagefaehig: boolean;
  von: string;
  bis: string;
  lieferant: string;
  rechnungsnummer: string;
  rechnungsdatum: string;
  beleg: string;
  notiz: string;
}

const BUCHUNGEN: Buchung[] = [
  // ── Aufzug (BetrKV § 2 Nr. 7) ────────────────────────────────────────────
  {
    source_key: 'n24-2025-sus-wartung-notruf', kostenart: 'aufzug', betrag: 1974.60,
    umlagefaehig: true, von: '2025-01-01', bis: '2025-12-31',
    lieferant: 'Schmitt + Sohn Aufzüge GmbH', rechnungsnummer: 'SVIN2734991',
    rechnungsdatum: '2025-01-02',
    beleg: `${G}/8. Rechnungen/Schmitt+Sohn/2025-01-08_N24_Schmitt+Sohn_RE SVIN2734991.PDF`,
    notiz: 'Aufzug 390635, Kd VB-10-01/543141. Drei Zeilen, alle für den Zeitraum '
      + '01.01.2025 bis 31.12.2025: Systemwartung 1.121,22, Fernnotrufsystem 388,11, '
      + 'Miete SIM-Karte mit Flatrate 150,00; netto 1.659,33 plus 19 % USt 315,27. '
      + 'Umlagefähig nach BetrKV § 2 Nr. 7 (Beaufsichtigung, Pflege, regelmäßige '
      + 'Prüfung der Betriebsbereitschaft und Betriebssicherheit des Aufzugs).',
  },
  {
    source_key: 'n24-2025-sus-hauptpruefung', kostenart: 'aufzug', betrag: 342.13,
    umlagefaehig: true, von: '2025-07-08', bis: '2025-07-08',
    lieferant: 'Schmitt + Sohn Aufzüge GmbH', rechnungsnummer: 'SVIN2963004',
    rechnungsdatum: '2025-08-04',
    beleg: `${G}/4. Wartung/Rapporte+Protokolle/Schmitt+Sohn/2025-08-11_N24_S+S_RE SVIN2963004_Hauptprüfung.pdf`,
    notiz: 'Begleitung der Hauptprüfung am 08.07.2025: Servicetechniker 1,25 Std, '
      + 'Fahrzeit 0,75 Std, 45 km; netto 287,50 plus 19 % USt. Umlagefähig nach '
      + 'BetrKV § 2 Nr. 7 (regelmäßige Prüfung der Betriebssicherheit).',
  },
  {
    source_key: 'n24-2025-dekra-hauptpruefung', kostenart: 'aufzug', betrag: 561.68,
    umlagefaehig: true, von: '2025-07-08', bis: '2025-07-08',
    lieferant: 'DEKRA Automobil GmbH', rechnungsnummer: '6204817798',
    rechnungsdatum: '2025-07-18',
    beleg: `${G}/8. Rechnungen/DEKRA/2025-08-11_N24_Dekra_RE 6204817798_Hauptprüfung.pdf`,
    notiz: 'Hauptprüfung an Personen- und Lastenaufzügen nach RL 2014/33/EU, '
      + 'Leistungsdatum 08.07.2025, Anlage 390635, 5 Haltestellen; netto 472,00 plus '
      + '19 % USt. Gesetzlich vorgeschriebene wiederkehrende Prüfung, umlagefähig nach '
      + 'BetrKV § 2 Nr. 7.',
  },

  // ── Sonstige Betriebskosten (BetrKV § 2 Nr. 17) ──────────────────────────
  {
    source_key: 'n24-2025-eckermann-tueren', kostenart: 'sonstige_betrkv', betrag: 618.80,
    umlagefaehig: true, von: '2025-01-01', bis: '2025-12-31',
    lieferant: 'Eckermann', rechnungsnummer: '213500', rechnungsdatum: '2025-07-29',
    beleg: `${G}/8. Rechnungen/Eckermann/2025-07-29_N24_Fa. Eckermann_RE 213500_Wartung 2025.pdf`,
    notiz: 'Wartung der automatischen Türanlagen (dormakaba), auf der Rechnung '
      + 'ausdrücklich "Abrechnungszeitraum von 01.01.2025 bis 31.12.2025"; netto 520,00 '
      + 'plus 19 % USt. Entspricht der Position "Sonstige Kosten 2" der eddi24-'
      + 'Abrechnung 2024 (dort 618,80 €, derselbe Betrag).',
  },
  {
    source_key: 'n24-2025-haller-dachwartung', kostenart: 'sonstige_betrkv', betrag: 1210.78,
    umlagefaehig: true, von: '2025-12-03', bis: '2025-12-03',
    lieferant: 'Haller & Gabele', rechnungsnummer: '2025213', rechnungsdatum: '2025-12-09',
    beleg: `${G}/8. Rechnungen/Haller+Gabele/2025-12-09_N24_Haller+Gabele_RE 2025213_Projekt 25124_Dachwartung 2025.pdf`,
    notiz: 'Ausführungszeitraum 03.12.2025. Zwei Positionen, beide jährlich wiederkehrend: '
      + 'Wartungsvertrag Flachdach 701,83 und jährliche Prüfung der Absturzsicherung nach '
      + 'DGUV 286,00 zuzüglich 29,63 Preisanpassung 2025; netto 1.017,46 plus 19 % USt. '
      + 'Entspricht "Sonstige Kosten 3" der eddi24-Abrechnung 2024 (dort 1.175,52 €).',
  },
  {
    source_key: 'n24-2025-bauer-toranlage', kostenart: 'sonstige_betrkv', betrag: 114.24,
    umlagefaehig: true, von: '2025-05-05', bis: '2025-05-11',
    lieferant: 'bauer gmbh Tore + Türen', rechnungsnummer: '251646', rechnungsdatum: '2025-05-09',
    beleg: `${G}/4. Wartung/Rapporte+Protokolle/Bauer/2025-05-20_N24_Bauer_Wartung_Tiefgaragentor_Wartung v. 08.05.25.pdf`,
    notiz: 'Wartungs- und Prüfungsarbeiten am Sektionaltor der Tiefgarage nach ASR 1.7 '
      + 'mit Abnahme, Leistung in KW 19/2025; netto 96,00 plus 19 % USt. Entspricht '
      + '"Sonstige Kosten" (Torwartung) der eddi24-Abrechnung 2024 — identischer Betrag.',
  },
  {
    source_key: 'n24-2025-geiger-t30', kostenart: 'sonstige_betrkv', betrag: 371.28,
    umlagefaehig: true, von: '2025-07-01', bis: '2025-07-31',
    lieferant: 'Türenstudio Geiger GmbH & Co KG', rechnungsnummer: '2406130',
    rechnungsdatum: '2025-07-29',
    beleg: `${G}/8. Rechnungen/Geiger/2024-08-11_N24_Geiger_RE 2406130_Wartung 2025.pdf`,
    notiz: 'Wartung von 6 T30-Brandschutztüren mit Obertürschließer, Prüfmittel und '
      + 'Siegel; auf der Rechnung: "Die Leistung wurde im Juli 2025 erbracht". Netto '
      + '312,00 plus 19 % USt. HINWEIS: Die Rechnung ist an die Bikolino GmbH adressiert, '
      + 'das Objekt ist mit "La Perla Möhringen" bezeichnet. Dateiname und Rechnungsnummer '
      + 'tragen 2024, weil es eine aktualisierte Fassung eines Dokuments vom 21.06.2024 ist.',
  },
  {
    source_key: 'n24-2025-fp-blitzschutz', kostenart: 'sonstige_betrkv', betrag: 559.30,
    umlagefaehig: true, von: '2025-03-18', bis: '2025-03-18',
    lieferant: 'F&P Blitzschutz GmbH & Co. KG', rechnungsnummer: '2251343',
    rechnungsdatum: '2025-03-24',
    beleg: `${G}/8. Rechnungen/F&P Blitzschutz/2025-03-25_N24_F+P_RE Nr. 2251343.pdf`,
    notiz: 'Überprüfung der Blitzschutzanlage nach Wartungsvereinbarung vom 20.12.2013, '
      + 'Leistungsdatum 18.03.2025: Grundgebühr Wartung 250,00 plus 22 Messstellen zu '
      + '10,00; netto 470,00 plus 19 % USt. Wiederkehrende Prüfung, kein Materialanteil. '
      + 'In der eddi24-Abrechnung 2024 kommt diese Position nicht vor.',
  },
  {
    source_key: 'n24-2025-maurer-wartung-heizung', kostenart: 'sonstige_betrkv', betrag: 1190.00,
    umlagefaehig: true, von: '2025-11-20', bis: '2025-11-20',
    lieferant: 'H. Maurer GmbH & Co. KG', rechnungsnummer: '25116549',
    rechnungsdatum: '2025-12-09',
    beleg: `${G}/8. Rechnungen/Maurer/2025-12-09_N24_RE25116549_Maurer_Wartung_Heizung.pdf`,
    notiz: 'Jahreswartung der Heizungsanlage, Leistungsdatum 20.11.2025 (Auftrag '
      + 'SE25115707), netto 1.000,00 plus 19 % USt. Entspricht "Sonstige Kosten 5" der '
      + 'eddi24-Abrechnung 2024 (dort 1.786,49 € für die Wartung 2024). '
      + 'OFFENER PUNKT: Die Wartung der Heizungsanlage gehört nach § 7 Abs. 2 '
      + 'HeizkostenV zu den KOSTEN DES BETRIEBS der zentralen Heizungsanlage und wäre '
      + 'dann mit den übrigen Heizkosten nach Verbrauch zu verteilen, nicht nach Fläche. '
      + 'Gebucht ist sie hier wie bei eddi24 2024 unter den sonstigen Betriebskosten.',
  },
  {
    source_key: 'n24-2025-maurer-wartung-sanitaer', kostenart: 'sonstige_betrkv', betrag: 297.50,
    umlagefaehig: true, von: '2025-11-20', bis: '2025-11-20',
    lieferant: 'H. Maurer GmbH & Co. KG', rechnungsnummer: '25116550',
    rechnungsdatum: '2025-12-09',
    beleg: `${G}/8. Rechnungen/Maurer/2025-12-09_N24_RE25116550__Maurer_Wartung_Sanitär.pdf`,
    notiz: 'Jahreswartung der Sanitäranlage, Leistungsdatum 20.11.2025 (Auftrag '
      + 'SE25115704), netto 250,00 plus 19 % USt.',
  },
  {
    source_key: 'n24-2025-maurer-wartung-rlt', kostenart: 'sonstige_betrkv', betrag: 952.00,
    umlagefaehig: true, von: '2025-11-20', bis: '2025-11-20',
    lieferant: 'H. Maurer GmbH & Co. KG', rechnungsnummer: '25116551',
    rechnungsdatum: '2025-12-09',
    beleg: `${G}/8. Rechnungen/Maurer/2025-12-09_N24_RE25116551_Maurer_Wartung_RLT.pdf`,
    notiz: 'Jahreswartung der raumlufttechnischen Anlage, Leistungsdatum 20.11.2025 '
      + '(Auftrag SE25115709), netto 800,00 plus 19 % USt. Umlagefähig nach BetrKV '
      + '§ 2 Nr. 17 (Betrieb einer Lüftungsanlage).',
  },

  // ── Nicht umlagefähig: Herstellung, Nachrüstung, Reparatur ───────────────
  {
    source_key: 'n24-2025-maurer-fernueberwachung', kostenart: 'instandhaltung', betrag: 1970.03,
    umlagefaehig: false, von: '2025-01-10', bis: '2025-01-10',
    lieferant: 'H. Maurer GmbH & Co. KG', rechnungsnummer: '25112308',
    rechnungsdatum: '2025-04-07',
    beleg: `${G}/8. Rechnungen/Maurer/2025-04-12_N24_Maurer_25112308_Fernzugriff WP.pdf`,
    notiz: 'Fernüberwachung installiert, WebLog und Wärmepumpe angeschlossen; '
      + 'Leistungsdatum 10.01.2025. Enthält Material: M2M-Router 766,00, Netzteil 99,40, '
      + 'Patchkabel 207,09, Leitung und Kleinmaterial, dazu 6 Std Servicemonteur und '
      + '1 Std Softwareprogrammierer. NICHT UMLAGEFÄHIG: einmalige Nachrüstung einer '
      + 'Einrichtung, keine laufenden Betriebskosten (§ 1 Abs. 2 Nr. 2 BetrKV).',
  },
  {
    source_key: 'n24-2025-maurer-weblog-konfiguration', kostenart: 'instandhaltung', betrag: 910.35,
    umlagefaehig: false, von: '2025-07-09', bis: '2025-07-25',
    lieferant: 'H. Maurer GmbH & Co. KG', rechnungsnummer: '25114986',
    rechnungsdatum: '2025-09-24',
    beleg: `${G}/8. Rechnungen/Maurer/2025-09-24_N24_RE25114986_Erweiterte_Konfiguration_für_Export_Relay_Weblog_Energiezähler.pdf`,
    notiz: 'Erweiterte Konfiguration des Relay-WebLog für den Export der Energiezähler, '
      + '8,5 Stunden Softwareprogrammierer an vier Tagen im Juli 2025; netto 765,00 plus '
      + '19 % USt. NICHT UMLAGEFÄHIG: einmalige Einrichtung. Dieselbe Einrichtung liefert '
      + 'allerdings die Ablesewerte, mit denen diese Abrechnung rechnet — ob ein Teil als '
      + 'Kosten der Verbrauchserfassung nach § 7 Abs. 2 HeizkostenV umlagefähig wäre, ist '
      + 'eine Owner-Entscheidung.',
  },
  {
    source_key: 'n24-2025-reizner-dali', kostenart: 'instandhaltung', betrag: 174.87,
    umlagefaehig: false, von: '2025-11-14', bis: '2025-11-14',
    lieferant: 'Elektro Reizner', rechnungsnummer: '223-2025', rechnungsdatum: '2025-12-20',
    beleg: `${G}/8. Rechnungen/Reizner/2025-12-21_N24_Reizner_RE223-2025_Tausch DALI-Einsatz_Schlafz_WHG6.pdf`,
    notiz: 'Tausch eines DALI-Einsatzes im Schlafzimmer der Wohnung 6 am 14.11.2025; '
      + 'netto 146,95. NICHT UMLAGEFÄHIG: Reparatur in einer Wohnung.',
  },
  {
    source_key: 'n24-2025-steidle-balkontuer', kostenart: 'instandhaltung', betrag: 174.69,
    umlagefaehig: false, von: '2025-11-19', bis: '2025-11-19',
    lieferant: 'Steidle', rechnungsnummer: '25370', rechnungsdatum: '2025-12-06',
    beleg: `${G}/8. Rechnungen/Steidle/2025-12-06_N24_Steidle_Rechnung_25370.pdf`,
    notiz: 'Eckband an der Balkontüre Wohn-Esszimmer durch ein neues ersetzt, '
      + 'Leistung am 19.11.2025; netto 146,80. NICHT UMLAGEFÄHIG: Reparatur.',
  },
  {
    source_key: 'n24-2025-adrex-pv-wartung', kostenart: 'sonstige_betrkv', betrag: 643.89,
    umlagefaehig: false, von: '2025-11-10', bis: '2025-11-10',
    lieferant: 'ADREX / ENPLA', rechnungsnummer: 'RES25157', rechnungsdatum: '2025-12-17',
    beleg: `${G}/8. Rechnungen/Adrex/2025-12-17_N24_Adrex_RES25157_Wartung 2025.pdf`,
    notiz: 'Inspektion, Wartung (E-CHECK PV) und Monitoring der Photovoltaikanlage '
      + '28,35 kWp, Jahresgebühr 396,90 plus Anfahrt 144,18; netto 541,08 plus 19 % USt. '
      + 'Leistungsdatum 10.11.2025. NICHT UMLAGEFÄHIG angesetzt: Die Photovoltaikanlage '
      + 'ist eine Erzeugungsanlage des Eigentümers; die BetrKV führt ihre Wartung nicht '
      + 'auf, und die eddi24-Abrechnung 2024 enthält keine solche Position. Ob ein Teil '
      + 'über § 2 Nr. 17 umlagefähig wäre, bräuchte eine Vereinbarung im Mietvertrag.',
  },
  {
    source_key: 'n24-2025-energiekonzept-messstellenbetrieb', kostenart: 'sonstige_betrkv',
    betrag: 2143.31, umlagefaehig: false, von: '2025-01-01', bis: '2025-12-31',
    lieferant: 'energiekonzept ortenau GmbH', rechnungsnummer: 'ER04915',
    rechnungsdatum: '2025-01-10',
    beleg: `${G}/8. Rechnungen/Energiekonzept/2025-01-15_N24_ER04915_Energiekonzept.pdf`,
    notiz: 'Jahresabrechnung für den Zeitraum 01.01.2025 bis 31.12.2025, Kd 11042, '
      + 'Vertrag 341-A01-001: Abrechnung Stromzähler 360,00, Zusatzleistung 250,00, '
      + 'SEPA-Bearbeitungsentgelt 12,00, Messstellenbetrieb Strom 218,40, Strom Erzeugung '
      + '132,60, Miete Wandlersätze 83,20, GSM-Gebühr Gateway 58,50, 8 Submeter 395,20, '
      + 'Miete 8 SLP-Stromzähler 291,20; netto 1.801,10 plus 19 % USt. '
      + 'NICHT UMLAGEFÄHIG angesetzt: Messstellenbetrieb und Abrechnung der '
      + 'Wohnungsstromzähler trägt im Regelfall der jeweilige Stromkunde über seinen '
      + 'Liefervertrag; die Position "Strom Erzeugung" betrifft die PV-Anlage des '
      + 'Eigentümers. Die eddi24-Abrechnung 2024 enthält diese Kosten nicht. '
      + 'Bei einem Mieterstrommodell wäre die Einordnung anders — das ist zu entscheiden.',
  },
];

function env(schluessel: string): string {
  const inhalt = readFileSync(`${process.env.HOME}/.config/openclaw/env`, 'utf-8');
  const treffer = inhalt.match(new RegExp(`^${schluessel}=(.+)$`, 'm'));
  if (!treffer) throw new Error(`${schluessel} fehlt`);
  return treffer[1].trim();
}

async function ruf(pfad: string, methode = 'GET', rumpf?: unknown) {
  const res = await fetch(`${BASIS}${pfad}`, {
    method: methode,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env('CORE_SERVICE_TOKEN')}`,
      'X-Actor': 'owner',
    },
    ...(rumpf ? { body: JSON.stringify(rumpf) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${methode} ${pfad} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const anwenden = process.argv.includes('--apply');
  const { rows: arten } = await dbQuery<any>('SELECT id, code FROM cost_categories');
  const artId = new Map<string, number>(arten.map(a => [a.code, a.id]));

  const vorhanden: any[] = await ruf(`/api/assets/properties/${OBJEKT}/expense-bookings`);
  const da = new Set(vorhanden.map(b => b.source_key));

  let neu = 0;
  console.log(`${'Betrag'.padStart(10)}  ${'Kostenart'.padEnd(20)} ${'Zeitraum'.padEnd(23)} `
    + `${'uml.'.padEnd(5)} Lieferant`);
  for (const b of BUCHUNGEN) {
    const cid = artId.get(b.kostenart);
    if (!cid) throw new Error(`Kostenart ${b.kostenart} unbekannt`);
    const status = da.has(b.source_key) ? 'besteht' : 'anlegen';
    console.log(`${b.betrag.toFixed(2).padStart(10)}  ${b.kostenart.padEnd(20)} `
      + `${(b.von + '..' + b.bis).padEnd(23)} ${(b.umlagefaehig ? 'ja' : 'NEIN').padEnd(5)} `
      + `${b.lieferant.slice(0, 30).padEnd(32)} ${status}`);
    if (da.has(b.source_key) || !anwenden) continue;
    await ruf(`/api/assets/properties/${OBJEKT}/expense-bookings`, 'POST', {
      source_key: b.source_key,
      cost_category_id: cid,
      vendor_name: b.lieferant,
      invoice_number: b.rechnungsnummer,
      invoice_date: b.rechnungsdatum,
      service_period_start: b.von,
      service_period_end: b.bis,
      amount_gross: b.betrag,
      umlagefaehig: b.umlagefaehig,
      document_path: b.beleg,
      notes: b.notiz,
    });
    neu++;
  }

  const umlage = BUCHUNGEN.filter(b => b.umlagefaehig).reduce((s, b) => s + b.betrag, 0);
  const rest = BUCHUNGEN.filter(b => !b.umlagefaehig).reduce((s, b) => s + b.betrag, 0);
  console.log(`\n  umlagefähig      ${umlage.toFixed(2).padStart(10)} EUR (${BUCHUNGEN.filter(b => b.umlagefaehig).length} Buchungen)`);
  console.log(`  nicht umlagefähig ${rest.toFixed(2).padStart(9)} EUR (${BUCHUNGEN.filter(b => !b.umlagefaehig).length} Buchungen)`);
  console.log(`  zusammen          ${(umlage + rest).toFixed(2).padStart(9)} EUR`);
  console.log(anwenden ? `\n${neu} Buchungen angelegt.` : '\nProbelauf — nichts geschrieben.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
