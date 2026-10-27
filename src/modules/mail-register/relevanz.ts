/**
 * mail-register/relevanz — welche Mail ist relevant, und was schlagen wir vor?
 *
 * Owner-Anweisung 27.10.2026, 10:26: „Sowohl juergen.bickel@bikolino.com als
 * auch jbickel2@yahoo.de alle 1h prüfen und direkt Verarbeitung für relevante
 * E-Mails vorschlagen."
 *
 * Reine Regeln, keine KI. Das Regelwerk liegt als editierbare Datei unter
 * `artifacts/personal/mail-register/relevanz.json`; fehlt sie oder ist sie
 * kaputt, gelten die Vorgaben aus diesem Modul. Ein Vorschlag wird nie
 * ausgefuehrt — er wartet auf die Freigabe des Owners.
 *
 * Reihenfolge der Entscheidung:
 *   1. eigene Mail des Owners             → nicht relevant
 *   2. Gesundheitspost                    → nicht relevant (immer)
 *   3. Absender aus den Kontakten         → relevant (schlaegt 4)
 *   4. Newsletter, Paketstatus, System,
 *      Social, Bewerbung, Werbeordner     → nicht relevant
 *   5. Stichwort, Objekt, Antwort auf
 *      eine Mail des Owners               → relevant
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ausschluss as inventarAusschluss } from '../mail/index.js';

// ── Katalog ────────────────────────────────────────────────────────────────

export type VorschlagCode = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'offen';

/** Der feste Katalog aus dem Auftrag vom 27.10.2026. */
export const KATALOG: Record<VorschlagCode, string> = {
  a: 'Beleg ablegen + Buchung',
  b: 'Zählerstände/Fakten in bikosoc einarbeiten',
  c: 'Antwortentwurf anlegen',
  d: 'Frist/Termin anlegen',
  e: 'Reklamation/Widerspruch',
  f: 'nur zur Kenntnis',
  offen: 'Vorschlag offen',
};

// ── Regelwerk ──────────────────────────────────────────────────────────────

export interface Regelwerk {
  version: 1;
  ownerAdressen: string[];
  kontakte: Array<{ name: string; absender: string }>;
  /** Erste passende Zeile bestimmt den Vorschlag — Reihenfolge zaehlt. */
  /**
   * `auchText`: das Stichwort zaehlt auch im Mailtext. Fuer „Bestellung" und
   * „Angebot" nicht — die stehen in jeder Shop- und Werbefusszeile.
   */
  stichworte: Array<{
    muster: string; vorschlag: Exclude<VorschlagCode, 'offen'>; thema: string; auchText?: boolean;
  }>;
  /**
   * `muster` gilt fuer den Betreff, `text` (optional) fuer den Mailtext. Kurze
   * Kuerzel wie D4 oder Z5 nur im Betreff — im Text sind es Produktcodes.
   */
  objekte: Array<{ kuerzel: string; muster: string; text?: string }>;
  ausschluss: {
    gesundheitAbsender: string;
    paketAbsender: string;
    paketAusnahme: string;
    systemAbsender: string;
    systemBetreff: string;
    socialAbsender: string;
    socialOrdner: string;
    werbungOrdner: string;
    werbungBetreff: string;
    bewerbung: string;
  };
}

