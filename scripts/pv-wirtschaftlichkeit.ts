/**
 * scripts/pv-wirtschaftlichkeit — Deckungsbeitrag der PV-Anlagen N24 und MG24.
 *
 * NUR RECHNEN. Kein Datenbankzugriff, keine Buchung. Das Skript macht die
 * Arithmetik des Reports nachvollziehbar und wiederholbar.
 *
 * Gerechnet wird aus Sicht des Eigentümers als JAHRESSALDO:
 *
 *     Saldo = Erlöse − Kosten
 *
 * Darin steckt auch der Strom, den der Eigentümer für sich selbst bezieht
 * (Wärmepumpe, Allgemeinstrom, eigene Wohnungen). Das ist Absicht: Nur wenn in
 * jedem Szenario dieselben Posten stecken, sind die Szenarien vergleichbar. Der
 * Saldo ist deshalb negativ — er ist kein Gewinn, sondern der Nettoaufwand der
 * Stromversorgung des Hauses. Was zählt, ist der UNTERSCHIED zwischen den
 * Szenarien.
 *
 * Aufruf:  bun run scripts/pv-wirtschaftlichkeit.ts
 */

interface Objekt {
  name: string;
  kwp: number;
  /** PV-Erzeugung kWh/Jahr. Für N24 nicht gemessen — Annahme, siehe Report. */
  erzeugung: number;
  /** Verbrauch der Mieter, die Dritte sind (nicht der Eigentümer). */
  verbrauchDritte: number;
  /** Anzahl Lieferverträge mit Dritten (für den Grundpreis). */
  vertraegeDritte: number;
  /** Eigenverbrauch des Eigentümers: Wärmepumpe, Allgemeinstrom, eigene Wohnungen. */
  verbrauchOwner: number;
  /** davon Wärmepumpe — in Szenario D der Kern des Eigenverbrauchs. */
  verbrauchWaermepumpe: number;
  /** Gemessener Netzbezug der Kundenanlage. */
  netzbezug: number;
  preisMieterstrom: number;      // EUR/kWh netto
  grundpreisMieterstrom: number; // EUR/Jahr netto je Vertrag
  preisReststrom: number;        // EUR/kWh netto
  grundpreisReststrom: number;   // EUR/Jahr netto, inkl. Leistungspreis
  eegTeil: number;               // EUR/kWh, gemischter Satz nach Leistungsstaffel
  eegVoll: number;               // EUR/kWh
  /** energiekonzept, laufend — nur der Abrechnungsanteil (entfällt in B). */
  ekAbrechnung: number;
  /** energiekonzept, laufend — Messstellenbetrieb (bleibt in B). */
  ekMessstellenbetrieb: number;
  /** Messstellenbetrieb der Erzeugungs- und Summenzähler — bleibt auch bei Volleinspeisung. */
  msbErzeugung: number;
  pvWartung: number;
}

/* Gemischter EEG-Satz nach Leistungsstaffel: die ersten 10 kWp zum höheren Satz,
   der Rest zum niedrigeren. */
function eegMisch(kwp: number, bis10: number, ueber10: number): number {
  return (Math.min(kwp, 10) * bis10 + Math.max(kwp - 10, 0) * ueber10) / kwp;
}

const N24: Objekt = {
  name: 'N24',
  kwp: 28.35,
  erzeugung: 28350,            // ANNAHME 1.000 kWh/kWp — nicht gemessen
  verbrauchDritte: 6469.5,     // Whg 1, 2, 6 auf zwölf Monate hochgerechnet
  vertraegeDritte: 3,
  verbrauchOwner: 20946.7,     // WP 13.961,7 + Allgemein 4.438,1 + Whg3 1.950,6 + Whg4 596,3
  verbrauchWaermepumpe: 13961.7,
  netzbezug: 12345,            // 13.731 kWh / 406 Tage * 365
  preisMieterstrom: 0.3154,
  grundpreisMieterstrom: 96.445,
  preisReststrom: 0.29256,     // SWT RLM 04/2026, variable Bestandteile netto
  grundpreisReststrom: 337.76, // Leistungspreis 20,47 EUR/kW * 16,5 kW
  eegTeil: eegMisch(28.35, 0.0820, 0.0710),
  eegVoll: eegMisch(28.35, 0.1300, 0.1090),
  ekAbrechnung: 622.00,        // Basispaket 360 + Zusatzleistung 250 + SEPA 12
  ekMessstellenbetrieb: 1179.10, // 218,40 + 132,60 + 83,20 + 58,50 + 395,20 + 291,20
  msbErzeugung: 132.60,        // MSB Strom Erz
  pvWartung: 643.89,
};

