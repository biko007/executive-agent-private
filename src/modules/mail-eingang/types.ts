/**
 * mail-eingang/types — die Begriffe des Eingangskanals.
 *
 * Eigene Datei, damit `index.ts` (Entscheidungen) und `graph.ts` (Postfach)
 * dieselben Typen teilen, ohne sich gegenseitig zu importieren.
 */

/** Genau zwei Zustaende — mehr gibt es nicht (Owner-Entscheidung 18.10.2026). */
export type Lage = 'ablage' | 'auftrag';

export interface Konfiguration {
  /** Adresse, die den Eingang ausmacht — inklusive Plus-Teil. */
  zieladresse: string;
  /**
   * Absenderadressen des Owners. Ein Eintrag mit fuehrendem @ gilt fuer die
   * ganze Domain (Apple-Relay und Proton wechseln die lokale Kennung).
   */
  ownerAbsender: string[];
  /** Obergrenze je Mail samt Anhaengen. Darueber nur melden, nicht ablegen. */
  maxBytes: number;
}

export interface EingangsAnhang {
  name: string;
  bytes: Buffer;
  contentType?: string;
}

export interface EingangsMail {
  /** Graph-id der Nachricht — nur fuer Abrufe, nicht als Merkmal. */
  id: string;
  /** Message-ID des Absenders; sie merkt sich das Modul. */
  messageId: string;
  empfangenIso: string;
  absender: string;
  to: string[];
  cc: string[];
  betreff: string;
  /** Textkoerper, moeglichst als reiner Text. */
  text: string;
  hatAnhaenge: boolean;
}

/** Was das Postfach koennen muss. Als Schnittstelle, damit es pruefbar ist. */
export interface PostfachZugang {
  /** Nachrichten seit diesem Zeitpunkt, juengste zuerst. */
  neueMails(seitIso: string): Promise<EingangsMail[]>;
  /** Rohnachricht als MIME (.eml). */
  mime(id: string): Promise<string>;
  anhaenge(id: string): Promise<EingangsAnhang[]>;
  /**
   * In den Ordner Posteingang/bikosoc verschieben. Fehlt Mail.ReadWrite,
   * liefert die Umsetzung 'nicht_moeglich' — nachbeantragt wird nichts.
   */
  einsortieren(id: string): Promise<'verschoben' | 'nicht_moeglich'>;
}

export interface MailEingangZeile {
  lage: Lage | 'fehler';
  empfangenIso: string;
  betreff: string;
  absender: string;
  fremderAbsender: boolean;
  anhaenge: string[];
  ablagePfad: string;
  auftragsDatei?: string;
  einsortiert: 'verschoben' | 'nicht_moeglich' | 'uebersprungen';
  hinweis?: string;
}

export interface MailEingangLauf {
  gesehen: number;
  verarbeitet: MailEingangZeile[];
  uebersprungen: number;
}

export interface Vermerk {
  version: 1;
  /** Message-IDs, juengste zuletzt. */
  ids: string[];
  /**
   * Message-ID → vergebener Ablageordner.
   *
   * Zwei Mails derselben Minute mit demselben Betreff-Slug — etwa „Rechnung"
   * und „Auftrag: Rechnung" — ergaeben denselben Ordnernamen und wuerden sich
   * gegenseitig ueberschreiben. Die Vergabe wird deshalb vermerkt: Dieselbe
   * Mail bekommt wieder ihren Ordner, eine andere einen mit Zusatz.
   */
  ordner?: Record<string, string>;
  letzterLauf?: string;
}
