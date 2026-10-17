/**
 * mail/inventar — Kopfdaten eines Postfachs einsammeln und einordnen.
 *
 * Gebaut fuer die Yahoo-Durchsicht (Auftrag 17.10.2026). Die Einordnung
 * arbeitet ausschliesslich auf Kopfdaten: Betreff, Absenderadresse,
 * Absendername. Kein Mailtext, keine Anhaenge — das haelt den Lauf schnell
 * und die Funktionen pruefbar.
 *
 * Alles hier ist rein lesend. Es gibt in dieser Datei keine Funktion, die
 * etwas im Postfach veraendert, markiert oder verschiebt.
 */

/** Ein Register. `newsletter` wird nur gezaehlt, nicht ausgewertet. */
export type Register =
  | 'rechnungen' | 'vertraege' | 'abos' | 'behoerden' | 'mahnungen'
  | 'versicherungen' | 'assets' | 'stadtwerke' | 'banken';

/** Warum eine Nachricht aus allen Registern herausfaellt. */
export type Ausschluss = 'gesundheit' | 'newsletter' | null;

export interface KopfDaten {
  ordner: string;
  uid: number;
  /** ISO-Zeitpunkt oder leer, wenn der Umschlag kein Datum trug. */
  datum: string;
  adresse: string;
  name: string;
  betreff: string;
  /** Erst nach dem zweiten Durchgang gesetzt; nur fuer Registertreffer. */
  anhaenge?: string[];
}

/**
 * Gesundheitsbezug. Bewusst eng gefasst: Es geht darum, solche Post aus den
 * Registern herauszuhalten, nicht darum, sie zu erschliessen. Treffer werden
 * gezaehlt und nicht aufgelistet.
 */
const GESUNDHEIT =
  /\b(arzt|ärzt|aerzt|zahnarzt|praxis|klinik|apotheke|rezept|befund|labor|diagnose|therapie|physio|reha|operation|krankenkasse|krankenversicherung|aok|barmer|techniker krankenkasse|dak|ikk|mrt|blutbild|impf|patient)/i;

/** Rundschreiben und Werbung. Zaehlen genuegt. */
const NEWSLETTER =
  /\b(newsletter|rundbrief|briefing|magazin|angebote der woche|gewinnspiel|rabatt|sale|black friday|adventskalender|jetzt sparen|unsubscribe|abmelden)\b/i;
const NEWSLETTER_ABSENDER =
  /(^|[.@])(newsletter|news|enews|mailing|marketing|werbung|info\.|nl\.|email\.|mail\.|e\.)|newsletters?\./i;

/**
 * Register je Merkmal. Reihenfolge ist ohne Belang: Eine Nachricht darf in
 * mehreren Registern stehen — eine Mahnung zu einer Rechnung ist beides.
 */
const MUSTER: Array<[Register, RegExp]> = [
  ['rechnungen', /\b(rechnung|rechnungen|invoice|gutschrift|zahlungsavis|faktura|quittung|zahlungsbest(ä|ae)tigung|beleg(\s?nr)?|abrechnung|jahresabrechnung|zahlungseingang)\b/i],
  ['vertraege', /\b(vertrag|vertr(ä|ae)ge|k(ü|ue)ndigung|nachtrag|auftragsbest(ä|ae)tigung|angebot|auftrag|dienstleistungsvertrag|mietvertrag|addendum|vertragsbest(ä|ae)tigung|vollmacht)\b/i],
  ['abos', /\b(abo|abonnement|subscription|verl(ä|ae)ngerung|lizenz|licen[cs]e|renewal|mitgliedschaft|beitrag(srechnung)?|jahresbeitrag|monatlich)\b/i],
  /* Ohne die schwachen Einzelwoerter "Gemeinde" und "Zoll": sie stehen in
     Nachrichtenbriefen und Netzwerkpost, ohne eine Behoerdensache zu sein. */
  ['behoerden', /\b(bescheid|finanzamt|hauptzollamt|landratsamt|stadtverwaltung|gemeindeverwaltung|steuerbescheid|grundsteuer|zollamt|amtsgericht|notar(in)?|gewerbeamt|kassenzeichen|aktenzeichen|bauamt|baugenehmigung|ordnungsamt|beh(ö|oe)rde)\b/i],
  ['mahnungen', /\b(mahnung|zahlungserinnerung|inkasso|vollstreckung|(ü|ue)berf(ä|ae)llig|zahlungsverzug|letzte mahnung|mahnbescheid)\b/i],
  ['versicherungen', /\b(versicherung|versicherungsschein|police|beitragsrechnung|schadenmeldung|schadennummer|vsnr|versicherungsnummer|haftpflicht|kasko|geb(ä|ae)udeversicherung)\b/i],
  ['assets', /\b(fahrzeug|zulassung|leasing|werkstatt|yacht|boot|liegeplatz|t(ü|ue)v|hu\/au|kfz|reifen|marina|panamera|cranchi|porsche|tesla|anh(ä|ae)nger|wohnmobil|solaranlage|photovoltaik|pv-anlage|w(ä|ae)rmepumpe)\b/i],
];

