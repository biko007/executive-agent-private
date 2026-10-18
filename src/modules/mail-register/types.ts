/**
 * mail-register/types — die Begriffe der Sammelstelle.
 *
 * Eigene Datei, damit `index.ts` (Einordnung) und `graph.ts` (Postfach)
 * dieselben Typen teilen, ohne sich gegenseitig zu importieren.
 */
import type { Register, Ausschluss } from '../mail/index.js';

/**
 * Woher eine Nachricht in der Sammelstelle kommt.
 *
 * `proton` heisst: ueber die Weiterleitung von jbickel2@protonmail.com
 * eingetroffen, belegt durch eine Kopfzeile — nicht geraten.
 * `direkt` heisst: unmittelbar an data@bikolino.com adressiert.
 */
export type Herkunft = 'proton' | 'direkt';

export interface RegisterEintrag {
  /** Postfach, aus dem der Eintrag kommt. Derzeit nur `data`. */
  quelle: string;
  herkunft: Herkunft;
  /** Die Kopfzeile, die die Weiterleitung belegt — leer bei `direkt`. */
  beleg?: string;
  /** Proton-Adresse, von der weitergeleitet wurde. */
  weitergeleitetVon?: string;
  /**
   * Proton-Bezug ohne Weiterleitung: Systempost von Proton selbst, etwa die
   * Bestaetigung der Weiterleitung. Sie kommt an data@ und ist trotzdem Teil
   * des Vorgangs.
   */
  protonBezug: boolean;
  ordner: string;
  /** Message-ID des Absenders — das Merkmal, an dem Doppel erkannt werden. */
  messageId: string;
  /** Graph-id; nur fuer Abrufe, nicht als Merkmal. */
  graphId: string;
  /** Wann M365 die Nachricht angenommen hat. */
  empfangenIso: string;
  /** Datum des Originals aus der Kopfzeile `Date` — bei Weiterleitungen wichtig. */
  originalIso: string;
  /** Urspruenglicher Absender; bei Proton-Weiterleitungen bleibt er erhalten. */
  absender: string;
  absenderName: string;
  betreff: string;
  anhaenge: string[];
  /** Register nach der Mechanik aus `mail/inventar`. */
  register: Register[];
  ausschluss: Ausschluss;
  /** Wann dieser Eintrag geschrieben wurde. */
  erfasstIso: string;
}

export interface RegisterStand {
  version: 1;
  eintraege: RegisterEintrag[];
}

/** Was ein Postfach fuer das Register koennen muss. */
export interface MailboxZugang {
  /** Alle Ordner mit Zaehlerstand. */
  ordner(): Promise<Array<{ id: string; name: string; anzahl: number }>>;
  /**
   * Nachrichten eines Ordners samt Kopfzeilen, juengste zuerst.
   * `seitIso` begrenzt auf neue Nachrichten; ohne Angabe alles.
   */
  mails(ordnerId: string, seitIso?: string): Promise<RohMail[]>;
  /** Anhangsnamen einer Nachricht. */
  anhangsnamen(id: string): Promise<string[]>;
  /** In einen Unterordner des Postfachs verschieben; legt ihn bei Bedarf an. */
  verschiebe(id: string, ordnerName: string): Promise<'verschoben' | 'nicht_moeglich'>;
}

export interface RohMail {
  id: string;
  messageId: string;
  empfangenIso: string;
  absender: string;
  absenderName: string;
  betreff: string;
  hatAnhaenge: boolean;
  /** Kopfzeilen in Kleinschreibung als Schluessel. */
  kopf: Record<string, string>;
}
