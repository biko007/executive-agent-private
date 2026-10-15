/**
 * assets/mietforderungen — Sollstellung, Zahlungszuordnung und Lämpchen.
 *
 * DAS PROBLEM. Bisher zeigte das Dashboard je Einheit nur die Kaltmiete, und ob
 * ein Mieter tatsächlich gezahlt hat, stand nirgends. Der Abgleich lief von
 * Hand über die Kontoauszüge — so sind im Oktober 2026 fünf ausgefallene
 * Monatsmieten von Familie De Meo erst beim Durchsehen aufgefallen, die älteste
 * zehn Monate alt.
 *
 * DER WEG. Drei Schritte, die aufeinander aufbauen:
 *
 *   1. SOLLSTELLUNG. Aus jedem Mietvertrag entsteht für jeden Monat seiner
 *      Laufzeit eine Forderung, mit den Bestandteilen getrennt: Grundmiete,
 *      Betriebskosten, Heizkosten, Garage, Küche. Beginnt oder endet der
 *      Vertrag mitten im Monat, wird tagegenau geteilt.
 *   2. ZUORDNUNG. Jeder Zahlungseingang wird einem Vertrag zugeordnet — zuerst
 *      über die IBAN des Zahlers, sonst über Name und Verwendungszweck. Die
 *      Zahlung tilgt die älteste offene Forderung; was übrig bleibt, läuft in
 *      die nächste. Was sich nicht zuordnen lässt, bleibt liegen und wird
 *      angezeigt. Geraten wird nicht.
 *   3. LÄMPCHEN. Grün, wenn seit dem 01.01.2025 alle fälligen Forderungen
 *      beglichen sind; sonst rot mit den fehlenden Monaten.
 *
 * ZWEI ENTSCHEIDUNGEN DES OWNERS stecken darin:
 *
 *   - Nur Grün und Rot, kein Gelb. Eine halb bezahlte Miete ist nicht bezahlt.
 *   - Die vier Einheiten, die der Eigentümer selbst nutzt, bekommen eine
 *     Forderung wie alle anderen, gelten aber immer als beglichen. Das hängt am
 *     Vertragsmerkmal `owner_hauptmieter` und nicht an einer Liste im Code —
 *     die L19-Einheiten werden bald umgewandelt, dann genügt ein Haken.
 *
 * WELCHE UMSÄTZE ZÄHLEN. Erst hieß es „nur FinTS". Das war für die laufenden
 * Monate richtig und für die Historie falsch: **Juli und August 2026 enthalten
 * auf beiden Konten KEINEN einzigen FinTS-Umsatz**, September nur neun. Diese
 * Monate stehen ausschließlich als Kontoauszug-Nachtrag im Bestand. Wer sie
 * weglässt, erklärt dreizehn pünktliche Mieter zu Säumigen — genau das ist im
 * ersten Probelauf passiert.
 *
 * Deshalb zählen beide Quellen, mit FinTS als Vorrang: Steht dieselbe Buchung
 * in beiden, gewinnt die FinTS-Fassung; die nachgetragene bleibt außen vor.
 *
 * WAS NICHT BEWERTET WIRD. Ein Monat ohne jede Buchung auf dem Konto sagt
 * nichts über den Mieter — er sagt nur, dass die Bankdaten fehlen. Solche
 * Monate gelten weder als bezahlt noch als offen, sondern als „keine
 * Bankdaten". Rot wird ein Mieter nur, wenn in einem Monat MIT Bankdaten eine
 * Zahlung fehlt oder zu gering ist.
 */
import { query as dbQuery } from '../../shared/db/index.js';

/** Ab hier wird gerechnet — Owner-Vorgabe. */
export const SOLL_AB = '2025-01-01';

/** Feiertage, die in Baden-Württemberg auf einen Werktag fallen können. */
const FEIERTAGE_BW = new Set([
  '01-01', '05-01', '10-03', '11-01', '12-25', '12-26',
]);

/** Ein ISO-Tag `YYYY-MM-DD` aus Jahr, Monat (1–12) und Tag. */
export function isoTag(jahr: number, monat: number, tag: number): string {
  return `${jahr}-${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
}

export function tageImMonat(jahr: number, monat: number): number {
  return new Date(Date.UTC(jahr, monat, 0)).getUTCDate();
}

/**
 * Der n-te Werktag eines Monats — der übliche Fälligkeitstag der Miete, wenn
 * der Vertrag nichts anderes sagt (§ 556b BGB: spätestens am dritten Werktag).
 *
 * Werktag ist Montag bis Samstag; die festen Feiertage sind ausgenommen. Die
 * beweglichen Feiertage bleiben unberücksichtigt — sie fallen nie auf die
 * ersten drei Tage eines Monats außer am 1. Mai und am 3. Oktober, und die
 * stehen in der Liste.
 */
export function werktag(jahr: number, monat: number, n = 3): string {
  let gefunden = 0;
  const letzter = tageImMonat(jahr, monat);
  for (let tag = 1; tag <= letzter; tag++) {
    const d = new Date(Date.UTC(jahr, monat - 1, tag));
    const wochentag = d.getUTCDay();
    const mmdd = `${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
    if (wochentag === 0 || FEIERTAGE_BW.has(mmdd)) continue;
    gefunden++;
    if (gefunden === n) return isoTag(jahr, monat, tag);
  }
  return isoTag(jahr, monat, letzter);
}

