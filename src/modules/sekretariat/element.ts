/**
 * sekretariat/element — eine Neuheit (Mail oder Dokument), Vorfilter und das
 * zweite, deterministische Netz.
 *
 * Spec v1, „Sicherstellen" 2: Unabhängig von der KI werden Frist + Aufforderung,
 * Betrag + Rechnung/Mahnung, Behördenabsender, Vertrag/Kündigung und
 * Bank/Versicherung erkannt. Nur wenn KI UND Netz „unwichtig" sagen, bleibt es
 * still. Der Vorfilter nimmt nur Offensichtliches heraus — und Gesundheitspost
 * immer, sie geht nie an das Modell.
 */

import { kopfAusschluss, type Regelwerk } from '../mail-register/relevanz.js';
import { ausschluss as inventarAusschluss } from '../mail/index.js';
import { dokAusschluss, type DokRegeln } from '../doc-register/relevanz.js';

export interface Element {
  typ: 'mail' | 'dokument';
  /** m-… oder d-… (wie im Register). */
  kennung: string;
  /** m365 | yahoo | data | sharepoint | onedrive | dropbox | icloud */
  quelle: string;
  datum: string;
  /** Betreff bzw. Dateiname. */
  titel: string;
  /** Absenderadresse bzw. Ordnerpfad. */
  von: string;
  vonName?: string;
  /** Mailtext bis 3.000 Zeichen bzw. PDF-Text Seite 1–2. */
  text: string;
  anhaenge?: string[];
  /** Mail: eigene Message-ID und die Thread-Kopfzeilen. */
  messageId?: string;
  threadIds?: string[];
  /** Mail: Ordner und Kopfzeilen für den Vorfilter. */
  ordner?: string;
  kopf?: Record<string, string>;
  /** Dokument: Pfad. */
  pfad?: string;
  kopie?: boolean;
}

/** Ergebnis des Vorfilters: Grund oder null (= geht zur KI). */
export function vorfilter(e: Element, regeln: Regelwerk, dok: DokRegeln): string | null {
  if (e.typ === 'mail') {
    const grund = kopfAusschluss({
      absender: e.von, absenderName: e.vonName ?? '', betreff: e.titel, ordner: e.ordner ?? '', kopf: e.kopf ?? {},
    }, regeln);
    /* Nur Offensichtliches. Bewerbung, Werbeordner und Vereinspost sind
       Ermessensfragen — die bewertet jetzt die KI (Owner 27.10.2026:
       „Intelligenz statt Stichwörter"). */
    const offensichtlich = new Set(['eigene Mail', 'Gesundheit', 'Newsletter', 'Paketstatus', 'Systemmeldung', 'Social']);
    if (grund && offensichtlich.has(grund)) return grund;
    return gesundheitImText(e) ? 'Gesundheit' : null;
  }
  const aus = dokAusschluss({ name: e.titel, pfad: e.pfad ?? e.von }, dok, e.kopie);
  if (aus) return aus;
  if (inventarAusschluss({ betreff: `${e.pfad ?? ''} ${e.titel}`, adresse: '', name: '' }) === 'gesundheit') return 'Gesundheit';
  return gesundheitImText(e) ? 'Gesundheit' : null;
}

/**
 * Gesundheitspost — nur bei eindeutigem Absender, Betreff oder Anhangnamen
 * (Arztpraxis, Klinik, Krankenkasse/-versicherung, Labor, Apotheke). Der
 * Mailtext allein filtert NICHT mehr: Chat-Review 27.10.2026 — „Befund: 165 kWh
 * Wärme …" in zwei Zähler-Mails von Herrn Bauser galt als Gesundheitspost. Bei
 * Zweifel entscheidet die KI (Owner-Vorgabe), Gesundheitsabsender bleiben
 * über `kopfAusschluss`/Regeldatei draußen.
 */
const GESUNDHEIT_ABSENDER = /@([a-z0-9-]+\.)*(praxis[a-z-]*|arztpraxis[a-z-]*|[a-z-]*klinik[a-z-]*|[a-z-]*klinikum[a-z-]*|krankenhaus[a-z-]*|[a-z-]*labor[a-z-]*|apotheke[a-z-]*|aok|tk|barmer|dak|ikk[a-z-]*|bkk[a-z-]*|debeka|dkv|signal-iduna|hallesche|barmenia|lkh|beihilfe[a-z-]*)\.[a-z.]+$/i;
const GESUNDHEIT_BETREFF = /\b(arztbrief|arztpraxis|praxis dr|dr\. med|zahnarzt|hausarzt|facharzt|klinik|krankenhaus|laborbefund|laborwert|blutbild|krankenkasse|krankenversicherung|pflegekasse|beihilfe|rezept|apotheke|patient(?:in|en)?|arzttermin|impfung)(?![a-zäöüß])/i;
export function gesundheitImText(e: Pick<Element, 'titel'> & { von?: string; anhaenge?: string[] }): boolean {
  return (!!e.von && GESUNDHEIT_ABSENDER.test(e.von))
    || GESUNDHEIT_BETREFF.test(`${e.titel}\n${(e.anhaenge ?? []).join('\n')}`);
}

