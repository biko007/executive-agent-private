/**
 * nk/nutzerzeit — Welcher Teil eines Jahresverbrauchs gehört dem Nutzer?
 *
 * DAS PROBLEM. Beginnt ein Mietverhältnis mitten im Abrechnungszeitraum, misst
 * der Wohnungszähler trotzdem von Januar an. Was davor verbraucht wurde —
 * Leerstand, Bautrocknung, Winter — ist kein Mieterverbrauch. Bis zum
 * 11.10.2026 nahm die Engine dafür schlicht den Zeitanteil (`active_days /
 * Jahrestage`). Bei MG24 heißt das für die Wohnung im 2. OG: Mietbeginn
 * 01.04.2025, Zeitanteil 75 % — tatsächlich fallen in Januar bis März aber
 * 45 % des Jahresheizbedarfs an. Der Mieter trägt so einen Teil der kalten
 * Monate, in denen er nicht da war.
 *
 * DIE REGEL. § 9b HeizkostenV:
 *
 *   - Abs. 1: Bei Nutzerwechsel ist eine **Zwischenablesung** vorzunehmen.
 *   - Abs. 2: Die nach Verbrauch zu verteilenden Kosten gehen auf Grundlage
 *     dieser Zwischenablesung; die übrigen Kosten des Wärmeverbrauchs nach
 *     **Gradtagszahlen oder zeitanteilig**, die übrigen Kosten des
 *     Warmwasserverbrauchs **zeitanteilig**.
 *   - Abs. 3: Ist eine Zwischenablesung nicht möglich, werden die **gesamten**
 *     Kosten nach den Maßstäben des Absatzes 2 für die übrigen Kosten
 *     aufgeteilt — Wärme also nach Gradtagszahlen, Warmwasser nach Zeit.
 *
 * Für MG24 2025 gilt Absatz 3: Zwischenablesungen zu den Einzugsterminen gibt
 * es nicht und sie lassen sich nachträglich nicht nachholen.
 *
 * WAS DIESES MODUL TUT. Es liefert je Mietverhältnis den Anteil am
 * Zeitraumverbrauch — einmal nach Gradtagszahlen (Wärme) und einmal nach Zeit
 * (Warmwasser, Wasser, Grundkosten) — und sagt dazu, worauf der Anteil beruht.
 * Liegt eine Ablesung zum Einzug vor, hat sie Vorrang: Dann wird gemessen
 * statt aufgeteilt, und die Kennzeichnung sagt auch das.
 *
 * Reine Funktionen auf Daten — keine Datenbank, keine Zeitzonenfallen: Es wird
 * mit ISO-Tagen gerechnet, nicht mit Zeitstempeln.
 */
import type { LeaseRow, MeterReadingRow } from './types.js';

/**
 * Gradtagszahlen nach anerkannten Regeln der Technik (VDI 2067), in Promille
 * des Jahresbedarfs. Dieselbe Tabelle, die die Abrechnungsdienste verwenden.
 *
 * Juni bis August sind in der Tabelle EIN Block mit zusammen 40 Promille, kein
 * Wert je Monat. Hier steht deshalb der Blockwert, der über die 92 Tage des
 * Blocks verteilt wird — innerhalb des Sommers gibt es keine feinere Aussage,
 * und eine erfundene Monatsaufteilung wäre Genauigkeit, die die Tabelle nicht
 * hergibt.
 *
 * Summe: 170 + 150 + 130 + 80 + 40 + 40 + 30 + 80 + 120 + 160 = 1000.
 */
export const GRADTAGSZAHLEN: { monate: number[]; promille: number }[] = [
  { monate: [1], promille: 170 },
  { monate: [2], promille: 150 },
  { monate: [3], promille: 130 },
  { monate: [4], promille: 80 },
  { monate: [5], promille: 40 },
  { monate: [6, 7, 8], promille: 40 },
  { monate: [9], promille: 30 },
  { monate: [10], promille: 80 },
  { monate: [11], promille: 120 },
  { monate: [12], promille: 160 },
];

