/**
 * sekretariat/fristabgleich — Offene Fristen mit Mail-Bezug gegen Gesendete Elemente.
 *
 * ANLASS (Owner-Rüge 30.10.2026 07:31, „Schon wieder???“): Das Morgenbriefing
 * zeigte „energiekonzept: finale Jahresabrechnungen 2025 anmahnen“ als seit
 * 8 Tagen überfällig, obwohl die Mahnung am 27.10. gesendet war. Niemand hatte
 * die Frist geschlossen.
 *
 * REGELN (Owner-Auftrag 30.10.2026, Teil B):
 *   - Geprüft werden offene Fristen, deren Text eine Mail an eine Gegenseite
 *     verlangt (anmahnen, nachfassen, anfragen …). Fristen, die auf eine
 *     ANTWORT der Gegenseite warten, bleiben aussen vor — die eigene Mail
 *     erledigt sie nicht.
 *   - Treffer = eine gesendete Mail seit Anlage der Frist an eine Adresse aus
 *     der Frist (Bezeichnung, Notiz, `an`) UND mit dem Thema der Frist im
 *     Betreff oder Text. Dann wird die Frist erledigt (Audit
 *     „frist.auto-erledigt“ mit Versanddatum und Mail-ID).
 *   - Eine Folgefrist „Antwort von …“ wird NICHT angelegt, nur vorgeschlagen
 *     (Termin aus dem Mailtext, sonst Versand + 14 Tage).
 *
 * Reine Funktionen und ein Ablauf mit eingereichten Zugriffen (Datenbank,
 * Postfach, Datei) — testbar ohne Netz.
 */
import fs from 'node:fs';

export const FOLGE_TAGE = 14;

/** Wortstämme, die eine eigene Mail verlangen. Nicht „erinnern“/„zusenden“:
    meist schickt dort die Gegenseite (Review 30.10.2026). */
const MAIL_VERLANGT = /anmahn|mahnen|nachfass|nachhak|anfrag|anfordern|anschreiben|mitteilen|\bmail\b|e-mail|schreiben an|bitten um|bitte um/i;
/** Wartet auf die Gegenseite — die eigene Mail erledigt das nicht. */
const WARTET_AUF_ANTWORT = /\bantwort|abwarten|warten auf|wartet|rückmeldung|bestätigung|erwartet|liefert|lieferung|rückruf|eingang|zusage/i;
/** Eigene Postfächer: nie Gegenseite, weder als Frist-Adresse noch als Empfänger. */
const EIGEN = /@bikolino\.com$|^jbickel2@yahoo\.de$|@proton(mail)?\.[a-z]+$|@pm\.me$/i;
/** Weiterleitungen belegen keine Mail an die Gegenseite. */
const WEITERLEITUNG = /^\s*(wg|fw|fwd)\s*:/i;
/** Ein einzelner Themenstamm genügt nur, wenn er aus einem langen, spezifischen Wort stammt. */
const LANGES_WORT = 12;
/** Allerweltsdomains: hier zählt nur die genaue Adresse, nicht die Domain. */
const ALLERWELT = /^(gmail\.com|googlemail\.com|yahoo\.[a-z.]+|gmx\.[a-z.]+|web\.de|t-online\.de|outlook\.[a-z.]+|hotmail\.[a-z.]+|icloud\.com|me\.com|kabelbw\.de|bikolino\.com)$/i;
const ADRESSE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const FUELLWORT = new Set(['bitte', 'sowie', 'beide', 'beiden', 'nach', 'unter', 'gegen', 'über', 'ueber', 'durch', 'werden', 'wurde',
  'anmahnen', 'nachfassen', 'anfragen', 'anfordern', 'erinnern', 'zusenden', 'mitteilen', 'schreiben', 'senden', 'frist', 'termin']);

export function verlangtMail(text: string): boolean {
  const t = String(text || '');
  return MAIL_VERLANGT.test(t) && !WARTET_AUF_ANTWORT.test(t);
}

export function adressen(...texte: Array<string | null | undefined>): string[] {
  const s = new Set<string>();
  for (const t of texte) for (const a of String(t || '').match(ADRESSE) ?? []) s.add(a.toLowerCase().replace(/\.$/, ''));
  return [...s].filter((a) => !EIGEN.test(a));
}