/** Vorgabe. Wird beim ersten Lauf als relevanz.json geschrieben. */
export const STANDARD_REGELN: Regelwerk = {
  version: 1,
  ownerAdressen: [
    'juergen.bickel@bikolino.com', 'jbickel2@yahoo.de', 'jbickel2@protonmail.com',
    'data@bikolino.com',
  ],
  kontakte: [
    { name: 'Bauser', absender: 'matthias\\.bauser@' },
    { name: 'Hilsenbeck', absender: 'doris\\.hilsenbeck@' },
    { name: 'Maurer', absender: '@maurer-schramberg\\.de$' },
    { name: 'Fiehn', absender: '@fiehn\\.de$' },
    { name: 'energiekonzept', absender: '@(ekonzept\\.eu|energiekonzept[a-z-]*\\.de)$' },
    { name: 'SWT', absender: '@(swtenergie\\.de|stadtwerke-tuttlingen\\.de)$' },
    { name: 'Stadt Tuttlingen', absender: '@tuttlingen\\.de$' },
    { name: 'Landratsamt', absender: '@(landkreis-tuttlingen\\.de|lratut\\.de)$' },
    { name: 'Vohrer', absender: '@vohrer\\.de$' },
    { name: 'EnBW', absender: '@([a-z0-9-]+\\.)?enbw\\.com$' },
    { name: 'NEW', absender: '@([a-z0-9-]+\\.)?new(-energie)?\\.de$' },
    { name: 'Casameta', absender: '@([a-z0-9-]+\\.)?casameta\\.(de|com)$' },
    { name: 'ista', absender: '@([a-z0-9-]+\\.)?ista\\.(de|com)$' },
    { name: 'Bank', absender: '@([a-z0-9-]+\\.)?(ksk-tut\\.de|vbsdn\\.de|volksbank[a-z-]*\\.de|vr-?bank[a-z-]*\\.de|dzprivatbank\\.com|comdirect\\.de|revolut\\.com|bnc\\.ca|nbc\\.ca|credem\\.it|interactivebrokers\\.(com|co\\.uk))$' },
    { name: 'UBS', absender: '@([a-z0-9-]+\\.)?ubs\\.com$' },
    { name: 'Steuerberater', absender: '@kanzlei-heni\\.de$' },
    { name: 'Versicherung', absender: '@([a-z0-9-]+\\.)?(gothaer\\.(de|info)|allianz\\.de|alte-leipziger\\.de|standardlife\\.de|ruv\\.de|helvetia\\.(de|ch)|pantaenius\\.(de|com)|swisslife\\.de|nuernberger\\.de|debeka\\.de|ergo\\.de|axa\\.de|hdi\\.de)$' },
    { name: 'Team bikolino', absender: '@bikolino\\.com$' },
  ],
  stichworte: [
    { muster: 'z(ä|ae)hler|ablesung', vorschlag: 'b', thema: 'Zählerstände', auchText: true },
    { muster: 'mahnung|zahlungserinnerung|inkasso|widerspruch|reklamation', vorschlag: 'e', thema: 'Mahnung/Reklamation', auchText: true },
    { muster: 'rechnung|abrechnung|gutschrift|\\bbeleg(e|en)?\\b|receipt|invoice', vorschlag: 'a', thema: 'Beleg', auchText: true },
    { muster: 'frist(?!los)|bescheid|k(ü|ue)ndigung|terminvereinbarung|terminerinnerung', vorschlag: 'd', thema: 'Frist/Termin', auchText: true },
    { muster: 'angebot', vorschlag: 'c', thema: 'Angebot', auchText: false },
    { muster: 'bestell|liefer(ung|schein|termin)|auftragsbest(ä|ae)tigung|vertrag', vorschlag: 'f', thema: 'Bestellung/Vertrag', auchText: false },
  ],
  objekte: [
    { kuerzel: 'MG24', muster: '\\bMG ?24\\b|marktgasse', text: 'marktgasse' },
    { kuerzel: 'N24', muster: '\\bN24\\b|nonnenburg', text: 'nonnenburg' },
    { kuerzel: 'L19', muster: '\\bL19\\b|leutenberg', text: 'leutenberg' },
    { kuerzel: 'S28', muster: '\\bS28\\b|sch(ö|oe)nhalde', text: 'sch(ö|oe)nhalde' },
    { kuerzel: 'D4', muster: '\\bD4\\b|daimlerstr', text: 'daimlerstr(\\.|a(ß|ss)e) ?4\\b' },
    { kuerzel: 'I83', muster: '\\bI83\\b|irisweg', text: 'irisweg' },
    { kuerzel: 'ZZ5', muster: '\\bZ{1,2}5\\b|zelterweg', text: 'zelterweg' },
    { kuerzel: 'abc-raum', muster: 'abc-raum', text: 'abc-raum' },
  ],
  ausschluss: {
    gesundheitAbsender: 'zavamed|doktorabc|medcanonestop|nordleaf|apotheke|doctolib|withings',
    paketAbsender: '(^|[.@])(dhl|dpd|gls-pakete|ups|deutschepost|cargoboard|cepra)\\.|^(shipment-tracking|versandbestaetigung|order-update)@amazon\\.',
    paketAusnahme: 'versp(ä|ae)tet|nicht zustellbar|unzustellbar',
    systemAbsender: 'swingerheim\\.com|clockin\\.de|solarlog-web\\.de|sophos\\.com|mailer-daemon|postmaster@',
    systemBetreff: 'sign-in|anmeldecode|best(ä|ae)tigungscode|verification code|abwesenheitsnotiz|automatische antwort|out of office',
    socialAbsender: '(^|[.@])(linkedin\\.com|xing\\.com|facebookmail\\.com|instagram\\.com)$',
    socialOrdner: '^Soziale Updates$',
    werbungOrdner: '^(Angebote|Lesestoff)$',
    werbungBetreff: 'empfehlen sie|jetzt .*sichern|geschenk|gutschein|\\d+ ?% rabatt|angebote?: haus zum kauf',
    bewerbung: 'bewerbung|lebenslauf|\\bcv\\b|available for projects|ingenieur - |engineer - |analyst - |developer - ',
  },
};