/**
 * Wie viele Tage hat ein Monat? Februar im Schaltjahr mit 29 — sonst wäre der
 * 29.02. ein Tag ohne Gradtagszahl.
 */
export function tageImMonat(jahr: number, monat: number): number {
  return new Date(Date.UTC(jahr, monat, 0)).getUTCDate();
}

/**
 * Gradtagszahl eines einzelnen Tages, in Promille.
 *
 * Der Monatswert wird gleichmäßig auf die Tage des Monats verteilt; beim
 * Sommerblock auf die Tage aller drei Monate zusammen.
 */
export function gradtagszahlProTag(jahr: number, monat: number): number {
  const block = GRADTAGSZAHLEN.find(b => b.monate.includes(monat));
  if (!block) return 0;
  const tage = block.monate.reduce((s, m) => s + tageImMonat(jahr, m), 0);
  return tage > 0 ? block.promille / tage : 0;
}

/** Ein ISO-Tag `YYYY-MM-DD` aus einem Datum oder Zeitstempel. */
export function isoTag(wert: string | Date): string {
  if (wert instanceof Date) return wert.toISOString().slice(0, 10);
  return String(wert).slice(0, 10);
}

/**
 * Summe der Gradtagszahlen zwischen zwei Tagen, beide eingeschlossen.
 *
 * Tagweise statt über Monatsgrenzen gerechnet: Ein Mietbeginn am 15. eines
 * Monats soll nicht den halben Monat geschenkt bekommen und auch nicht den
 * ganzen tragen.
 */
export function gradtagsSumme(vonTag: string, bisTag: string): number {
  if (vonTag > bisTag) return 0;
  let summe = 0;
  const von = new Date(`${vonTag}T00:00:00Z`);
  const bis = new Date(`${bisTag}T00:00:00Z`);
  for (let d = new Date(von); d <= bis; d.setUTCDate(d.getUTCDate() + 1)) {
    summe += gradtagszahlProTag(d.getUTCFullYear(), d.getUTCMonth() + 1);
  }
  return summe;
}

/** Tage zwischen zwei ISO-Tagen, beide eingeschlossen. */
export function tageZwischen(vonTag: string, bisTag: string): number {
  if (vonTag > bisTag) return 0;
  const von = new Date(`${vonTag}T00:00:00Z`).getTime();
  const bis = new Date(`${bisTag}T00:00:00Z`).getTime();
  return Math.round((bis - von) / 86400000) + 1;
}

/**
 * Der Abschnitt eines Mietverhältnisses innerhalb des Abrechnungszeitraums.
 * Liegt es ganz außerhalb, ist das Ergebnis null.
 */
export function nutzungsAbschnitt(
  lease: LeaseRow, periodStart: string, periodEnd: string,
): { von: string; bis: string } | null {
  const von = isoTag(lease.start_date) > periodStart ? isoTag(lease.start_date) : periodStart;
  const leaseEnde = lease.end_date ? isoTag(lease.end_date) : periodEnd;
  const bis = leaseEnde < periodEnd ? leaseEnde : periodEnd;
  return von > bis ? null : { von, bis };
}

/**
 * Wie weit darf eine Ablesung vom Einzugstag entfernt sein, um noch als
 * Zwischenablesung zu gelten?
 *
 * Drei Tage. Großzügiger wäre im Januar ein spürbarer Unterschied — die
 * Tabelle gibt für einen Januartag 5,5 Promille des Jahresbedarfs her. Wer
 * weiter entfernt liest, bekommt die Aufteilung nach § 9b Abs. 3, und die ist
 * der gesetzlich vorgesehene Weg, kein Notbehelf.
 */
export const EINZUGSSTAND_TOLERANZ_TAGE = 3;

/**
 * Eine Ablesung nahe am Einzugstag — die Zwischenablesung nach § 9b Abs. 1.
 *
 * Gibt es mehrere, gewinnt die dem Einzugstag nächste.
 */