/** Gegenseite: Text vor dem ersten Doppelpunkt („energiekonzept: …“), sonst leer. */
export function gegenseite(text: string): string {
  const m = /^\s*([^:]{2,40}):/.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

/**
 * Themenwörter der Frist als Stämme (erste 7 Buchstaben): Wörter ab 5 Zeichen
 * ohne Gegenseite, Objektkürzel, Zahlen und Füllwörter.
 */
export function themaStaemme(text: string): string[] {
  return themaWoerter(text).map((w) => w.slice(0, 7)).filter((w, i, a) => a.indexOf(w) === i);
}

function themaWoerter(text: string): string[] {
  const gs = gegenseite(text).toLowerCase();
  const rumpf = gs ? String(text).slice(String(text).indexOf(':') + 1) : String(text || '');
  const woerter = rumpf.toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^a-zäöüß]+/).filter(Boolean);
  return [...new Set(woerter.filter((w) => w.length >= 5 && !FUELLWORT.has(w) && w !== gs))];
}

/**
 * Thema passt: mindestens zwei Stämme der Frist im Text — oder einer, wenn
 * er aus einem langen Wort stammt („Jahresabrechnungen“), weil ein einzelnes
 * kurzes Wort („Schlüssel“) zu oft zufällig vorkommt (Review 30.10.2026).
 */
export function themaPasstFrist(fristText: string, text: string): boolean {
  const t = String(text || '').toLowerCase();
  const woerter = themaWoerter(fristText);
  const treffer = woerter.filter((w) => t.includes(w.slice(0, 7)));
  if (!treffer.length) return false;
  return treffer.length >= Math.min(2, woerter.length) || treffer.some((w) => w.length >= LANGES_WORT);
}

export interface GesendeteMail {
  /** Graph-ID (zum Nachladen des Textes) */
  id: string;
  /** Internet-Message-ID, dauerhaft (Graph-IDs ändern sich beim Verschieben) */
  mailId: string;
  betreff: string;
  /** An und Cc, klein geschrieben */
  an: string[];
  /** ISO, Versandzeit */
  zeit: string;
  /** Betreff + Vorschau bzw. Text, wie geladen */
  text: string;
}

export function adressePasst(fristAdressen: string[], an: string[]): boolean {
  return an.filter((x) => !EIGEN.test(x)).some((x) => fristAdressen.filter((f) => !EIGEN.test(f)).some((f) => {
    if (x === f) return true;
    const dx = x.split('@')[1] ?? ''; const df = f.split('@')[1] ?? '';
    return !!dx && dx === df && !ALLERWELT.test(dx);
  }));
}

/** Mails an die Gegenseite seit `seit`, älteste zuerst. */
export function kandidaten(fristAdressen: string[], seit: string, mails: GesendeteMail[]): GesendeteMail[] {
  if (!fristAdressen.length) return [];
  return mails.filter((m) => m.zeit >= seit && !WEITERLEITUNG.test(m.betreff) && adressePasst(fristAdressen, m.an))
    .sort((a, b) => a.zeit.localeCompare(b.zeit));
}


/** Termin der Folgefrist: „bis (zum) TT.MM.JJJJ“ aus dem Mailtext, sonst Versand + 14 Tage. */
export function folgeTermin(mailText: string, versandIso: string): string {
  const m = /bis\s+(?:zum\s+|spätestens\s+)?(\d{1,2})\.(\d{1,2})\.(20\d{2})/i.exec(String(mailText || ''));
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (iso > versandIso.slice(0, 10)) return iso;
  }
  return new Date(Date.parse(versandIso) + FOLGE_TAGE * 86_400_000).toISOString().slice(0, 10);
}