const MG24: Objekt = {
  name: 'MG24',
  kwp: 25.73,
  erzeugung: 25730,            // ANNAHME 1.000 kWh/kWp — gemessen nur ein Teiljahr
  verbrauchDritte: 10903,      // Whg 1 (199 T) 2.902 + Whg 2 (191 T) 1.221 + Whg 3 (191 T) 6.780
  vertraegeDritte: 3,
  verbrauchOwner: 1823,        // Allgemeinstrom 954 kWh aus 191 Tagen hochgerechnet
  verbrauchWaermepumpe: 0,     // Heizung ist Pellets
  netzbezug: 6361,             // 3.346 kWh aus 192 Tagen auf 365 hochgerechnet
  preisMieterstrom: 0.3800,
  grundpreisMieterstrom: 95.00,
  preisReststrom: 0.3184,
  grundpreisReststrom: 156.02,
  eegTeil: eegMisch(25.73, 0.0803, 0.0695),
  eegVoll: eegMisch(25.73, 0.1273, 0.1068),
  ekAbrechnung: 760.00,        // Basispaket 400 + Kontoführung 4*25 + Zusatzleistung 250
  ekMessstellenbetrieb: 187.45, // 87,39 + 41,60 + 4 * 29,90 (laufend, ohne Bereitstellung)
  msbErzeugung: 41.60,
  pvWartung: 0,                // kein eigener Wartungsvertrag belegt
};

interface Ergebnis { name: string; erloese: number; kosten: number; saldo: number; hinweis: string }

function verbrauchGesamt(o: Objekt) { return o.verbrauchDritte + o.verbrauchOwner; }
/** PV-Strom, der im Haus bleibt. Aus Messung: Verbrauch minus Netzbezug. */
function pvEigenverbrauch(o: Objekt) { return verbrauchGesamt(o) - o.netzbezug; }
function einspeisung(o: Objekt) { return Math.max(o.erzeugung - pvEigenverbrauch(o), 0); }

function szenarioA(o: Objekt): Ergebnis {
  const erloese = o.verbrauchDritte * o.preisMieterstrom
    + o.vertraegeDritte * o.grundpreisMieterstrom
    + einspeisung(o) * o.eegTeil;
  const kosten = o.netzbezug * o.preisReststrom + o.grundpreisReststrom
    + o.ekAbrechnung + o.ekMessstellenbetrieb + o.pvWartung;
  return { name: 'A Status quo (Mieterstrom mit energiekonzept)', erloese, kosten,
    saldo: erloese - kosten, hinweis: 'Ist-Zustand' };
}

function szenarioB(o: Objekt): Ergebnis {
  const a = szenarioA(o);
  return { name: 'B Mieterstrom, Abrechnung selbst', erloese: a.erloese,
    kosten: a.kosten - o.ekAbrechnung, saldo: a.erloese - (a.kosten - o.ekAbrechnung),
    hinweis: 'Abrechnungsanteil entfällt, Messstellenbetrieb bleibt' };
}

function szenarioC(o: Objekt): Ergebnis {
  /* Volleinspeisung: Die gesamte Erzeugung geht ins Netz. Der Eigentümer kauft
     seinen eigenen Strom beim Versorger, die Mieter werden Direktkunden. Die
     Abrechnungsdienstleistung entfällt vollständig, der Messstellenbetrieb der
     Erzeugungsmessung bleibt. */
  const erloese = o.erzeugung * o.eegVoll;
  const kosten = o.verbrauchOwner * o.preisReststrom + o.grundpreisReststrom
    + o.msbErzeugung + o.pvWartung;
  return { name: 'C Volleinspeisung', erloese, kosten, saldo: erloese - kosten,
    hinweis: 'Mieter werden Direktkunden' };
}