/** Stadtwerke Tuttlingen. Ueber die Absenderdomaene, nicht ueber Schlagworte. */
const SWT_ABSENDER = /@(swtenergie\.de|stadtwerke-tuttlingen\.de)$/i;
const SWT_BETREFF = /\b(stadtwerke|swt)\b/i;

/**
 * Banken, Versicherer und Vorsorgetraeger. Nur die Hausbanken, Versicherer
 * und Depotstellen des Owners; Zahlungsdienste und Haendlerpost gehoeren
 * nicht hierher, sonst steht das Register voll mit Bestellbestaetigungen.
 */
const BANKEN_ABSENDER =
  /@([a-z0-9.-]*\.)?(ksk-tut\.de|volksbank[a-z-]*\.de|vr-?bank[a-z-]*\.de|vrbank[a-z-]*\.de|dzprivatbank\.com|standardlife\.de|gothaer\.(de|info)|allianz\.de|alte-leipziger\.de|ruv\.de|r\+v\.de|helvetia\.(de|ch)|pantaenius\.(de|com)|vohrer\.de|revolut\.com|interactivebrokers\.(com|co\.uk)|nbc\.ca|credem\.it|comdirect\.de|swisslife\.de|nuernberger\.de|debeka\.de|ergo\.de|axa\.de|hdi\.de)$/i;
/**
 * Versicherer und Vorsorgetraeger als Absender. Die Portalpost dieser Haeuser
 * nennt im Betreff nie das Wort "Versicherung" ("Sie haben Post"), gehoert
 * aber sachlich ins Versicherungsregister.
 */
const VERSICHERER_ABSENDER =
  /@([a-z0-9.-]*\.)?(gothaer\.(de|info)|allianz\.de|alte-leipziger\.de|standardlife\.de|ruv\.de|helvetia\.(de|ch)|pantaenius\.(de|com)|vohrer\.de|swisslife\.de|nuernberger\.de|debeka\.de|ergo\.de|axa\.de|hdi\.de|hellohakuna\.com)$/i;

/** Netzwerk- und Vereinspost nennt Institute, ohne von ihnen zu kommen. */
const FREMDE_NENNUNG =
  /@([a-z0-9.-]*\.)?(linkedin\.com|facebookmail\.com|xing\.com|web\.de|gmx\.(de|net)|twitter\.com|instagram\.com)$/i;

const BANKEN_BETREFF =
  /\b(standard ?life|gothaer|allianz|alte ?leipziger|kreissparkasse|sparkasse|volksbank|dz ?privatbank|r\+v|helvetia|pantaenius|vohrer|revolut|interactive ?brokers|depot|wertpapier|rentenversicherung|lebensversicherung|vorsorge|verm(ö|oe)gens(ü|ue)bersicht|kontoauszug|darlehen|annuit(ä|ae)t)\b/i;

/** Ein Vertrags- oder Versicherungsschein darf nicht im Klartext stehen. */
export function nummerGekuerzt(text: string): string {
  /* Erfasst auch Kennungen mit Buchstaben davor, etwa eine IBAN. */
  return text.replace(/\b[A-Z]{0,2}[0-9][0-9A-Z./-]{5,}\b/gi, (t) => {
    const ziffern = t.replace(/\D/g, '');
    return ziffern.length <= 4 ? t : `…${ziffern.slice(-4)}`;
  });
}