/**
 * Regelwerk laden. Was in der Datei fehlt oder kaputt ist, kommt aus der
 * Vorgabe — eine Tippfehler-Regex soll den Lauf nicht anhalten.
 */
export function ladeRegeln(pfad: string): { regeln: Regelwerk; warnungen: string[] } {
  const warnungen: string[] = [];
  let roh: any = null;
  try {
    roh = JSON.parse(fs.readFileSync(pfad, 'utf-8'));
  } catch (e: any) {
    if (fs.existsSync(pfad)) warnungen.push(`relevanz.json unlesbar (${e?.message ?? e}) — Vorgabe gilt`);
    return { regeln: STANDARD_REGELN, warnungen };
  }
  const regeln: Regelwerk = {
    version: 1,
    ownerAdressen: Array.isArray(roh?.ownerAdressen) ? roh.ownerAdressen.map(String) : STANDARD_REGELN.ownerAdressen,
    kontakte: Array.isArray(roh?.kontakte) ? roh.kontakte : STANDARD_REGELN.kontakte,
    stichworte: Array.isArray(roh?.stichworte) ? roh.stichworte : STANDARD_REGELN.stichworte,
    objekte: Array.isArray(roh?.objekte) ? roh.objekte : STANDARD_REGELN.objekte,
    ausschluss: { ...STANDARD_REGELN.ausschluss, ...(roh?.ausschluss ?? {}) },
  };
  /* Jede Regex einmal pruefen; eine kaputte faellt auf die Vorgabe zurueck. */
  const pruefe = (s: string) => { try { new RegExp(s, 'i'); return true; } catch { return false; } };
  regeln.kontakte = regeln.kontakte.filter((k) => {
    const ok = typeof k?.absender === 'string' && pruefe(k.absender);
    if (!ok) warnungen.push(`Kontakt „${k?.name}" ohne gültiges Muster — übergangen`);
    return ok;
  });
  regeln.stichworte = regeln.stichworte.filter((s) => {
    const ok = typeof s?.muster === 'string' && pruefe(s.muster) && s.vorschlag in KATALOG;
    if (!ok) warnungen.push(`Stichwort „${s?.muster}" ungültig — übergangen`);
    return ok;
  });
  regeln.objekte = regeln.objekte.filter((o) => {
    const ok = typeof o?.muster === 'string' && pruefe(o.muster)
      && (o.text === undefined || (typeof o.text === 'string' && pruefe(o.text)));
    if (!ok) warnungen.push(`Objekt „${o?.kuerzel}" ungültig — übergangen`);
    return ok;
  });
  for (const [k, v] of Object.entries(regeln.ausschluss) as Array<[keyof Regelwerk['ausschluss'], string]>) {
    if (typeof v !== 'string' || !pruefe(v)) {
      warnungen.push(`Ausschluss ${k} ungültig — Vorgabe gilt`);
      regeln.ausschluss[k] = STANDARD_REGELN.ausschluss[k];
    }
  }
  return { regeln, warnungen };
}

/** Vorgabe schreiben, wenn noch keine Datei da ist. Ueberschreibt nie. */
export function regelnAnlegenFallsFehlend(pfad: string): boolean {
  if (fs.existsSync(pfad)) return false;
  fs.mkdirSync(path.dirname(pfad), { recursive: true });
  const inhalt = {
    _hinweis: 'Relevanzregeln Mail-Register (Auftrag 27.10.2026). Owner-editierbar; '
      + 'Muster sind Regex ohne Gross-/Kleinschreibung; wirkt beim naechsten Stundenlauf. '
      + 'Vorschlaege: a Beleg ablegen + Buchung, b Zaehlerstaende/Fakten einarbeiten, '
      + 'c Antwortentwurf, d Frist/Termin, e Reklamation/Widerspruch, f nur zur Kenntnis.',
    ...STANDARD_REGELN,
  };
  fs.writeFileSync(pfad, JSON.stringify(inhalt, null, 2) + '\n', 'utf-8');
  return true;
}