/** Nulllinie: keine PV, keine Kundenanlage. Die Mieter sind Direktkunden beim
 *  Versorger, der Eigentümer kauft nur seinen eigenen Strom. Diese Zeile
 *  beantwortet die eigentliche Frage — alles darüber ist der Wert der Anlage. */
function szenarioNull(o: Objekt): Ergebnis {
  const kosten = o.verbrauchOwner * o.preisReststrom + o.grundpreisReststrom;
  return { name: '0 Nulllinie: keine PV, keine Kundenanlage', erloese: 0, kosten,
    saldo: -kosten, hinweis: 'Vergleichsmaßstab' };
}

function szenarioD(o: Objekt, deckungsgrad = DECKUNGSGRAD): Ergebnis {
  /* PV nur für den Eigenverbrauch des Vermieters. Mieter werden Direktkunden.
     ENTSCHEIDENDE ANNAHME: Wie viel des eigenen Bedarfs die Anlage zeitlich
     wirklich deckt. Perfekte Deckung gibt es nicht — eine Wärmepumpe läuft im
     Winter, die Anlage liefert im Sommer, und der Speicher überbrückt Stunden,
     nicht Monate. Gerechnet wird mit einem Deckungsgrad; er ist der wichtigste
     Hebel des Szenarios und unten mit einer Spanne hinterlegt. */
  const eigen = Math.min(o.erzeugung, o.verbrauchOwner * deckungsgrad);
  const ueberschuss = o.erzeugung - eigen;
  const erloese = ueberschuss * o.eegTeil;
  const kosten = (o.verbrauchOwner - eigen) * o.preisReststrom + o.grundpreisReststrom
    + o.msbErzeugung + o.pvWartung;
  return { name: 'D PV nur für Eigenverbrauch des Vermieters', erloese, kosten,
    saldo: erloese - kosten,
    hinweis: `Deckungsgrad ${Math.round(deckungsgrad * 100)} %: ${Math.round(eigen)} kWh `
      + `selbst genutzt, ${Math.round(ueberschuss)} kWh eingespeist` };
}

function szenarioE(o: Objekt, pvPreis: number): Ergebnis {
  /* Gemeinschaftliche Gebäudeversorgung nach § 42b EnWG: Der Eigentümer liefert
     nur den PV-Strom nach einem Schlüssel; den Reststrom kauft jeder Mieter
     selbst. Damit entfällt die Vollversorgerpflicht und der Reststromeinkauf für
     die Mieter. Der Preis für den PV-Strom ist frei vereinbar — hier als
     Annahme. */
  const pvAnMieter = pvEigenverbrauch(o) * (o.verbrauchDritte / verbrauchGesamt(o));
  const pvAnOwner = pvEigenverbrauch(o) - pvAnMieter;
  const erloese = pvAnMieter * pvPreis + einspeisung(o) * o.eegTeil;
  const kosten = (o.verbrauchOwner - pvAnOwner) * o.preisReststrom + o.grundpreisReststrom
    + o.ekMessstellenbetrieb + o.pvWartung;
  return { name: 'E Gemeinschaftliche Gebäudeversorgung § 42b EnWG', erloese, kosten,
    saldo: erloese - kosten,
    hinweis: `${Math.round(pvAnMieter)} kWh PV an Mieter zu ${(pvPreis * 100).toFixed(1)} ct` };
}

/** Anteil des eigenen Bedarfs, den PV und Speicher zeitlich wirklich decken.
 *  Annahme, siehe Report; die Spanne 40-60 % steht in der Ausgabe. */
const DECKUNGSGRAD = 0.50;