export function findeEinzugsstand(
  meterId: number,
  einzugsTag: string,
  readings: MeterReadingRow[],
  toleranzTage = EINZUGSSTAND_TOLERANZ_TAGE,
): { tag: string; wert: number } | null {
  let beste: { tag: string; wert: number; abstand: number } | null = null;
  for (const r of readings) {
    if (r.meter_id !== meterId) continue;
    const tag = isoTag(r.read_at as any);
    const abstand = Math.abs(
      Math.round((new Date(`${tag}T00:00:00Z`).getTime()
        - new Date(`${einzugsTag}T00:00:00Z`).getTime()) / 86400000));
    if (abstand > toleranzTage) continue;
    if (!beste || abstand < beste.abstand) {
      beste = { tag, wert: parseFloat(String(r.value)), abstand };
    }
  }
  return beste ? { tag: beste.tag, wert: beste.wert } : null;
}

export type Grundlage =
  /** Voller Zeitraum — das Mietverhältnis lief durchgehend. */
  | 'voller_zeitraum'
  /** Gemessen: Es gibt eine Ablesung zum Einzug (§ 9b Abs. 1 und 2). */
  | 'zwischenablesung'
  /** Aufgeteilt nach Gradtagszahlen (§ 9b Abs. 3, Wärme). */
  | 'gradtagszahlen'
  /** Aufgeteilt nach Zeitabschnitten (§ 9b Abs. 3, Warmwasser und Wasser). */
  | 'zeitanteil'
  /**
   * Stützpunktverfahren: Zwischen den vorhandenen Ablesungen wird GEMESSEN;
   * aufgeteilt wird nur die Lücke, in die der Nutzerwechsel fällt.
   */
  | 'stuetzpunkte';

export interface NutzerAnteil {
  /** Anteil des Nutzers am Verbrauch des Zeitraums, 0 bis 1. */
  anteil: number;
  grundlage: Grundlage;
  /** Erster und letzter Tag der Nutzung im Zeitraum. */
  von: string;
  bis: string;
  /** Bei `zwischenablesung`: der abgelesene Stand und sein Tag. */
  ablesung?: { tag: string; wert: number };
  /**
   * Beim Stützpunktverfahren: der Tag der ersten echten Ablesung nach dem
   * Einzug und wie viel des Nutzerverbrauchs nur aufgeteilt ist.
   */
  stuetzpunkt?: string | null;
  /** Anteil des aufgeteilten Lückenteils am Nutzerverbrauch, 0 bis 1. */
  lueckenAnteil?: number;
}

/** Ein Zählerstand als Stützpunkt: Tag und Wert. */
export interface Stuetzpunkt { tag: string; wert: number }

/** Wie ein Zeitabschnitt gewichtet wird: nach Gradtagszahlen oder nach Tagen. */
export type Gewichtung = 'gradtage' | 'tage';

function gewicht(art: Gewichtung, von: string, bis: string): number {
  return art === 'gradtage' ? gradtagsSumme(von, bis) : tageZwischen(von, bis);
}

/**
 * Die Stützpunkte eines Zählers im Zeitraum: Ablesungen, chronologisch,
 * auf den Zeitraum beschnitten und je Tag nur einmal.
 *
 * Der Anfangsstand (letzte Ablesung am oder vor dem Periodenbeginn) wird auf
 * den Periodenbeginn gesetzt — er ist der Startpunkt der Rechnung, gleich an
 * welchem Tag er abgelesen wurde.
 */