// ── Bewertung ──────────────────────────────────────────────────────────────

export interface BewertungsEingang {
  absender: string;
  absenderName: string;
  betreff: string;
  ordner: string;
  /** Kopfzeilen in Kleinschreibung. */
  kopf: Record<string, string>;
  /** Mailtext, gekuerzt. Fehlt er, wird nur der Kopf bewertet. */
  text?: string;
}

export interface Bewertung {
  relevant: boolean;
  /** Warum — fuer Journal und Tests. */
  grund: string;
  kontakt?: string;
  objekt?: string;
  thema?: string;
  vorschlag: VorschlagCode;
  /** Antwort auf eine Mail, die der Owner gesendet hat. */
  antwort: boolean;
}

const re = (s: string) => new RegExp(s, 'i');

function antwortIds(kopf: Record<string, string>): string[] {
  const roh = `${kopf['in-reply-to'] ?? ''} ${kopf['references'] ?? ''}`;
  return (roh.match(/<[^<>\s]+>/g) ?? []).map((s) => s.toLowerCase());
}

/**
 * Ausschluss allein aus dem Kopf — dann braucht es keinen Mailtext. Liefert
 * den Grund oder null. Gesundheit und eigene Mail kommen zuerst und gelten
 * immer; die uebrigen Gruende nur, wenn kein Kontakt passt.
 */
export function kopfAusschluss(m: BewertungsEingang, r: Regelwerk): string | null {
  const adresse = m.absender.toLowerCase().trim();
  if (r.ownerAdressen.some((a) => a.toLowerCase() === adresse)) return 'eigene Mail';
  if (inventarAusschluss({ betreff: m.betreff, adresse, name: m.absenderName }) === 'gesundheit'
    || re(r.ausschluss.gesundheitAbsender).test(adresse)) return 'Gesundheit';
  if (kontaktVon(adresse, r)) return null;
  const a = r.ausschluss;
  if (re(a.paketAbsender).test(adresse) && !re(a.paketAusnahme).test(m.betreff)) return 'Paketstatus';
  if (re(a.systemAbsender).test(adresse) || re(a.systemBetreff).test(m.betreff)) return 'Systemmeldung';
  if (re(a.socialAbsender).test(adresse) || re(a.socialOrdner).test(m.ordner)) return 'Social';
  if (re(a.bewerbung).test(m.betreff)) return 'Bewerbung';
  if (m.kopf['list-unsubscribe'] || /^(bulk|list|junk)$/i.test((m.kopf['precedence'] ?? '').trim())) {
    return 'Newsletter';
  }
  if (inventarAusschluss({ betreff: m.betreff, adresse, name: m.absenderName }) === 'newsletter') {
    return 'Newsletter';
  }
  if (re(a.werbungOrdner).test(m.ordner) || re(a.werbungBetreff).test(m.betreff)) return 'Werbung';
  return null;
}

function kontaktVon(adresse: string, r: Regelwerk): string | undefined {
  if (r.ownerAdressen.some((a) => a.toLowerCase() === adresse)) return undefined;
  return r.kontakte.find((k) => re(k.absender).test(adresse))?.name;
}