function eur(n: number) { return n.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

function tabelle(o: Objekt, pvPreisE: number) {
  console.log(`\n═══════════ ${o.name} — ${o.kwp} kWp ═══════════`);
  console.log(`  Erzeugung (Annahme)          ${eur(o.erzeugung).padStart(8)} kWh`);
  console.log(`  Verbrauch Dritte             ${eur(o.verbrauchDritte).padStart(8)} kWh`);
  console.log(`  Verbrauch Eigentümer         ${eur(o.verbrauchOwner).padStart(8)} kWh`);
  console.log(`  Netzbezug (gemessen)         ${eur(o.netzbezug).padStart(8)} kWh`);
  console.log(`  PV-Eigenverbrauch (abgel.)   ${eur(pvEigenverbrauch(o)).padStart(8)} kWh`);
  console.log(`  Einspeisung (abgeleitet)     ${eur(einspeisung(o)).padStart(8)} kWh`);
  console.log(`  EEG-Satz Teileinspeisung     ${(o.eegTeil * 100).toFixed(3).padStart(8)} ct/kWh`);
  console.log(`  EEG-Satz Volleinspeisung     ${(o.eegVoll * 100).toFixed(3).padStart(8)} ct/kWh`);
  console.log('');
  const alle = [szenarioNull(o), szenarioA(o), szenarioB(o), szenarioC(o), szenarioD(o),
    szenarioE(o, pvPreisE)];
  const basis = alle[1].saldo;
  console.log('  Szenario                                           Erlöse    Kosten     Saldo   ggü. A');
  for (const e of alle) {
    console.log(`  ${e.name.padEnd(48).slice(0, 48)} ${eur(e.erloese).padStart(8)} `
      + `${eur(e.kosten).padStart(9)} ${eur(e.saldo).padStart(9)} `
      + `${(e.saldo - basis >= 0 ? '+' : '') + eur(e.saldo - basis)}`.padStart(9));
  }
  for (const e of alle) console.log(`     ${e.name.slice(0, 2)}: ${e.hinweis}`);
  console.log(`\n  Wert der Anlage heute (A minus Nulllinie): `
    + `${eur(szenarioA(o).saldo - szenarioNull(o).saldo)} EUR/Jahr`);
  console.log('  Szenario D nach Deckungsgrad:');
  for (const dg of [0.40, 0.50, 0.60]) {
    console.log(`    ${Math.round(dg * 100)} %: ${eur(szenarioD(o, dg).saldo).padStart(7)} EUR`);
  }
}

function sensitivitaet(o: Objekt) {
  console.log(`\n  Sensitivität ${o.name} (Saldo in EUR/Jahr)`);
  console.log('  Preisänderung        A       B       C       D');
  for (const [bez, fR, fM] of [
    ['Reststrom  −20 %', 0.8, 1.0], ['Reststrom  +20 %', 1.2, 1.0],
    ['Mieterstrom −20 %', 1.0, 0.8], ['Mieterstrom +20 %', 1.0, 1.2],
  ] as [string, number, number][]) {
    const v: Objekt = { ...o,
      preisReststrom: o.preisReststrom * fR,
      preisMieterstrom: o.preisMieterstrom * fM };
    console.log(`  ${bez.padEnd(18)} ${eur(szenarioA(v).saldo).padStart(7)} `
      + `${eur(szenarioB(v).saldo).padStart(7)} ${eur(szenarioC(v).saldo).padStart(7)} `
      + `${eur(szenarioD(v).saldo).padStart(7)}`);
  }
}

for (const [o, pvPreis] of [[N24, 0.25], [MG24, 0.25]] as [Objekt, number][]) {
  tabelle(o, pvPreis);
  sensitivitaet(o);
}

/* Gegenprobe N24: Welche Einspeisemenge erklärt die tatsächlich erhaltenen
   EEG-Zahlungen? */
const eegIst2025 = 1545.35;
console.log(`\n\nGegenprobe N24: EEG-Zahlungseingang 2025 = ${eur(eegIst2025)} EUR`);
console.log(`  Das entspricht bei ${(N24.eegTeil * 100).toFixed(3)} ct/kWh einer Einspeisung von `
  + `${eur(eegIst2025 / N24.eegTeil)} kWh.`);
console.log(`  Zusammen mit dem abgeleiteten Eigenverbrauch von ${eur(pvEigenverbrauch(N24))} kWh`);
console.log(`  wäre die Erzeugung ${eur(eegIst2025 / N24.eegTeil + pvEigenverbrauch(N24))} kWh `
  + `= ${((eegIst2025 / N24.eegTeil + pvEigenverbrauch(N24)) / N24.kwp).toFixed(0)} kWh/kWp.`);
console.log('  Das liegt deutlich über dem Erfahrungswert von rund 1.000 kWh/kWp.');
console.log('  Ohne die Einspeiseabrechnung ist nicht zu entscheiden, welche Größe falsch ist.');