export interface VertragSoll {
  id: number;
  start_date: string;
  end_date: string | null;
  kaltmiete: number | null;
  nk_vorauszahlung: number | null;
  heizkosten_vorauszahlung: number | null;
  garage_amount: number | null;
  kitchen_amount: number | null;
  rent_due_day: number | null;
  owner_hauptmieter: boolean;
}

export interface SollZeile {
  lease_id: number;
  period_month: string;
  due_date: string;
  anteil: number;
  kaltmiete: number;
  nk: number;
  heizkosten: number;
  garage: number;
  kitchen: number;
  expected: number;
  gilt_als_bezahlt: boolean;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Anteil eines Monats, den der Vertrag abdeckt — tagegenau.
 *
 * Ein am 15.05. beginnender Vertrag trägt im Mai 17 von 31 Tagen. Das ist die
 * Rechnung, die auch die Mietverträge selbst verwenden; ein halber Monat wäre
 * bei ungleich langen Monaten falsch.
 */
export function anteilImMonat(v: VertragSoll, jahr: number, monat: number): number {
  const erster = isoTag(jahr, monat, 1);
  const letzterTag = tageImMonat(jahr, monat);
  const letzter = isoTag(jahr, monat, letzterTag);
  const von = v.start_date > erster ? v.start_date : erster;
  const bis = v.end_date && v.end_date < letzter ? v.end_date : letzter;
  if (von > bis) return 0;
  const tage = (Date.parse(`${bis}T00:00:00Z`) - Date.parse(`${von}T00:00:00Z`)) / 86400000 + 1;
  return Math.round((tage / letzterTag) * 10000) / 10000;
}

/**
 * Die Forderungen eines Vertrags im Zeitraum.
 *
 * `bis` ist der letzte zu stellende Monat als `YYYY-MM` — in der Regel der
 * laufende. Rückwärts reicht es höchstens bis SOLL_AB.
 */
export function sollZeilen(v: VertragSoll, bis: string, ab = SOLL_AB): SollZeile[] {
  if (v.kaltmiete === null || v.kaltmiete === undefined) return [];
  const [bj, bm] = bis.split('-').map(Number);
  const start = v.start_date > ab ? v.start_date : ab;
  const [sj, sm] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
  const zeilen: SollZeile[] = [];
  for (let jahr = sj; jahr <= bj; jahr++) {
    const vonM = jahr === sj ? sm : 1;
    const bisM = jahr === bj ? bm : 12;
    for (let monat = vonM; monat <= bisM; monat++) {
      const anteil = anteilImMonat(v, jahr, monat);
      if (anteil <= 0) continue;
      const kalt = r2((v.kaltmiete || 0) * anteil);
      const nk = r2((v.nk_vorauszahlung || 0) * anteil);
      const heiz = r2((v.heizkosten_vorauszahlung || 0) * anteil);
      const gar = r2((v.garage_amount || 0) * anteil);
      const kue = r2((v.kitchen_amount || 0) * anteil);
      zeilen.push({
        lease_id: v.id,
        period_month: isoTag(jahr, monat, 1),
        due_date: v.rent_due_day && v.rent_due_day >= 1 && v.rent_due_day <= 28
          ? isoTag(jahr, monat, v.rent_due_day)
          : werktag(jahr, monat, 3),
        anteil,
        kaltmiete: kalt, nk, heizkosten: heiz, garage: gar, kitchen: kue,
        expected: r2(kalt + nk + heiz + gar + kue),
        gilt_als_bezahlt: !!v.owner_hauptmieter,
      });
    }
  }
  return zeilen;
}

/**
 * Welches Konto führt welches Objekt?
 *
 * Die Mieten aller Objekte des Eigentümers laufen über das Mietkonto; N24
 * gehört der La Perla GmbH und läuft über deren Geschäftsgiro. Das ist eine
 * Tatsache der Kontoführung, keine Annahme — sie entscheidet, für welches
 * Konto die Abdeckung eines Monats geprüft wird.
 */
export const OBJEKT_KONTO: Record<string, number> = {
  n24: 4,
  mg24: 7, l19: 7, s28: 7, i83: 7, d4: 7,
};
export const KONTO_STANDARD = 7;

/** Monatsnamen in den drei Sprachen, die in den Verwendungszwecken vorkommen. */
const MONATSWORTE: Record<string, number> = {
  januar: 1, january: 1, enero: 1, jan: 1,
  februar: 2, february: 2, febrero: 2, feb: 2,
  maerz: 3, march: 3, marzo: 3, mar: 3,
  april: 4, abril: 4, apr: 4,
  mai: 5, may: 5, mayo: 5,
  juni: 6, june: 6, junio: 6, jun: 6,
  juli: 7, july: 7, julio: 7, jul: 7,
  august: 8, agosto: 8, aug: 8,
  september: 9, septiembre: 9, setiembre: 9, sep: 9, sept: 9,
  oktober: 10, october: 10, octubre: 10, okt: 10, oct: 10,
  november: 11, noviembre: 11, nov: 11,
  dezember: 12, december: 12, diciembre: 12, dez: 12, dec: 12,
};

/**
 * Welchen Monat nennt der Verwendungszweck?
 *
 * Viele Mieter schreiben ihn hin: „Miete Oktober 2025", „October 26",
 * „alquiler de enero 2026", „Miete Marktgasse 24. 11/25", „aprilmiete 2026".
 * Wer das tut, hat Anspruch darauf, dass die Zahlung auf DIESEN Monat gebucht
 * wird — § 366 Abs. 1 BGB: Die Tilgungsbestimmung des Schuldners geht vor.
 * Erst ohne Angabe gilt die älteste offene Forderung.
 *
 * `bezug` ist das Buchungsdatum; aus ihm kommt das Jahr, wenn der Zweck keines
 * nennt. Eine im Januar gezahlte Dezembermiete gehört ins Vorjahr.
 */
export function monatAusZweck(zweck: string | null | undefined, bezug: string): string | null {
  const z = normal(zweck);
  if (!z) return null;
  const bezugJahr = Number(bezug.slice(0, 4));
  const bezugMonat = Number(bezug.slice(5, 7));

  /* Zuerst die Zahlformen: 11/25, 11/2025, 2025-11. Sie sind eindeutig. */
  const roh = String(zweck);
  const m1 = roh.match(/\b(0?[1-9]|1[0-2])\s*[\/.]\s*(20\d{2}|\d{2})\b/);
  if (m1) {
    const monat = Number(m1[1]);
    const jahr = m1[2].length === 4 ? Number(m1[2]) : 2000 + Number(m1[2]);
    if (jahr >= 2020 && jahr <= 2040) return `${jahr}-${String(monat).padStart(2, '0')}-01`;
  }
  const m2 = roh.match(/\b(20\d{2})-(0?[1-9]|1[0-2])\b/);
  if (m2) return `${m2[1]}-${String(Number(m2[2])).padStart(2, '0')}-01`;

  /* Dann die Wortform. „aprilmiete" schreibt der Mieter ohne Leerzeichen —
     deshalb wird nicht auf Wortgrenzen geprüft, sondern auf Vorkommen. Kurze
     Kürzel wie „mar" nur, wenn sie als eigenes Wort stehen: sonst träfe „mar"
     in „Marktgasse". */
  let gefunden: number | null = null;
  for (const [wort, monat] of Object.entries(MONATSWORTE)) {
    const treffer = wort.length <= 4
      ? new RegExp(`(^| )${wort}( |$)`).test(z)
      : z.includes(wort);
    if (!treffer) continue;
    if (gefunden !== null && gefunden !== monat) return null;  // mehrdeutig
    gefunden = monat;
  }
  if (gefunden === null) return null;

  const jahrImZweck = roh.match(/\b(20[2-4]\d)\b/);
  let jahr = jahrImZweck ? Number(jahrImZweck[1]) : bezugJahr;
  if (!jahrImZweck) {
    /* Ohne Jahresangabe: Der genannte Monat liegt nahe am Buchungsmonat.
       Eine im Januar gezahlte „Dezember"-Miete gehört ins Vorjahr, eine im
       Dezember gezahlte „Januar"-Miete ins Folgejahr. */
    if (gefunden - bezugMonat > 6) jahr -= 1;
    else if (bezugMonat - gefunden > 6) jahr += 1;
  }
  return `${jahr}-${String(gefunden).padStart(2, '0')}-01`;
}

/* ── Zuordnung ──────────────────────────────────────────────────────────── */

export interface Zahlung {
  id: number;
  account_id: number;
  booking_date: string;
  amount: number;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  reference: string | null;
}

export interface Zahler {
  lease_id: number;
  iban: string | null;
  name: string | null;
  /** Begriffe, die im Verwendungszweck auf diesen Vertrag deuten (Objekt, Einheit). */
  stichworte: string[];
}

export type Grundlage = 'iban' | 'name_zweck' | 'manuell' | 'owner_hauptmieter';

/**
 * Eingänge, die trotz passendem Namen KEINE Miete sind.
 *
 * Ohne diese Sperre verrechnet der Abgleich eine Kaution als Miete und lässt
 * dafür die letzten Monate offen stehen — im Probelauf vom 15.10.2026 genau
 * so geschehen. Eine Kaution gehört auf das Kautionskonto, eine
 * Abrechnungsnachzahlung zur Nebenkostenabrechnung.
 */
const KEINE_MIETE = [
  'kaution', 'mietkaution',
  'nebenkostenabrechnung', 'heizkostenabrechnung', 'betriebskostenabrechnung',
  'nebenkostenabr', 'heizkostenabr',
  'rueckzahlung', 'erstattung', 'gutschrift',
];

/**
 * Mieterstrom läuft als eigener Liefervertrag (§ 42a EnWG) und nicht über die
 * Miete: W1 von N24 überweist monatlich 70,00 € mit dem Vertragszeichen
 * „341-003", Familie De Meo denselben Betrag als „Strom". Ohne diese Sperre
 * tilgen elf Stromabschläge eine Drittelmiete.
 *
 * In der normalisierten Form steht statt des Bindestrichs ein Leerzeichen:
 * aus „341-003" wird „341 003".
 */
const MIETERSTROM = ['strom', '341 0'];

/** Obergrenze eines Mieterstrom-Abschlags. Die Abschläge liegen bei 70,00 €. */
const MIETERSTROM_HOECHSTBETRAG = 200;

/** Wörter, die eine Zahlung ausdrücklich als Miete ausweisen — auch mehrsprachig. */
const MIETWORT = ['miete', 'mieten', 'vermietung', 'mietzahlung', 'alquiler', 'rent'];

/**
 * Spricht der Verwendungszweck dagegen, dass dies eine Mietzahlung ist?
 *
 * Der Betrag entscheidet mit: „miete juni plus 50 euro strom" über 1.540,00 €
 * ist eine Miete, die den Strom nur nebenbei erwähnt. Die erste Fassung hat
 * genau diese Zahlung und eine zweite über 1.390,00 € verworfen und dem Mieter
 * zwei Monate Rückstand angerechnet, die er bezahlt hatte.
 */
export function istKeineMiete(zweck: string | null | undefined, betrag?: number): boolean {
  const z = normal(zweck);
  if (!z) return false;
  if (KEINE_MIETE.some(w => z.includes(w))) return true;
  if (!MIETERSTROM.some(w => z.includes(w))) return false;
  if (betrag !== undefined && betrag > MIETERSTROM_HOECHSTBETRAG) return false;
  return !MIETWORT.some(w => z.includes(w));
}

/** Satzzeichen weg, Umlaute vereinheitlicht, alles klein — für den Namensvergleich. */
export function normal(s: string | null | undefined): string {
  return String(s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Welcher Vertrag gehört zu dieser Zahlung?
 *
 * Drei Stufen, in dieser Reihenfolge:
 *
 *   1. IBAN. Sie ist eindeutig und wechselt selten — sie schlägt alles.
 *   2. NAME, wenn er auf genau ein Mietverhältnis passt. „Elena Lazic" ist
 *      eindeutig, auch wenn im Verwendungszweck nur „Miete Elena Lazic" steht.
 *   3. NAME PLUS STICHWORT, wenn der Name auf mehrere passt. „Bickel" steht
 *      für vier Beteiligte; dann muss der Verwendungszweck sagen, welches
 *      Objekt gemeint ist.
 *
 * Bleibt es mehrdeutig, wird NICHT zugeordnet. Eine falsch verrechnete Miete
 * ist schlimmer als eine offene Zeile im Bericht.
 *
 * Die erste Fassung verlangte das Stichwort immer. Im Probelauf blieben damit
 * 339 von 431 Eingängen liegen — die meisten Mieter schreiben ihren Namen in
 * den Zweck, nicht die Adresse.
 */
export function zuordnen(z: Zahlung, zahler: Zahler[]): { lease_id: number; grundlage: Grundlage } | null {
  if (istKeineMiete(z.reference, z.amount)) return null;
  const iban = String(z.counterparty_iban || '').replace(/\s+/g, '').toUpperCase();
  if (iban) {
    const treffer = zahler.filter(k => k.iban && k.iban.replace(/\s+/g, '').toUpperCase() === iban);
    const eindeutig = new Set(treffer.map(t => t.lease_id));
    if (eindeutig.size === 1) return { lease_id: treffer[0].lease_id, grundlage: 'iban' };
    if (eindeutig.size > 1) return null;
  }
  const name = normal(z.counterparty_name);
  const zweck = normal(z.reference);
  if (!name) return null;

  /* Ein Zahler passt namentlich, wenn jeder seiner Namensteile ab drei
     Buchstaben im Zahlernamen vorkommt. Das traegt ueber Akzente und
     Schreibweisen hinweg: „Andre Deiß" trifft „André Deiß". */
  const namentlich = zahler.filter(k => {
    if (!k.name) return false;
    const teile = normal(k.name).split(' ').filter(t => t.length >= 3);
    return teile.length > 0 && teile.every(t => name.includes(t));
  });
  const vertraege = new Set(namentlich.map(t => t.lease_id));
  if (vertraege.size === 1) {
    return { lease_id: namentlich[0].lease_id, grundlage: 'name_zweck' };
  }

  /* Zweiter Versuch ueber den NACHNAMEN allein — aber nur, wenn er im ganzen
     Bestand eindeutig ist.
     Anlass: Die Bank kuerzt lange Zahlernamen. Aus „Richard Maximilian
     Rettenbacher und Phillippa…" wird „RICHARD M. RETTENBACHER UND PH"; der
     zweite Vorname fehlt, und die strenge Regel trifft nicht mehr.
     „Rettenbacher" kommt nur einmal vor, „Bickel" viermal — deshalb die
     Eindeutigkeitspruefung. Nachnamen unter fuenf Buchstaben bleiben aussen
     vor, sie sind als Schluessel zu schwach. */
  if (vertraege.size === 0) {
    const nachnamen = new Map<string, Set<number>>();
    for (const k of zahler) {
      if (!k.name) continue;
      const teile = normal(k.name).split(' ').filter(t => t.length >= 5);
      const nachname = teile[teile.length - 1];
      if (!nachname) continue;
      const menge = nachnamen.get(nachname) || new Set<number>();
      menge.add(k.lease_id);
      nachnamen.set(nachname, menge);
    }
    const treffer: number[] = [];
    for (const [nachname, vertraegeDesNamens] of nachnamen) {
      if (vertraegeDesNamens.size !== 1) continue;
      if (name.includes(nachname)) treffer.push([...vertraegeDesNamens][0]);
    }
    if (new Set(treffer).size === 1) {
      return { lease_id: treffer[0], grundlage: 'name_zweck' };
    }
    return null;
  }

  /* Mehrdeutig — jetzt entscheidet der Verwendungszweck. */
  const mitStichwort = namentlich.filter(k =>
    k.stichworte.some(st => zweck.includes(normal(st))));
  const eindeutig = new Set(mitStichwort.map(t => t.lease_id));
  if (eindeutig.size === 1) return { lease_id: mitStichwort[0].lease_id, grundlage: 'name_zweck' };
  return null;
}

/* ── Datenbank ──────────────────────────────────────────────────────────── */

/** Der laufende Monat als `YYYY-MM`. */
export function laufenderMonat(heute = new Date()): string {
  return `${heute.getUTCFullYear()}-${String(heute.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface SollstellungErgebnis {
  vertraege: number;
  neu: number;
  aktualisiert: number;
  unveraendert: number;
  ohne_sollbetrag: { lease_id: number; objekt: string; einheit: string }[];
}

/**
 * Forderungen erzeugen oder fortschreiben.
 *
 * Von Hand erfasste Zeilen (`erzeugt = false`) bleiben unangetastet — die
 * sieben Rückstände vom 15.10.2026 sind so entstanden und dürfen nicht von
 * einer Neuberechnung überschrieben werden.
 */
export async function sollstellungErzeugen(
  opts: { bis?: string; probelauf?: boolean } = {},
): Promise<SollstellungErgebnis> {
  const bis = opts.bis || laufenderMonat();
  const { rows: vertraege } = await dbQuery<any>(`
    SELECT l.id, to_char(l.start_date,'YYYY-MM-DD') AS start_date,
           to_char(l.end_date,'YYYY-MM-DD') AS end_date,
           l.kaltmiete::float, l.nk_vorauszahlung::float, l.heizkosten_vorauszahlung::float,
           l.garage_amount::float, l.kitchen_amount::float, l.rent_due_day,
           l.owner_hauptmieter, u.code AS einheit, p.code AS objekt
      FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     ORDER BY p.code, u.code, l.start_date`);

  const ergebnis: SollstellungErgebnis = {
    vertraege: vertraege.length, neu: 0, aktualisiert: 0, unveraendert: 0, ohne_sollbetrag: [],
  };

  for (const v of vertraege) {
    if (v.kaltmiete === null) {
      ergebnis.ohne_sollbetrag.push({ lease_id: v.id, objekt: v.objekt, einheit: v.einheit });
      continue;
    }
    for (const z of sollZeilen(v as VertragSoll, bis)) {
      const { rows: da } = await dbQuery<any>(
        `SELECT id, erzeugt, expected_amount::float AS expected FROM rent_ledger
          WHERE lease_id = $1 AND period_month = $2`, [z.lease_id, z.period_month]);
      if (da.length && !da[0].erzeugt) { ergebnis.unveraendert++; continue; }
      if (da.length && Math.abs(da[0].expected - z.expected) < 0.005) { ergebnis.unveraendert++; continue; }
      if (opts.probelauf) { da.length ? ergebnis.aktualisiert++ : ergebnis.neu++; continue; }
      if (da.length) {
        await dbQuery(
          `UPDATE rent_ledger SET expected_amount=$1, due_date=$2, anteil=$3,
             kaltmiete_amount=$4, nk_amount=$5, heizkosten_amount=$6, garage_amount=$7,
             kitchen_amount=$8, gilt_als_bezahlt=$9, updated_at=now() WHERE id=$10`,
          [z.expected, z.due_date, z.anteil, z.kaltmiete, z.nk, z.heizkosten, z.garage,
           z.kitchen, z.gilt_als_bezahlt, da[0].id]);
        ergebnis.aktualisiert++;
      } else {
        await dbQuery(
          `INSERT INTO rent_ledger (lease_id, period_month, due_date, expected_amount, paid_amount,
             status, anteil, kaltmiete_amount, nk_amount, heizkosten_amount, garage_amount,
             kitchen_amount, erzeugt, gilt_als_bezahlt, booking_text)
           VALUES ($1,$2,$3,$4,0,'open',$5,$6,$7,$8,$9,$10,true,$11,$12)`,
          [z.lease_id, z.period_month, z.due_date, z.expected, z.anteil, z.kaltmiete, z.nk,
           z.heizkosten, z.garage, z.kitchen, z.gilt_als_bezahlt,
           `Sollstellung ${z.period_month.slice(0, 7)}`]);
        ergebnis.neu++;
      }
    }
  }
  return ergebnis;
}

/** Die bekannten Zahler je Vertrag: hinterlegte Zahler plus die Mieter selbst. */
export async function zahlerListe(): Promise<Zahler[]> {
  const liste: Zahler[] = [];
  const { rows: hinterlegt } = await dbQuery<any>(
    `SELECT lease_id, iban, name FROM lease_payers WHERE active`);
  const { rows: stich } = await dbQuery<any>(`
    SELECT l.id AS lease_id, p.code AS objekt, p.street, u.code AS einheit
      FROM leases l JOIN units u ON u.id=l.unit_id JOIN properties p ON p.id=u.property_id`);
  const stichworte = new Map<number, string[]>();
  for (const s of stich) {
    /* Was im Verwendungszweck auf dieses Mietverhaeltnis deutet: Objektkuerzel,
       Strasse ohne Hausnummer, Einheit. Mehr nicht — „Miete" allein deutet auf
       nichts. */
    const strasse = String(s.street || '').replace(/\s*\d+.*$/, '');
    stichworte.set(s.lease_id, [s.objekt, strasse, s.einheit].filter(Boolean));
  }
  for (const h of hinterlegt) {
    liste.push({ lease_id: h.lease_id, iban: h.iban, name: h.name,
      stichworte: stichworte.get(h.lease_id) || [] });
  }
  const { rows: mieter } = await dbQuery<any>(`
    SELECT lt.lease_id, t.first_name, t.last_name, t.company_name, t.iban
      FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id`);
  for (const m of mieter) {
    const name = m.company_name || [m.first_name, m.last_name].filter(Boolean).join(' ');
    if (!name && !m.iban) continue;
    liste.push({ lease_id: m.lease_id, iban: m.iban || null, name: name || null,
      stichworte: stichworte.get(m.lease_id) || [] });
  }
  return liste;
}

/**
 * Für welche Monate liegen auf einem Konto überhaupt Bankdaten vor?
 *
 * Ein Monat gilt als abgedeckt, sobald er mindestens eine Buchung trägt —
 * gleich aus welcher Quelle. Das ist bewusst grob: Ob ein einzelner Umsatz
 * fehlt, lässt sich von außen nicht feststellen; ob ein ganzer Monat fehlt,
 * sehr wohl. Und nur das trennt „hat nicht gezahlt" von „wissen wir nicht".
 */
export async function abdeckung(ab = SOLL_AB, bis?: string): Promise<Map<number, Set<string>>> {
  const { rows } = await dbQuery<any>(`
    SELECT account_id, to_char(booking_date,'YYYY-MM') AS monat, count(*)::int AS n
      FROM banking_transactions
     WHERE booking_date >= $1 ${bis ? 'AND booking_date <= $2' : ''}
     GROUP BY account_id, to_char(booking_date,'YYYY-MM')`,
    bis ? [ab, bis] : [ab]);
  /* account_id ist bigint und kommt aus pg als Zeichenkette — ohne Number()
     greift der spaetere Zugriff mit einer Zahl ins Leere, und jeder Monat
     gaelte als „keine Bankdaten". Genau das ist im Probelauf passiert. */
  const karte = new Map<number, Set<string>>();
  for (const r of rows) {
    const konto = Number(r.account_id);
    const menge = karte.get(konto) || new Set<string>();
    menge.add(r.monat);
    karte.set(konto, menge);
  }
  return karte;
}

/** Das Konto, über das die Mieten eines Objekts laufen. */
export function kontoFuer(objekt: string): number {
  return OBJEKT_KONTO[String(objekt).toLowerCase()] ?? KONTO_STANDARD;
}

export interface ZuordnungErgebnis {
  geprueft: number;
  zugeordnet: number;
  verrechnet: number;
  offen_geblieben: number;
  gelernte_zahler: number;
  nicht_zugeordnet: { id: number; datum: string; betrag: number; name: string; zweck: string }[];
}

/**
 * Eingänge den Forderungen zuordnen.
 *
 * Verrechnet wird auf die älteste offene Forderung des Vertrags; bleibt etwas
 * übrig, läuft es in die nächste. Eine Überzahlung über alle Forderungen hinaus
 * wird nicht verteilt — sie bleibt als Guthaben stehen und taucht im Bericht
 * auf, damit niemand sie stillschweigend verrechnet.
 *
 * Die IBAN eines zugeordneten Zahlers wird gelernt: Beim nächsten Lauf trifft
 * dieselbe Zahlung über die IBAN statt über den Namen.
 */
export async function zahlungenZuordnen(
  opts: { probelauf?: boolean } = {},
): Promise<ZuordnungErgebnis> {
  const erg: ZuordnungErgebnis = {
    geprueft: 0, zugeordnet: 0, verrechnet: 0, offen_geblieben: 0,
    gelernte_zahler: 0, nicht_zugeordnet: [],
  };
  const zahler = await zahlerListe();

  /* Beide Quellen, Eingänge ab dem Sollstellungsbeginn, jede Buchung einmal.
     Die Entdopplung läuft hier noch einmal über Konto, Tag und Betrag — auch
     wenn `duplicate_of` noch nicht gesetzt ist, soll der Abgleich stimmen. */
  const { rows: zahlungen } = await dbQuery<any>(`
    WITH kandidaten AS (
      SELECT t.id, t.account_id, to_char(t.booking_date,'YYYY-MM-DD') AS booking_date,
             t.amount::float AS amount, t.counterparty_name, t.counterparty_iban,
             t.reference, t.source,
             row_number() OVER (
               PARTITION BY t.account_id, t.booking_date, t.amount
               ORDER BY CASE WHEN t.source = 'fints' THEN 0 ELSE 1 END, t.id
             ) AS rang
        FROM banking_transactions t
       WHERE t.amount > 0 AND t.booking_date >= $1 AND t.duplicate_of IS NULL
         AND NOT EXISTS (SELECT 1 FROM rent_payment_links l WHERE l.transaction_id = t.id))
    SELECT * FROM kandidaten WHERE rang = 1 ORDER BY booking_date, id`, [SOLL_AB]);

  for (const z of zahlungen as Zahlung[]) {
    erg.geprueft++;
    const treffer = zuordnen(z, zahler);
    if (!treffer) {
      erg.nicht_zugeordnet.push({
        id: z.id, datum: z.booking_date, betrag: z.amount,
        name: z.counterparty_name || '', zweck: (z.reference || '').slice(0, 80),
      });
      continue;
    }
    erg.zugeordnet++;
    if (opts.probelauf) continue;

    /* Gelernter Zahler: nur, wenn die IBAN neu ist. */
    if (z.counterparty_iban) {
      const { rows: da } = await dbQuery<any>(
        `SELECT 1 FROM lease_payers WHERE lease_id=$1 AND iban=$2`,
        [treffer.lease_id, z.counterparty_iban]);
      if (!da.length) {
        await dbQuery(
          `INSERT INTO lease_payers (lease_id, iban, name, notes)
           VALUES ($1,$2,$3,$4)`,
          [treffer.lease_id, z.counterparty_iban, z.counterparty_name,
           `Gelernt am ${new Date().toISOString().slice(0, 10)} aus Umsatz ${z.id} `
           + `(Grundlage: ${treffer.grundlage}).`]);
        erg.gelernte_zahler++;
      }
    }

    let rest = Math.round(z.amount * 100) / 100;
    const { rows: alle } = await dbQuery<any>(`
      SELECT r.id, to_char(r.period_month,'YYYY-MM-DD') AS monat,
             r.expected_amount::float AS soll, r.paid_amount::float AS ist
        FROM rent_ledger r
       WHERE r.lease_id = $1 AND r.status <> 'paid'
         AND r.expected_amount > coalesce(r.paid_amount,0)
       ORDER BY r.period_month`, [treffer.lease_id]);
    /* Nennt der Verwendungszweck einen Monat, gilt er (§ 366 Abs. 1 BGB).
       Sonst die älteste offene Forderung. */
    const genannt = monatAusZweck(z.reference, z.booking_date);
    const offen = genannt
      ? [...alle.filter((f: any) => f.monat === genannt), ...alle.filter((f: any) => f.monat !== genannt)]
      : alle;
    for (const f of offen) {
      if (rest <= 0.004) break;
      const fehlt = Math.round((f.soll - (f.ist || 0)) * 100) / 100;
      const betrag = Math.min(rest, fehlt);
      await dbQuery(
        `INSERT INTO rent_payment_links (rent_ledger_id, transaction_id, amount, grundlage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (rent_ledger_id, transaction_id) DO NOTHING`,
        [f.id, z.id, betrag, treffer.grundlage]);
      const neuIst = Math.round(((f.ist || 0) + betrag) * 100) / 100;
      await dbQuery(
        `UPDATE rent_ledger SET paid_amount=$1, payment_date=$2, bank_transaction_id=$3,
           status = CASE WHEN $1 >= expected_amount - 0.005 THEN 'paid' ELSE 'partial' END,
           updated_at=now() WHERE id=$4`,
        [neuIst, z.booking_date, String(z.id), f.id]);
      rest = Math.round((rest - betrag) * 100) / 100;
      erg.verrechnet++;
    }
    if (rest > 0.004) erg.offen_geblieben++;
  }
  return erg;
}

export interface Ampel {
  lease_id: number;
  objekt: string;
  einheit: string;
  mieter: string;
  /** Mieter-Kennungen des Vertrags — damit die Mieterliste ihr Laempchen findet. */
  tenant_ids: number[];
  owner_hauptmieter: boolean;
  /** Konto, über das die Mieten dieses Objekts laufen. */
  konto: number;
  /** Fällige Monate, für die auf dem Konto keine Buchung vorliegt — nicht bewertet. */
  monate_ohne_bankdaten: string[];
  /** Monatliches Gesamtsoll laut Vertrag — das, was unter „Miete/Mo" stehen soll. */
  monatssoll: number;
  bestandteile: { kaltmiete: number; nk: number; heizkosten: number; garage: number; kueche: number };
  soll: number;
  ist: number;
  saldo: number;
  offene_monate: string[];
  farbe: 'gruen' | 'rot';
  kennzeichen?: string;
}

/**
 * Lämpchen je Mietverhältnis.
 *
 * Gezählt werden nur FÄLLIGE Forderungen: Was erst nächsten Monat fällig wird,
 * macht niemanden rot.
 */
export async function ampelJeMieter(stichtag?: string): Promise<Ampel[]> {
  const heute = stichtag || new Date().toISOString().slice(0, 10);
  const deckung = await abdeckung(SOLL_AB, heute);
  const { rows } = await dbQuery<any>(`
    SELECT l.id AS lease_id, p.code AS objekt, u.code AS einheit, l.owner_hauptmieter,
           l.status, to_char(l.end_date,'YYYY-MM-DD') AS end_date,
           coalesce(l.kaltmiete,0)::float AS kaltmiete,
           coalesce(l.nk_vorauszahlung,0)::float AS nk,
           coalesce(l.heizkosten_vorauszahlung,0)::float AS heizkosten,
           coalesce(l.garage_amount,0)::float AS garage,
           coalesce(l.kitchen_amount,0)::float AS kueche,
           coalesce(string_agg(DISTINCT coalesce(t.company_name,
             trim(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,''))), ', '), '') AS mieter,
           coalesce(array_agg(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL), '{}') AS tenant_ids
      FROM leases l
      JOIN units u ON u.id = l.unit_id
      JOIN properties p ON p.id = u.property_id
      LEFT JOIN lease_tenants lt ON lt.lease_id = l.id
      LEFT JOIN tenants t ON t.id = lt.tenant_id
     GROUP BY l.id, p.code, u.code, l.owner_hauptmieter, l.status, l.end_date,
              l.kaltmiete, l.nk_vorauszahlung, l.heizkosten_vorauszahlung,
              l.garage_amount, l.kitchen_amount
     ORDER BY p.code, u.code, l.id`);

  const ampeln: Ampel[] = [];
  for (const v of rows) {
    const { rows: f } = await dbQuery<any>(`
      SELECT to_char(period_month,'YYYY-MM') AS monat, expected_amount::float AS soll,
             coalesce(paid_amount,0)::float AS ist, gilt_als_bezahlt
        FROM rent_ledger WHERE lease_id=$1 AND due_date <= $2 ORDER BY period_month`,
      [v.lease_id, heute]);
    /* Nur Monate mit Bankdaten werden bewertet. Fuer die eigenen Einheiten
       spielt die Abdeckung keine Rolle — dort gilt die Forderung ohnehin als
       beglichen. */
    const konto = kontoFuer(v.objekt);
    const monateMitDaten = deckung.get(konto) || new Set<string>();
    let soll = 0; let ist = 0; const offen: string[] = []; const ohneDaten: string[] = [];
    for (const z of f) {
      const eigen = !!v.owner_hauptmieter || !!z.gilt_als_bezahlt;
      if (!eigen && !monateMitDaten.has(z.monat)) { ohneDaten.push(z.monat); continue; }
      soll += z.soll;
      const gezahlt = eigen ? z.soll : z.ist;
      ist += gezahlt;
      if (z.soll - gezahlt > 0.005) offen.push(z.monat);
    }
    /* Das Monatssoll zaehlt nur, solange der Vertrag laeuft — ein beendetes
       Mietverhaeltnis darf die Kachel nicht mehr aufblaehen. */
    const laeuft = !v.end_date || v.end_date >= heute;
    const monatssoll = laeuft
      ? Math.round((v.kaltmiete + v.nk + v.heizkosten + v.garage + v.kueche) * 100) / 100 : 0;
    ampeln.push({
      lease_id: v.lease_id, objekt: v.objekt, einheit: v.einheit,
      mieter: v.mieter || '—', tenant_ids: (v.tenant_ids || []).map(Number),
      owner_hauptmieter: !!v.owner_hauptmieter,
      konto, monate_ohne_bankdaten: ohneDaten,
      monatssoll,
      bestandteile: { kaltmiete: v.kaltmiete, nk: v.nk, heizkosten: v.heizkosten,
        garage: v.garage, kueche: v.kueche },
      soll: Math.round(soll * 100) / 100, ist: Math.round(ist * 100) / 100,
      saldo: Math.round((soll - ist) * 100) / 100,
      offene_monate: offen,
      farbe: offen.length ? 'rot' : 'gruen',
      kennzeichen: v.owner_hauptmieter ? 'Hauptmieter Owner – bezahlt' : undefined,
    });
  }
  return ampeln;
}

/** Lämpchen je Objekt: grün nur, wenn jedes Mietverhältnis grün ist. */
export async function ampelJeObjekt(stichtag?: string): Promise<{
  objekt: string; farbe: 'gruen' | 'rot'; mieter_rot: number; mieter_gesamt: number;
  soll: number; ist: number; saldo: number;
}[]> {
  const je = await ampelJeMieter(stichtag);
  const map = new Map<string, { rot: number; n: number; soll: number; ist: number }>();
  for (const a of je) {
    const o = map.get(a.objekt) || { rot: 0, n: 0, soll: 0, ist: 0 };
    o.n++; if (a.farbe === 'rot') o.rot++;
    o.soll += a.soll; o.ist += a.ist;
    map.set(a.objekt, o);
  }
  return [...map].sort((a, b) => a[0].localeCompare(b[0])).map(([objekt, o]) => ({
    objekt, farbe: o.rot ? 'rot' : 'gruen', mieter_rot: o.rot, mieter_gesamt: o.n,
    soll: Math.round(o.soll * 100) / 100, ist: Math.round(o.ist * 100) / 100,
    saldo: Math.round((o.soll - o.ist) * 100) / 100,
  }));
}

/**
 * Dubletten der Bankumsätze markieren — nichts löschen.
 *
 * Gleiches Konto, gleicher Tag, gleicher Betrag, aber zwei Quellen: Dann führt
 * die FinTS-Zeile, und die nachgetragene bekommt den Verweis. Grund für die
 * Dubletten: Der Nachtrag aus dem Kontoauszug prüft zwar, ob ein Umsatz schon
 * da ist — die spätere FinTS-Synchronisierung prüft das umgekehrt nicht.
 */
export async function dublettenMarkieren(
  opts: { probelauf?: boolean } = {},
): Promise<{ gruppen: number; markiert: number }> {
  const { rows } = await dbQuery<any>(`
    SELECT a.id AS pdf_id, f.id AS fints_id
      FROM banking_transactions a
      JOIN banking_transactions f
        ON f.account_id = a.account_id AND f.booking_date = a.booking_date
       AND f.amount = a.amount AND f.source = 'fints'
     WHERE a.source = 'pdf_import' AND a.duplicate_of IS NULL`);
  if (!opts.probelauf) {
    for (const r of rows) {
      await dbQuery(`UPDATE banking_transactions SET duplicate_of=$1 WHERE id=$2`,
        [r.fints_id, r.pdf_id]);
    }
  }
  return { gruppen: rows.length, markiert: opts.probelauf ? 0 : rows.length };
}