export function bewerte(
  m: BewertungsEingang, r: Regelwerk, gesendeteIds: Set<string> = new Set(),
): Bewertung {
  const nein = (grund: string): Bewertung => ({ relevant: false, grund, vorschlag: 'offen', antwort: false });
  const aus = kopfAusschluss(m, r);
  if (aus) return nein(aus);

  const adresse = m.absender.toLowerCase().trim();
  const kontakt = kontaktVon(adresse, r);
  const kopfFeld = m.betreff;
  const feld = `${m.betreff}\n${(m.text ?? '').slice(0, 3000)}`;
  /* Objekt zuerst im Betreff; nur wenn dort keins steht, im Text. */
  const objekt = r.objekte.find((o) => re(o.muster).test(kopfFeld))?.kuerzel
    ?? r.objekte.find((o) => o.text && re(o.text).test(feld))?.kuerzel;
  /* Stichwort ebenso: Der Betreff sagt meist, worum es geht. */
  const stich = r.stichworte.find((s) => re(s.muster).test(kopfFeld))
    ?? r.stichworte.find((s) => s.auchText !== false && re(s.muster).test(feld));
  const antwort = antwortIds(m.kopf).some((id) => gesendeteIds.has(id));

  /* Paketstatus ist ausgeschlossen — ausser er meldet ein Problem. Dann ist
     er relevant, auch ohne weiteres Merkmal (Auftrag 27.10.2026). */
  const paketProblem = re(r.ausschluss.paketAbsender).test(adresse)
    && re(r.ausschluss.paketAusnahme).test(m.betreff);
  if (paketProblem && !kontakt && !objekt && !antwort) {
    return { relevant: true, grund: 'Paket verspätet/unzustellbar', thema: 'Paket', vorschlag: 'f', antwort: false };
  }
  if (!kontakt && !stich && !objekt && !antwort) return nein('kein Merkmal');

  let vorschlag: VorschlagCode;
  let thema: string | undefined;
  if (stich) { vorschlag = stich.vorschlag; thema = stich.thema; }
  else if (antwort) { vorschlag = 'c'; thema = 'Antwort auf eigene Mail'; }
  else { vorschlag = 'offen'; }
  /* Eine Antwort auf die eigene Mail, die nur „zur Kenntnis" waere, ist
     meist eine Rueckfrage — dann ist der Antwortentwurf naeher. */
  if (antwort && vorschlag === 'f') { vorschlag = 'c'; thema = 'Antwort auf eigene Mail'; }

  const gruende = [kontakt ? `Kontakt ${kontakt}` : '', stich ? `Stichwort ${stich.thema}` : '',
    objekt ? `Objekt ${objekt}` : '', antwort ? 'Antwort auf eigene Mail' : ''].filter(Boolean);
  return {
    relevant: true, grund: gruende.join(', '), kontakt, objekt,
    thema: thema ?? kontakt, vorschlag, antwort,
  };
}

/** Vorschlag als lesbare Zeile, etwa „a) Beleg ablegen + Buchung N24". */
export function vorschlagText(b: Pick<Bewertung, 'vorschlag' | 'objekt' | 'thema'>): string {
  switch (b.vorschlag) {
    case 'a': return `a) ${KATALOG.a} ${b.objekt ?? 'Objekt ?'}`;
    case 'b': return `b) ${KATALOG.b}${b.objekt ? ` (${b.objekt})` : ''}`;
    case 'c': return `c) ${KATALOG.c} (${b.thema ?? 'Thema ?'})`;
    case 'd': return `d) ${KATALOG.d} (${b.thema ?? 'Thema ?'})`;
    case 'e': return `e) ${KATALOG.e}${b.objekt ? ` (${b.objekt})` : ''}`;
    case 'f': return `f) ${KATALOG.f}`;
    default: return KATALOG.offen;
  }
}

// ── Kennung und Maskierung ─────────────────────────────────────────────────

/** Kurze, stabile Kennung fuer die Freigabezeile — aus der Message-ID. */
export function kurzId(messageId: string): string {
  return 'm-' + crypto.createHash('sha1').update(messageId.trim().toLowerCase()).digest('hex').slice(0, 8);
}

/** IBAN und Kontonummern kuerzen: nur die letzten vier Stellen bleiben. */
export function maskiere(text: string): string {
  return String(text ?? '')
    /* Mit Leer- oder Bindestrich nur Ziffern, sonst frisst das Muster das
       naechste Wort; zusammengeschrieben auch Buchstaben (Laender mit BBAN-Buchstaben). */
    .replace(/\b([A-Z]{2}\d{2})((?:[ -]?\d){10,30}|[0-9A-Z]{10,30})\b/gi, (_t, land: string, rest: string) => {
      const z = rest.replace(/[\s-]/g, '');
      return `${land.toUpperCase()}…${z.slice(-4)}`;
    })
    .replace(/((?:konto|kto|account)(?:\s?(?:nummer|nr|number|no))?\.?(?:-?nr\.?)?\s*:?\s*)(\d[\d -]{4,}\d)/gi,
      (_t, vor: string, nr: string) => `${vor}…${nr.replace(/[\s-]/g, '').slice(-4)}`);
}
