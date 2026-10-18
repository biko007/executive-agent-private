/**
 * reise-import/types — das Austauschformat einer Reise.
 *
 * Schema `bikosoc.reise/1`. Der Reiseassistent legt eine solche Datei in
 * Dropbox ab, der Import spiegelt sie in die Reisedatei des Dashboards.
 *
 * Grundsatz: **Pflicht ist, was eine Reise ausmacht** — Kennung, Titel,
 * Zeitraum. Alles andere ist freiwillig und wird nur angezeigt, wenn es da
 * ist. So kann der Assistent mit wenigen Zeilen anfangen und spaeter
 * ergaenzen, ohne dass etwas bricht.
 *
 * Keine Pass- und keine Kartennummern. Das Schema sieht dafuer kein Feld vor;
 * der Import weist Felder mit solchen Namen ab.
 */

export const SCHEMA = 'bikosoc.reise/1';

/** Farbton eines Status-Chips im Kopf der Reisekarte. */
export type Ton = 'green' | 'blue' | 'amber' | 'red' | 'muted';

export interface StatusChip {
  text: string;
  ton?: Ton;
}

export interface Buchung {
  /** Buchungscode der Airline, etwa `YV6ZJL`. */
  code?: string;
  ticket?: string;
  anbieter?: string;
  ausgestellt?: string;
  ausgestellt_ueber?: string;
  preis?: number;
  waehrung?: string;
  tarif?: string;
  /** Vielfliegernummer — nur maskiert, etwa „LH …3542". */
  vielflieger?: string;
  status?: string;
  verwalten_url?: string;
  notiz?: string;
}

export interface Flug {
  /** Datum des Abflugs, ISO (JJJJ-MM-TT). */
  datum: string;
  flugnummer: string;
  /** Betreiber bei Codeshare, etwa „Air Canada (AC881)". */
  betrieben_von?: string;
  flugzeug?: string;
  von: string;
  von_terminal?: string;
  ab_ortszeit?: string;
  nach: string;
  nach_terminal?: string;
  an_ortszeit?: string;
  /** Nur setzen, wenn die Ankunft auf einen anderen Tag fällt. */
  an_datum?: string;
  dauer?: string;
  klasse?: string;
  buchungsklasse?: string;
  gepaeck?: string;
  notiz?: string;
}

export interface Umstieg {
  flughafen: string;
  dauer?: string;
  einreise?: string;
  puffer?: string;
  backup?: string;
  notiz?: string;
}

export type DokumentArt =
  | 'eticket' | 'esta' | 'eta' | 'visum' | 'hotel' | 'mietwagen' | 'sonstiges';

export interface Dokument {
  art: DokumentArt;
  titel: string;
  /** Referenz- oder Antragsnummer. Keine Pass- oder Kartennummer. */
  nummer?: string;
  erteilt?: string;
  gueltig_bis?: string;
  status?: string;
  /**
   * Dateiname im Dropbox-Ordner `transfer/reisen/dokumente/`. Liegt die Datei
   * dort, uebernimmt der Import sie ins Dashboard und sie ist mit einem Klick
   * zu oeffnen. Fehlt sie, zeigt die Karte nur die Kerndaten.
   */
  datei?: string;
  /** Hinweis, wo das Original liegt — wird als Text angezeigt. */
  ablage?: string;
  /**
   * Pfad in der Dokumentenablage des Dashboards, relativ zu `DOCS_DIR`. Setzt
   * der Import, nicht der Assistent. Ist er gesetzt, zeigt die Reisekarte den
   * Knopf „PDF öffnen".
   */
  pfad?: string;
  notiz?: string;
}

export interface Frist {
  /** Faellig am, ISO. Zeitangaben gehoeren in `titel` oder `notiz`. */
  faellig: string;
  titel: string;
  status?: 'offen' | 'erledigt';
  notiz?: string;
}

export interface Einreise {
  land: string;
  wo?: string;
  dokument?: string;
  notiz?: string;
}

export interface Kontakt {
  name: string;
  telefon?: string;
  url?: string;
  notiz?: string;
}

export interface MeilenSegment {
  flugnummer: string;
  erwartete_meilen?: number;
  erwartete_punkte?: number;
  gutgeschrieben?: boolean;
  gutschrift_am?: string;
  nachforderung_offen?: boolean;
}

export interface MeilenUpgrade {
  flugnummer: string;
  ziel_klasse: string;
  meilen?: number;
  evoucher?: number;
  warteliste?: string;
}

export interface Meilen {
  programm?: string;
  /** Nur die letzten vier Stellen der Kartennummer. */
  karte_letzte4?: string;
  status?: string;
  status_gueltig_bis?: string;
  praemienmeilen?: number;
  statuspunkte?: number;
  qualifikationspunkte?: number;
  meilen_verfall?: string;
  evoucher?: number;
  /** Woher die Werte stammen: `manuell`, `Kontoauszug 18.10.2026`, `Import`. */
  quelle?: string;
  stand?: string;
  segmente?: MeilenSegment[];
  upgrades?: MeilenUpgrade[];
}

export interface ReiseDatei {
  schema: string;
  id: string;
  titel: string;
  /** Freitext, etwa „Winnipeg, Vancouver, San Francisco, Los Angeles". */
  ziel?: string;
  land?: string;
  von: string;
  bis: string;
  klima?: string;
  zweck?: string[];
  /** Zaehlt bei Aktualisierungen hoch. Gleiche oder kleinere Zahl = kein Ersatz. */
  version?: number;
  chips?: StatusChip[];
  buchungen?: Buchung[];
  fluege?: Flug[];
  umstiege?: Umstieg[];
  dokumente?: Dokument[];
  fristen?: Frist[];
  einreise?: Einreise[];
  kontakte?: Kontakt[];
  meilen?: Meilen;
  /** Was noch offen ist — wird als Liste gezeigt. */
  offen?: string[];
  notiz?: string;
  /** Pfad des lebenden Dokuments in Dropbox. */
  quelle_md?: string;
}

export interface Pruefbefund {
  ok: boolean;
  fehler: string[];
  warnungen: string[];
}