export function stuetzpunkteVon(
  meterId: number, readings: MeterReadingRow[], periodStart: string, periodEnd: string,
  anfangswert?: number | null,
): Stuetzpunkt[] {
  const eigene = readings
    .filter(r => r.meter_id === meterId)
    .map(r => ({ tag: isoTag(r.read_at as any), wert: parseFloat(String(r.value)) }))
    .filter(r => isFinite(r.wert))
    .sort((a, b) => a.tag.localeCompare(b.tag));

  const vorher = eigene.filter(r => r.tag <= periodStart).pop();
  const drin = eigene.filter(r => r.tag > periodStart && r.tag <= periodEnd);

  const punkte: Stuetzpunkt[] = [];
  /* Ohne Ablesung zum Periodenbeginn zählt der beim Einbau hinterlegte
     Anfangswert als erster Stützpunkt. Ohne ihn begänne die Reihe erst bei
     der ersten echten Ablesung — der Nenner wäre dann kleiner als der
     Jahresverbrauch, und der Nutzer bekäme einen Anteil von 100 Prozent
     ausgewiesen, obwohl er erst später eingezogen ist. */
  if (vorher) punkte.push({ tag: periodStart, wert: vorher.wert });
  else if (anfangswert !== null && anfangswert !== undefined && isFinite(anfangswert)) {
    punkte.push({ tag: periodStart, wert: anfangswert });
  }
  for (const r of drin) {
    // Mehrere Ablesungen am selben Tag: die letzte gewinnt.
    if (punkte.length > 0 && punkte[punkte.length - 1].tag === r.tag) punkte.pop();
    punkte.push(r);
  }
  return punkte;
}

/**
 * Verbrauch eines Zählers innerhalb eines Abschnitts — gemessen, wo gemessen
 * wurde, und nur innerhalb einer Lücke gewichtet aufgeteilt.
 *
 * DAS IST DER KERN DER NACHSCHÄRFUNG (11.10.2026). Bis dahin wurde der GANZE
 * Jahresverbrauch nach Gradtagszahlen bzw. Zeit aufgeteilt, obwohl ab Mai
 * echte Monatsablesungen vorliegen. Das verschenkte die Messung: Beim
 * Kaltwasser der Wohnung im 3. OG lief vor dem Einzug praktisch nichts, der
 * Zeitanteil kürzte den gemessenen Verbrauch trotzdem um ein Drittel.
 *
 * Richtig ist: Zwischen zwei Ablesungen ist der Verbrauch bekannt. Fällt der
 * Nutzerwechsel in ein solches Intervall, wird NUR dieses Intervall geteilt —
 * bei Wärme nach Gradtagszahlen, bei Wasser und Warmwasser nach Tagen. Alles
 * davor und danach ist gemessen.
 *
 * Ein Zählerwechsel oder Rücksetzer erzeugt eine negative Differenz; sie wird
 * als null gewertet, statt den Verbrauch kleinzurechnen.
 */
export function verbrauchImAbschnitt(
  punkte: Stuetzpunkt[], von: string, bis: string, art: Gewichtung,
): number {
  if (punkte.length < 2 || von > bis) return 0;
  let summe = 0;
  for (let i = 1; i < punkte.length; i++) {
    const a = punkte[i - 1];
    const b = punkte[i];
    const delta = b.wert - a.wert;
    if (delta <= 0) continue;

    /* Das Intervall reicht von a.tag (ausschließlich) bis b.tag
       (einschließlich): Der Verbrauch des Tages a ist bereits im Stand a
       enthalten. Deshalb beginnt die Gewichtung am Folgetag von a. */
    const intervallVon = tagPlus(a.tag, 1);
    const intervallBis = b.tag;
    if (intervallVon > intervallBis) continue;

    const schnittVon = intervallVon > von ? intervallVon : von;
    const schnittBis = intervallBis < bis ? intervallBis : bis;
    if (schnittVon > schnittBis) continue;

    const ganz = gewicht(art, intervallVon, intervallBis);
    const teil = gewicht(art, schnittVon, schnittBis);
    summe += ganz > 0 ? delta * (teil / ganz) : 0;
  }
  return summe;
}