/** Kalendertag in Berlin. */
export function berlinTag(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export interface PruefFrist {
  quelle: 'objekt' | 'sekretariat';
  /** objekt_fristen.id bzw. „<Vorgang>#<Index>“ */
  schluessel: string;
  objekt: string;
  text: string;
  adressen: string[];
  /** ISO, Anlage der Frist */
  seit: string;
}

export interface Erledigung {
  frist: PruefFrist;
  mail: Pick<GesendeteMail, 'mailId' | 'betreff' | 'an' | 'zeit'>;
  /** Kalendertag Berlin des Versands — wird erledigt_am */
  erledigtAm: string;
  vorschlag: { was: string; termin: string };
}

/**
 * Treffer für eine Frist: erst Empfänger und Zeit (ohne Netz), dann das
 * Thema im Betreff (nur neuer Mails, nicht „AW:“) und im EIGENEN Text der Mail — der
 * zitierte Verlauf zählt nicht, darum wird der Text ohne Zitat nachgeladen.
 */
export async function findeTreffer(
  f: PruefFrist, mails: GesendeteMail[], holeText: (m: GesendeteMail) => Promise<string>,
): Promise<{ mail: GesendeteMail; text: string } | null> {
  if (!themaStaemme(f.text).length) return null;
  for (const m of kandidaten(f.adressen, f.seit, mails)) {
    const eigen = await holeText(m).catch(() => '');
    // Antwort-Betreffe sind geerbt („AW: …“) — sie belegen nicht, was der Owner schrieb.
    const betreff = /^\s*(re|aw|antw)\s*:/i.test(m.betreff) ? '' : m.betreff;
    if (themaPasstFrist(f.text, `${betreff} ${eigen}`)) return { mail: m, text: eigen };
  }
  return null;
}

export function erledigung(f: PruefFrist, mail: GesendeteMail, text: string): Erledigung {
  // Keine Domain als Name: eine Adresse kann einen Mieternamen tragen (C5).
  const wer = gegenseite(f.text) || 'Gegenseite';
  return {
    frist: f,
    mail: { mailId: mail.mailId, betreff: mail.betreff, an: mail.an, zeit: mail.zeit },
    erledigtAm: berlinTag(mail.zeit),
    vorschlag: { was: `Antwort von ${wer} (Mail vom ${berlinTag(mail.zeit).slice(8, 10)}.${berlinTag(mail.zeit).slice(5, 7)}.)`, termin: folgeTermin(text, mail.zeit) },
  };
}

/* ── Ablauf ──────────────────────────────────────────────────────────────── */

type Abfrage = (sql: string, p?: unknown[]) => Promise<{ rows: any[] }>;

export interface AbgleichZugriff {
  query: Abfrage;
  /** Gesendete Elemente seit ISO-Zeit */
  holeGesendet: (seitIso: string) => Promise<GesendeteMail[]>;
  holeText: (m: GesendeteMail) => Promise<string>;
  /** vorgaenge.json des Sekretariats; fehlt sie, nur Objektfristen */
  sekDatei?: string;
  /** nur prüfen, nichts schreiben */
  probe?: boolean;
  jetzt?: Date;
  aktor?: string;
}

/** Höchstens so weit zurück wird im Postfach gesucht. */
export const ABGLEICH_TAGE = 60;

export async function objektFristenZurPruefung(query: Abfrage): Promise<PruefFrist[]> {
  const { rows } = await query(
    `SELECT f.id, upper(p.code) AS objekt, f.bezeichnung, f.notes, f.created_at
       FROM objekt_fristen f JOIN properties p ON p.id = f.property_id
      WHERE f.erledigt_am IS NULL AND coalesce(f.verantwortlich, 'owner') = 'owner'`);
  return rows.filter((r) => verlangtMail(r.bezeichnung)).map((r) => ({
    quelle: 'objekt' as const, schluessel: String(r.id), objekt: r.objekt, text: r.bezeichnung,
    adressen: adressen(r.bezeichnung, r.notes), seit: new Date(r.created_at).toISOString(),
  }));
}

export function sekretariatFristenZurPruefung(datei: string): PruefFrist[] {
  if (!fs.existsSync(datei)) return [];
  const d = JSON.parse(fs.readFileSync(datei, 'utf-8'));
  const out: PruefFrist[] = [];
  for (const v of Array.isArray(d?.vorgaenge) ? d.vorgaenge : []) {
    if (v?.status === 'erledigt' || v?.status === 'abgelegt' || !Array.isArray(v?.fristen)) continue;
    v.fristen.forEach((f: any, i: number) => {
      /* Ohne Anlagezeit der Frist nicht prüfen: das Anlagedatum des Vorgangs
         liegt oft vor der Mail, die die Frist erst ausgelöst hat (Review 30.10.2026). */
      if (!f || f.erledigt || !f.angelegt || !verlangtMail(String(f.was || ''))) return;
      const an = Array.isArray(f.an) && f.an.length ? adressen(f.an.join(' ')) : adressen(f.was, v.naechsterSchritt);
      out.push({ quelle: 'sekretariat', schluessel: `${v.kennung}#${i}`, objekt: String(v.objekt || 'Sekretariat'),
        text: String(f.was), adressen: an, seit: String(f.angelegt) });
    });
  }
  return out;
}

/**
 * Täglicher (stündlicher) Abgleich: offene Fristen mit Mail-Bezug gegen
 * Gesendete Elemente. Treffer werden erledigt und auditiert.
 */
export async function fristAbgleich(z: AbgleichZugriff): Promise<{ geprueft: number; erledigt: Erledigung[] }> {
  const jetzt = z.jetzt ?? new Date();
  const fristen = [...await objektFristenZurPruefung(z.query), ...(z.sekDatei ? sekretariatFristenZurPruefung(z.sekDatei) : [])]
    .filter((f) => f.adressen.length);
  if (!fristen.length) return { geprueft: 0, erledigt: [] };
  const grenze = new Date(jetzt.getTime() - ABGLEICH_TAGE * 86_400_000).toISOString();
  const seit = fristen.map((f) => f.seit).filter(Boolean).sort()[0];
  const mails = await z.holeGesendet(seit && seit > grenze ? seit : grenze);
  const erledigt: Erledigung[] = [];
  for (const f of fristen) {
    const t = await findeTreffer(f, mails, z.holeText);
    if (t) erledigt.push(erledigung(f, t.mail, t.text));
  }
  if (z.probe || !erledigt.length) return { geprueft: fristen.length, erledigt };

  for (const e of erledigt.filter((x) => x.frist.quelle === 'objekt')) {
    const vermerk = `\n\nAUTO-ERLEDIGT ${jetzt.toISOString().slice(0, 16)}Z (Fristen-Abgleich): Mail „${e.mail.betreff}“ an ${e.mail.an.join(', ')} gesendet ${e.mail.zeit}, Message-ID ${e.mail.mailId}. Vorschlag Folgefrist: ${e.vorschlag.was} bis ${e.vorschlag.termin}.`;
    const { rows } = await z.query(
      `UPDATE objekt_fristen SET erledigt_am = $2::date, notes = coalesce(notes, '') || $3, updated_at = now()
        WHERE id = $1 AND erledigt_am IS NULL RETURNING id`, [Number(e.frist.schluessel), e.erledigtAm, vermerk]);
    if (rows.length) await auditZeile(z, 'objekt_frist', e);
  }
  const sek = erledigt.filter((x) => x.frist.quelle === 'sekretariat');
  if (sek.length && z.sekDatei) {
    const d = JSON.parse(fs.readFileSync(z.sekDatei, 'utf-8'));
    for (const e of sek) {
      const [kennung, idx] = e.frist.schluessel.split('#');
      const v = d.vorgaenge.find((x: any) => x.kennung === kennung);
      const f = v?.fristen?.[Number(idx)];
      // Zwischen Lesen und Schreiben kann eine Korrektur die Fristen ersetzt haben
      if (!f || f.erledigt || f.was !== e.frist.text || f.angelegt !== e.frist.seit) continue;
      Object.assign(f, { erledigt: e.erledigtAm, beleg: e.mail, vorschlagFolge: e.vorschlag });
      v.aktualisiert = jetzt.toISOString();
    }
    fs.writeFileSync(`${z.sekDatei}.tmp`, JSON.stringify(d, null, 2));
    fs.renameSync(`${z.sekDatei}.tmp`, z.sekDatei);
    for (const e of sek) await auditZeile(z, 'sekretariat_frist', e);
  }
  return { geprueft: fristen.length, erledigt };
}

async function auditZeile(z: AbgleichZugriff, typ: string, e: Erledigung) {
  await z.query(
    `INSERT INTO audit_log (actor, module, action, entity_type, entity_id, after_jsonb, source)
     VALUES ($1, 'fristen', 'frist.auto-erledigt', $2, $3, $4::jsonb, 'fristen-abgleich')`,
    [z.aktor ?? 'system', typ, e.frist.schluessel, JSON.stringify({
      objekt: e.frist.objekt, text: e.frist.text, erledigt_am: e.erledigtAm,
      mail: e.mail, vorschlag_folgefrist: e.vorschlag,
    })]);
}