/** Rundschreiben, Gesundheitspost — oder nichts davon. */
export function ausschluss(k: Pick<KopfDaten, 'betreff' | 'adresse' | 'name'>): Ausschluss {
  const feld = `${k.betreff} ${k.adresse} ${k.name}`;
  if (GESUNDHEIT.test(feld)) return 'gesundheit';
  if (NEWSLETTER.test(k.betreff) || NEWSLETTER_ABSENDER.test(k.adresse)) return 'newsletter';
  return null;
}

/**
 * Register einer Nachricht. Leeres Feld heisst: in keinem Register —
 * entweder ausgeschlossen oder ohne Vertrags- und Kostenbezug.
 */
export function kategorisiere(k: Pick<KopfDaten, 'betreff' | 'adresse' | 'name'>): Register[] {
  if (ausschluss(k)) return [];
  const treffer = new Set<Register>();
  const feld = `${k.betreff} ${k.adresse} ${k.name}`;
  const fremd = FREMDE_NENNUNG.test(k.adresse);
  for (const [reg, re] of MUSTER) {
    /* Netzwerk- und Vereinspost nennt Aemter, ohne von einem zu kommen. */
    if (reg === 'behoerden' && fremd) continue;
    if (re.test(feld)) treffer.add(reg);
  }
  if (VERSICHERER_ABSENDER.test(k.adresse)) treffer.add('versicherungen');
  if (SWT_ABSENDER.test(k.adresse) || SWT_BETREFF.test(k.betreff)) treffer.add('stadtwerke');
  const bankBetreff = BANKEN_BETREFF.test(feld) && !FREMDE_NENNUNG.test(k.adresse);
  if (BANKEN_ABSENDER.test(k.adresse) || bankBetreff) treffer.add('banken');
  return [...treffer];
}

export interface SwtRechnung {
  kunde: string;
  rechnungseinheit: string;
  rechnungsnummer: string;
  datum: string;
  betrag: number | null;
}

/**
 * Die Rechnungsangaben der Stadtwerke stehen im Mailtext, nicht im Betreff:
 * "Kundennummer-Rechnungseinheit | ARV-JJJJ-NNNNN | TT.MM.JJJJ | 1.234,56 €".
 * Vorzeichen und Tausenderpunkte kommen vor, deshalb die eigene Zahlenlesung.
 */
export function swtRechnungenAusText(text: string): SwtRechnung[] {
  const treffer: SwtRechnung[] = [];
  const re =
    /(\d{4,7})\s*-\s*(\d{4,7})[^\n]{0,80}?(ARV-\d{4}-\d{1,6})[^\n]{0,80}?(\d{2}\.\d{2}\.\d{4})(?:[^\n]{0,40}?(-?\s?[\d.]+,\d{2}))?/gi;
  for (const m of text.matchAll(re)) {
    treffer.push({
      kunde: m[1],
      rechnungseinheit: m[2],
      rechnungsnummer: m[3].toUpperCase(),
      datum: m[4],
      betrag: m[5] ? betragLesen(m[5]) : null,
    });
  }
  return treffer;
}

/** "1.234,56" und "-  73,33" zu Zahl. Null, wenn nichts Lesbares drinsteht. */
export function betragLesen(text: string): number | null {
  const roh = text.replace(/\s/g, '');
  if (!/^-?[\d.]*,\d{2}$/.test(roh)) return null;
  const wert = Number(roh.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(wert) ? wert : null;
}

/** Zählernummer aus "Zählerstandsmeldung für 10707956". */
export function zaehlernummer(betreff: string): string | null {
  const m = betreff.match(/Z(?:ä|ae)hlerstand(?:s)?(?:meldung)?[^0-9]{0,20}(\d{6,12})/i);
  return m ? m[1] : null;
}

/**
 * Anhangsnamen aus der bodyStructure eines IMAP-Umschlags. Die Struktur ist
 * ein Baum; Anhaenge haengen an beliebiger Tiefe.
 */
export function anhangsnamen(struktur: unknown): string[] {
  const raus: string[] = [];
  const lauf = (knoten: any): void => {
    if (!knoten || typeof knoten !== 'object') return;
    const p = knoten.dispositionParameters ?? {};
    const name = p.filename ?? knoten.parameters?.name;
    if (name && (knoten.disposition === 'attachment' || knoten.parameters?.name)) raus.push(String(name));
    for (const kind of knoten.childNodes ?? []) lauf(kind);
  };
  lauf(struktur);
  return raus;
}