/** Einen ISO-Tag um n Tage verschieben. */
export function tagPlus(tag: string, n: number): string {
  const d = new Date(`${tag}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Anteil des Nutzers nach dem Stützpunktverfahren.
 *
 * `null`, wenn es keine zwei Stützpunkte gibt — dann bleibt nur die
 * Ganzjahresaufteilung.
 */
export function anteilAusStuetzpunkten(
  serien: Stuetzpunkt[][], von: string, bis: string,
  periodStart: string, periodEnd: string, art: Gewichtung,
): { anteil: number; stuetzpunkt: string | null; lueckenAnteil: number } | null {
  /* Mehrere Zähler je Wohnung werden nicht zu einer Reihe verschmolzen — ihre
     Ablesetage fallen auseinander. Gerechnet wird je Zähler, summiert werden
     die absoluten Mengen. Das Ergebnis ist dasselbe, der Weg dorthin ehrlicher. */
  const brauchbar = serien.filter(s => s.length >= 2);
  if (brauchbar.length === 0) return null;

  let gesamt = 0; let nutzer = 0; let luecke = 0;
  let stuetzpunkt: string | null = null;

  for (const punkte of brauchbar) {
    gesamt += verbrauchImAbschnitt(punkte, tagPlus(periodStart, 1), periodEnd, art);
    nutzer += verbrauchImAbschnitt(punkte, von, bis, art);

    /* Der Stützpunkt, an dem die Messung für den Nutzer beginnt: die erste
       Ablesung am oder nach seinem ersten Tag. Liegt sie genau auf dem ersten
       Tag, ist gar nichts aufzuteilen. */
    const ersterDanach = punkte.find(p => p.tag >= von) || null;
    if (ersterDanach && ersterDanach.tag > von) {
      luecke += verbrauchImAbschnitt(punkte, von, ersterDanach.tag, art);
      // Für die Kennzeichnung der späteste der Stützpunkte: Bis dahin ist geteilt.
      if (!stuetzpunkt || ersterDanach.tag > stuetzpunkt) stuetzpunkt = ersterDanach.tag;
    }
  }

  if (gesamt <= 0) return null;

  return {
    anteil: Math.min(1, nutzer / gesamt),
    stuetzpunkt,
    /* Wie viel des Nutzerverbrauchs stammt aus der geteilten Lücke? Diese Zahl
       steht in der Kennzeichnung — sie sagt, wie weit die Abrechnung auf einer
       Aufteilung und nicht auf einer Messung beruht. */
    lueckenAnteil: nutzer > 0 ? Math.min(1, luecke / nutzer) : 0,
  };
}

/**
 * Anteil des Nutzers am Wärmeverbrauch seiner Wohnung.
 *
 * Reihenfolge nach § 9b: Zwischenablesung zuerst, sonst Gradtagszahlen.
 *
 * `zaehlerstandEnde` und `zaehlerstandAnfang` beschreiben den Zählerlauf im
 * GESAMTEN Zeitraum. Liegt eine Zwischenablesung vor, ergibt sich der Anteil
 * aus den Ständen selbst und nicht aus einer Tabelle.
 */
export function nutzerAnteilWaerme(opts: {
  lease: LeaseRow;
  periodStart: string;
  periodEnd: string;
  einzugsstand?: { tag: string; wert: number } | null;
  standAnfang?: number | null;
  standEnde?: number | null;
  /** Die Ablesereihen der Zähler dieser Wohnung, für das Stützpunktverfahren. */
  punkte?: Stuetzpunkt[][];
}): NutzerAnteil | null {
  const abschnitt = nutzungsAbschnitt(opts.lease, opts.periodStart, opts.periodEnd);
  if (!abschnitt) return null;

  const vollerZeitraum = abschnitt.von === opts.periodStart && abschnitt.bis === opts.periodEnd;
  if (vollerZeitraum) {
    return { anteil: 1, grundlage: 'voller_zeitraum', ...abschnitt };
  }

  const gemessen = anteilAusAblesung(opts);
  if (gemessen) return { ...gemessen, ...abschnitt };

  /* Stützpunktverfahren vor der Ganzjahresaufteilung: Liegen Ablesungen im
     Jahr, ist zwischen ihnen gemessen — aufzuteilen bleibt nur die Lücke,
     in die der Wechsel fällt. */
  const ueberStuetzpunkte = opts.punkte
    ? anteilAusStuetzpunkten(
      opts.punkte, abschnitt.von, abschnitt.bis, opts.periodStart, opts.periodEnd, 'gradtage')
    : null;
  if (ueberStuetzpunkte) {
    return { ...ueberStuetzpunkte, grundlage: 'stuetzpunkte', ...abschnitt };
  }

  const nenner = gradtagsSumme(opts.periodStart, opts.periodEnd);
  const zaehler = gradtagsSumme(abschnitt.von, abschnitt.bis);
  return {
    anteil: nenner > 0 ? zaehler / nenner : 0,
    grundlage: 'gradtagszahlen',
    ...abschnitt,
  };
}

/**
 * Anteil des Nutzers nach Zeitabschnitten — für Warmwasser, Wasser und die
 * Grundkosten. Auch hier hat eine Zwischenablesung Vorrang.
 */
export function nutzerAnteilZeit(opts: {
  lease: LeaseRow;
  periodStart: string;
  periodEnd: string;
  einzugsstand?: { tag: string; wert: number } | null;
  standAnfang?: number | null;
  standEnde?: number | null;
  /** Die Ablesereihen der Zähler dieser Wohnung, für das Stützpunktverfahren. */
  punkte?: Stuetzpunkt[][];
}): NutzerAnteil | null {
  const abschnitt = nutzungsAbschnitt(opts.lease, opts.periodStart, opts.periodEnd);
  if (!abschnitt) return null;

  const vollerZeitraum = abschnitt.von === opts.periodStart && abschnitt.bis === opts.periodEnd;
  if (vollerZeitraum) {
    return { anteil: 1, grundlage: 'voller_zeitraum', ...abschnitt };
  }

  const gemessen = anteilAusAblesung(opts);
  if (gemessen) return { ...gemessen, ...abschnitt };

  const ueberStuetzpunkte = opts.punkte
    ? anteilAusStuetzpunkten(
      opts.punkte, abschnitt.von, abschnitt.bis, opts.periodStart, opts.periodEnd, 'tage')
    : null;
  if (ueberStuetzpunkte) {
    return { ...ueberStuetzpunkte, grundlage: 'stuetzpunkte', ...abschnitt };
  }

  const nenner = tageZwischen(opts.periodStart, opts.periodEnd);
  const zaehler = tageZwischen(abschnitt.von, abschnitt.bis);
  return {
    anteil: nenner > 0 ? zaehler / nenner : 0,
    grundlage: 'zeitanteil',
    ...abschnitt,
  };
}

/**
 * Anteil aus einer Zwischenablesung, wenn sie taugt.
 *
 * Verlangt werden drei Werte: der Stand zum Einzug, der Anfangsstand des
 * Zeitraums und der Endstand. Fehlt einer, oder ist der Zählerlauf null, gibt
 * es keinen messbaren Anteil — dann greift die Aufteilung.
 */
function anteilAusAblesung(opts: {
  einzugsstand?: { tag: string; wert: number } | null;
  standAnfang?: number | null;
  standEnde?: number | null;
}): { anteil: number; grundlage: Grundlage; ablesung: { tag: string; wert: number } } | null {
  const e = opts.einzugsstand;
  if (!e) return null;
  if (opts.standAnfang === null || opts.standAnfang === undefined) return null;
  if (opts.standEnde === null || opts.standEnde === undefined) return null;

  const gesamt = opts.standEnde - opts.standAnfang;
  if (gesamt <= 0) return null;

  const nutzer = opts.standEnde - e.wert;
  if (nutzer < 0) return null;

  return {
    anteil: Math.min(1, nutzer / gesamt),
    grundlage: 'zwischenablesung',
    ablesung: e,
  };
}

/** Klartext für Ansicht, Eingabeblatt und Befunde. */
export function grundlageKlartext(g: Grundlage): string {
  switch (g) {
    case 'voller_zeitraum': return 'ganzer Abrechnungszeitraum';
    case 'zwischenablesung': return 'Zwischenablesung zum Einzug';
    case 'gradtagszahlen': return '§ 9b-Aufteilung nach Gradtagszahlen, Zwischenablesung fehlt';
    case 'zeitanteil': return '§ 9b-Aufteilung nach Zeitabschnitten, Zwischenablesung fehlt';
    case 'stuetzpunkte': return 'gemessen zwischen den Ablesungen, nur die Lücke aufgeteilt';
  }
}