// ── Zweites Netz ───────────────────────────────────────────────────────────

const DATUM = /\b(\d{1,2}\.\s?\d{1,2}\.\s?(20)?\d{2}|\d{1,2}\.\s?(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)(\s?20\d{2})?|20\d{2}-\d{2}-\d{2})\b/i;
const AUFFORDERUNG = /\b(bis (zum|spätestens|spaetestens)?|spätestens|spaetestens|frist|innerhalb von|bitten wir|fordern|auffordern|aufgefordert|einzureichen|vorzulegen|nachzuweisen|zu zahlen|zu überweisen|zu ueberweisen|zahlbar)\b/i;
const BETRAG = /(\d{1,3}(\.\d{3})*,\d{2}\s?(€|eur\b|euro\b))|((€|eur)\s?\d{1,3}(\.\d{3})*,\d{2})/i;
const RECHNUNG = /\b(rechnung|mahnung|zahlungserinnerung|forderung|offener betrag|gutschrift|abschlag|invoice|receipt)\b/i;
const BEHOERDE_ABSENDER = /@([a-z0-9-]+\.)*(tuttlingen\.de|landkreis-[a-z-]+\.de|lra-?[a-z]*\.de|finanzamt[a-z-]*\.de|[a-z-]+\.bund\.de|bzst\.de|elster\.de|[a-z-]*\.bwl\.de|bw\.de|stadt-[a-z-]+\.de|gemeinde-[a-z-]+\.de|amtsgericht[a-z-]*\.de|justiz\.[a-z-]+\.de|zoll\.de)$/i;
const BEHOERDE_TEXT = /\b(finanzamt|landratsamt|stadtverwaltung|bauamt|bescheid|aktenzeichen|kassenzeichen|steuernummer|ordnungsamt|amtsgericht|grundbuchamt)\b/i;
const VERTRAG = /\b(vertrag|kündigung|kuendigung|gekündigt|kündigen|vertragsende|verlängerung|verlaengerung|laufzeit)\b/i;
const BANK_VERSICHERUNG = /\b(bank|sparkasse|volksbank|kontoauszug|lastschrift|darlehen|kredit|versicherung|police|schadenmeldung|schadennummer|beitragsrechnung)\b/i;

export interface NetzTreffer { grund: string; beleg: string }

/** Deterministische Erkennung — unabhängig von der KI. */
export function zweitesNetz(e: Element, bankVersichererAbsender?: RegExp): NetzTreffer[] {
  const t = `${e.titel}\n${e.text.slice(0, 3000)}`;
  const raus: NetzTreffer[] = [];
  const stelle = (re: RegExp) => (t.match(re)?.[0] ?? '').trim().slice(0, 40);
  if (DATUM.test(t) && AUFFORDERUNG.test(t)) raus.push({ grund: 'Frist/Datum mit Aufforderung', beleg: `${stelle(AUFFORDERUNG)} … ${stelle(DATUM)}` });
  if (BETRAG.test(t) && RECHNUNG.test(t)) raus.push({ grund: 'Betrag mit Rechnung/Mahnung', beleg: `${stelle(RECHNUNG)} … ${stelle(BETRAG)}` });
  if (e.typ === 'mail' && BEHOERDE_ABSENDER.test(e.von)) raus.push({ grund: 'Behördenabsender', beleg: e.von });
  else if (BEHOERDE_TEXT.test(e.titel)) raus.push({ grund: 'Behördenbezug', beleg: stelle(BEHOERDE_TEXT) });
  if (VERTRAG.test(e.titel)) raus.push({ grund: 'Vertrag/Kündigung', beleg: stelle(VERTRAG) });
  if ((e.typ === 'mail' && bankVersichererAbsender?.test(e.von)) || BANK_VERSICHERUNG.test(e.titel)) {
    raus.push({ grund: 'Bank/Versicherung', beleg: e.typ === 'mail' && bankVersichererAbsender?.test(e.von) ? e.von : stelle(BANK_VERSICHERUNG) });
  }
  return raus;
}
