/**
 * mail-eingang — der Eingangskanal des Owners per E-Mail.
 *
 * Owner-Entscheidung (18.10.2026, 15:47): Was an
 * `juergen.bickel+bikosoc@bikolino.com` geht, ist Eingang fuer bikosoc.
 * Es gibt genau zwei Zustaende und keine weiteren Kategorien:
 *
 *   ohne Kennzeichnung          → Ablage (Datei + Protokollzeile, keine Deutung)
 *   Betreff beginnt „Auftrag:"  → Auftragsdatei in ~/inbox/, danach wie bisher
 *
 * Warum die Trennung im Dateinamen und nicht in einer Tabelle: Der Zustand
 * einer Mail ist mit ihrer Ablage abschliessend entschieden. Eine Tabelle
 * waere ein zweiter Ort, der mit der Ablage auseinanderlaufen kann.
 *
 * Zwei Dinge tut dieses Modul ausdruecklich nicht: Es versendet keine Mail,
 * und es deutet den Text nicht. Die Antwort auf einen Auftrag kommt wie immer
 * ueber Report und Telegram-Digest.
 *
 * Reihenfolge eines Durchlaufs — sie entscheidet, welcher Fehler im Abbruch
 * uebrig bleibt:
 *
 *   1. Ablage nach Dropbox (deterministischer Pfad, Upload ueberschreibt)
 *   2. Auftragsdatei nach ~/inbox/ — nur, wenn derselbe Name nicht schon in
 *      ~/inbox/ oder ~/inbox/done/ liegt (dann war der Auftrag schon da)
 *   3. Mail als verarbeitet vermerken
 *   4. Mail im Postfach nach Posteingang/bikosoc verschieben
 *
 * Bricht es nach 1 ab, wiederholt der naechste Lauf die Ablage auf denselben
 * Pfad — kein Schaden. Bricht es nach 2 ab, verhindert die Namenspruefung die
 * doppelte Ausfuehrung. Der Vermerk ist damit Beschleunigung, nicht die
 * einzige Sicherung.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DropboxAdapter } from '../../adapters/dropbox.js';
import type {
  Lage, Konfiguration, EingangsMail, PostfachZugang,
  MailEingangZeile, MailEingangLauf, Vermerk,
} from './types.js';

/*
 * Oeffentliche Schnittstelle des Moduls. Andere Teile des Systems importieren
 * ausschliesslich von hier — die Postfachseite liegt in `graph.ts`, die
 * Begriffe in `types.ts`.
 */
export type {
  Lage, Konfiguration, EingangsAnhang, EingangsMail, PostfachZugang,
  MailEingangZeile, MailEingangLauf, Vermerk,
} from './types.js';
export { anhaengeAusGraph, erstelleGraphZugang, textAusKoerper, ZIELORDNER } from './graph.js';
export type { GraphZugangsdaten } from './graph.js';

/** Zielordner in Dropbox, unter demselben Dach wie die uebrigen Ablagen. */
export const DROPBOX_MAIL_INBOX = '/bikosoc-reports/transfer/mail-inbox';

/** Vorsatz, den die Auftragsdatei im Namen traegt. */
export const AUFTRAG_VORSATZ = 'auftrag-mail-';

export const STANDARD_KONFIGURATION: Konfiguration = {
  zieladresse: 'juergen.bickel+bikosoc@bikolino.com',
  ownerAbsender: [
    'juergen.bickel@bikolino.com',
    'jbickel2@yahoo.de',
    'jbickel2@protonmail.com',
    '@privaterelay.appleid.com',
  ],
  maxBytes: 50 * 1024 * 1024,
};

/** Konfigurationsdatei lesen; fehlt sie, gilt die Vorgabe. */
export function ladeKonfiguration(pfad: string): Konfiguration {
  try {
    const roh = JSON.parse(fs.readFileSync(pfad, 'utf-8'));
    return {
      zieladresse: typeof roh.zieladresse === 'string' && roh.zieladresse.includes('@')
        ? roh.zieladresse : STANDARD_KONFIGURATION.zieladresse,
      ownerAbsender: Array.isArray(roh.ownerAbsender) && roh.ownerAbsender.length
        ? roh.ownerAbsender.filter((a: unknown) => typeof a === 'string' && a.includes('@'))
        : STANDARD_KONFIGURATION.ownerAbsender,
      maxBytes: Number.isFinite(roh.maxBytes) && roh.maxBytes > 0
        ? Number(roh.maxBytes) : STANDARD_KONFIGURATION.maxBytes,
    };
  } catch {
    return STANDARD_KONFIGURATION;
  }
}

// ── Adressen ───────────────────────────────────────────────────────────────

/** Adresse auf Vergleichsform bringen: ohne Anzeigename, ohne Klammern. */
export function adresseNormal(eingabe: string): string {
  const roh = String(eingabe ?? '').trim();
  const inKlammern = roh.match(/<([^>]+)>/);
  return (inKlammern ? inKlammern[1] : roh).trim().toLowerCase();
}

/** Trifft die Adresse den Eingangskanal? Vergleich auf ganze Adresse. */
export function istZieladresse(eingabe: string, ziel: string): boolean {
  return adresseNormal(eingabe) === adresseNormal(ziel);
}

/** Steht der Eingangskanal in To oder Cc? */
export function empfaengerTreffer(
  empfaenger: { to?: string[]; cc?: string[] }, ziel: string,
): boolean {
  const alle = [...(empfaenger.to ?? []), ...(empfaenger.cc ?? [])];
  return alle.some((a) => istZieladresse(a, ziel));
}

/** Gehoert der Absender zum Owner? Eintraege mit @ am Anfang gelten je Domain. */
export function istOwnerAbsender(absender: string, liste: string[]): boolean {
  const a = adresseNormal(absender);
  if (!a.includes('@')) return false;
  return liste.some((eintrag) => {
    const e = eintrag.trim().toLowerCase();
    return e.startsWith('@') ? a.endsWith(e) : a === adresseNormal(e);
  });
}

// ── Betreff, Lage, Namen ───────────────────────────────────────────────────

/** „Auftrag: …" — mit oder ohne Leerzeichen, Gross- und Kleinschreibung frei. */
export function istAuftrag(betreff: string): boolean {
  return /^\s*auftrag\s*:/i.test(String(betreff ?? ''));
}

export function lage(betreff: string): Lage {
  return istAuftrag(betreff) ? 'auftrag' : 'ablage';
}

const UMLAUTE: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'ae', Ö: 'oe', Ü: 'ue', ß: 'ss',
  é: 'e', è: 'e', ê: 'e', á: 'a', à: 'a', í: 'i', ó: 'o', ú: 'u', ç: 'c', ñ: 'n',
};

/**
 * Betreff zu einem Dateinamensteil. Der Vorsatz „Auftrag:" faellt weg — er
 * steht schon im Dateinamen, und zweimal braucht es ihn nicht.
 */
export function betreffSlug(betreff: string, maxLaenge = 60): string {
  const ohneVorsatz = String(betreff ?? '').replace(/^\s*auftrag\s*:\s*/i, '');
  const ersetzt = ohneVorsatz.replace(/[äöüÄÖÜßéèêáàíóúçñ]/g, (z) => UMLAUTE[z] ?? z);
  const flach = ersetzt
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLaenge)
    .replace(/-+$/g, '');
  return flach.length ? flach : 'ohne-betreff';
}

/** Zeitteile in Europe/Berlin — die Ordnernamen folgen der Ortszeit. */
export function berlinTeile(datum: Date): {
  jahr: string; monat: string; tag: string; stunde: string; minute: string;
} {
  const teile = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(datum);
  const v = (t: string) => teile.find((p) => p.type === t)?.value ?? '00';
  return {
    jahr: v('year'), monat: v('month'), tag: v('day'),
    stunde: v('hour') === '24' ? '00' : v('hour'), minute: v('minute'),
  };
}

/** `JJJJ-MM-TT_HHMM_<betreff-slug>` */
export function ablageOrdner(datum: Date, betreff: string): string {
  const t = berlinTeile(datum);
  return `${t.jahr}-${t.monat}-${t.tag}_${t.stunde}${t.minute}_${betreffSlug(betreff)}`;
}

/** `auftrag-mail-JJJJMMTT-HHMM-<betreff-slug>.txt` */
export function auftragsDateiname(datum: Date, betreff: string): string {
  const t = berlinTeile(datum);
  return `${AUFTRAG_VORSATZ}${t.jahr}${t.monat}${t.tag}-${t.stunde}${t.minute}`
    + `-${betreffSlug(betreff)}.txt`;
}

/** Anhangsnamen auf unbedenkliche Zeichen begrenzen, Endung behalten. */
export function anhangName(name: string, nummer: number): string {
  const flach = path.basename(String(name ?? '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return flach.replace(/^_+/, '').length ? flach : `anhang-${nummer}`;
}

// ── Dateiinhalte ───────────────────────────────────────────────────────────

/** Datum in deutscher Schreibweise fuer Kopfzeilen. */
export function datumDeutsch(datum: Date): string {
  const t = berlinTeile(datum);
  return `${t.tag}.${t.monat}.${t.jahr}, ${t.stunde}:${t.minute}`;
}

/**
 * `body.md` — Kopfdaten und Text, nichts gedeutet.
 *
 * `zusatzZeilen` haengt weitere Kopfpunkte an. Die Sammelstelle `data@` nutzt
 * das fuer den urspruenglichen Absender einer weitergeleiteten Nachricht, ohne
 * dass zwei Fassungen von body.md entstehen.
 */
export function bodyMarkdown(
  mail: EingangsMail, anhaenge: string[], zusatzZeilen: string[] = [],
): string {
  const datum = new Date(mail.empfangenIso);
  const z: string[] = [];
  z.push(`# ${mail.betreff || '(ohne Betreff)'}`);
  z.push('');
  z.push(`- **Empfangen:** ${datumDeutsch(datum)} (Europe/Berlin)`);
  z.push(`- **Von:** ${adresseNormal(mail.absender)}`);
  z.push(`- **An:** ${mail.to.map(adresseNormal).join(', ') || '(keine)'}`);
  if (mail.cc.length) z.push(`- **Cc:** ${mail.cc.map(adresseNormal).join(', ')}`);
  z.push(`- **Message-ID:** ${mail.messageId}`);
  z.push(`- **Anhänge:** ${anhaenge.length ? anhaenge.join(', ') : 'keine'}`);
  for (const zeile of zusatzZeilen) z.push(`- ${zeile}`);
  z.push('');
  z.push('---');
  z.push('');
  z.push(mail.text.trim().length ? mail.text.trim() : '(kein Text)');
  z.push('');
  return z.join('\n');
}

/**
 * Inhalt der Auftragsdatei: eine Kopfzeile mit der Herkunft, danach der
 * Mailtext **1:1**. Nichts gekuerzt, nichts umformuliert.
 */
export function auftragsInhalt(
  mail: EingangsMail, ablagePfad: string, anhaenge: string[],
): string {
  const datum = new Date(mail.empfangenIso);
  const anhangTeil = anhaenge.length
    ? `${ablagePfad} (${anhaenge.join(', ')})`
    : 'keine';
  const z: string[] = [];
  z.push(`Quelle: Mail vom ${datumDeutsch(datum)}, Betreff ${mail.betreff}, `
    + `Anhänge: ${anhangTeil}`);
  z.push('');
  z.push(mail.text.trim());
  z.push('');
  return z.join('\n');
}

// ── Vermerk der verarbeiteten Mails ────────────────────────────────────────

export function ladeVermerk(pfad: string): Vermerk {
  try {
    const roh = JSON.parse(fs.readFileSync(pfad, 'utf-8'));
    if (Array.isArray(roh?.ids)) {
      return {
        version: 1,
        ids: roh.ids.map(String),
        ordner: roh.ordner && typeof roh.ordner === 'object' ? { ...roh.ordner } : {},
        letzterLauf: roh.letzterLauf,
      };
    }
  } catch { /* erster Lauf */ }
  return { version: 1, ids: [], ordner: {} };
}

export function speichereVermerk(pfad: string, vermerk: Vermerk): void {
  fs.mkdirSync(path.dirname(pfad), { recursive: true });
  const behalten = new Set(vermerk.ids.slice(-2000));
  const gekuerzt: Vermerk = {
    version: 1,
    ids: vermerk.ids.slice(-2000),
    ordner: Object.fromEntries(
      Object.entries(vermerk.ordner ?? {}).filter(([id]) => behalten.has(id))),
    letzterLauf: vermerk.letzterLauf,
  };
  fs.writeFileSync(pfad, JSON.stringify(gekuerzt, null, 2), 'utf-8');
}

/**
 * Einen freien Ablageordner vergeben und die Vergabe im Vermerk festhalten.
 *
 * Normalfall: der Name aus Datum, Uhrzeit und Betreff-Slug. Nur wenn derselbe
 * Name schon zu einer anderen Mail gehoert, kommt `-2`, `-3` dazu — so bleibt
 * die vorgegebene Form sichtbar und keine Mail ueberschreibt eine andere.
 */
export function vergebeOrdner(
  gewuenscht: string, messageId: string, vermerk: Vermerk,
): string {
  const belegt = vermerk.ordner ?? (vermerk.ordner = {});
  const schon = belegt[messageId];
  if (schon) return schon;
  const fremdBelegt = (name: string) => Object.entries(belegt)
    .some(([id, o]) => o === name && id !== messageId);
  let name = gewuenscht;
  for (let n = 2; fremdBelegt(name) && n < 100; n++) name = `${gewuenscht}-${n}`;
  belegt[messageId] = name;
  return name;
}

/**
 * Liegt derselbe Auftrag schon in ~/inbox/ oder ~/inbox/done/?
 *
 * Der Prompt-Inbox-Poller setzt beim Verschieben einen Zeitstempel vor den
 * Namen — deshalb wird auf Endung verglichen, nicht auf Gleichheit.
 */
export function auftragSchonZugestellt(inboxDir: string, dateiname: string): boolean {
  const schauIn = (ordner: string): boolean => {
    let namen: string[];
    try { namen = fs.readdirSync(ordner); } catch { return false; }
    return namen.some((n) => n === dateiname || n.endsWith(`-${dateiname}`));
  };
  return schauIn(inboxDir) || schauIn(path.join(inboxDir, 'done'));
}

// ── Ein Durchlauf ──────────────────────────────────────────────────────────

/** Was das Postfach koennen muss. Als Schnittstelle, damit es pruefbar ist. */
export interface MailEingangDeps {
  postfach: PostfachZugang;
  dropbox: DropboxAdapter;
  homeDir: string;
  konfiguration: Konfiguration;
  /** Datei mit den schon verarbeiteten Message-IDs. */
  vermerkPfad: string;
  inboxDir?: string;
  /** Wie weit zurueck gesucht wird, wenn noch nie gelaufen. */
  rueckblickStunden?: number;
  now?: Date;
  melde?: (zeile: MailEingangZeile) => Promise<void> | void;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export async function verarbeiteMailEingangEinmal(
  deps: MailEingangDeps,
): Promise<MailEingangLauf> {
  const now = deps.now ?? new Date();
  const inboxDir = deps.inboxDir ?? path.join(deps.homeDir, 'inbox');
  const log = deps.logger;
  const vermerk = ladeVermerk(deps.vermerkPfad);
  const seit = vermerk.letzterLauf
    ? new Date(new Date(vermerk.letzterLauf).getTime() - 15 * 60_000).toISOString()
    : new Date(now.getTime() - (deps.rueckblickStunden ?? 24) * 3_600_000).toISOString();

  const mails = await deps.postfach.neueMails(seit);
  const treffer = mails.filter((m) =>
    empfaengerTreffer({ to: m.to, cc: m.cc }, deps.konfiguration.zieladresse));

  const lauf: MailEingangLauf = { gesehen: mails.length, verarbeitet: [], uebersprungen: 0 };

  for (const mail of treffer.slice().reverse()) {
    if (vermerk.ids.includes(mail.messageId)) { lauf.uebersprungen++; continue; }

    const fremd = !istOwnerAbsender(mail.absender, deps.konfiguration.ownerAbsender);
    const ordner = vergebeOrdner(
      ablageOrdner(new Date(mail.empfangenIso), mail.betreff), mail.messageId, vermerk);
    const ziel = `${DROPBOX_MAIL_INBOX}/${ordner}`;
    const zeile: MailEingangZeile = {
      lage: fremd ? 'ablage' : lage(mail.betreff),
      empfangenIso: mail.empfangenIso,
      betreff: mail.betreff,
      absender: adresseNormal(mail.absender),
      fremderAbsender: fremd,
      anhaenge: [],
      ablagePfad: ziel,
      einsortiert: 'uebersprungen',
    };

    try {
      // 1. Ablage — .eml, Anhaenge, body.md
      const anhaenge = mail.hatAnhaenge ? await deps.postfach.anhaenge(mail.id) : [];
      const roh = await deps.postfach.mime(mail.id);
      const summe = Buffer.byteLength(roh, 'utf-8')
        + anhaenge.reduce((s, a) => s + a.bytes.length, 0);
      if (summe > deps.konfiguration.maxBytes) {
        zeile.lage = 'fehler';
        zeile.hinweis = `über ${Math.round(deps.konfiguration.maxBytes / 1024 / 1024)} MB `
          + `(${(summe / 1024 / 1024).toFixed(1)} MB) — nicht abgelegt`;
        lauf.verarbeitet.push(zeile);
        await deps.melde?.(zeile);
        vermerk.ids.push(mail.messageId);
        continue;
      }

      const namen: string[] = [];
      for (const [i, a] of anhaenge.entries()) {
        const name = anhangName(a.name, i + 1);
        await deps.dropbox.uploadFile({
          path: `${ziel}/${name}`, body: a.bytes,
          contentType: a.contentType || 'application/octet-stream',
        });
        namen.push(name);
      }
      zeile.anhaenge = namen;

      await deps.dropbox.uploadFile({
        path: `${ziel}/mail.eml`, body: Buffer.from(roh, 'utf-8'),
        contentType: 'message/rfc822',
      });
      await deps.dropbox.uploadFile({
        path: `${ziel}/body.md`, body: Buffer.from(bodyMarkdown(mail, namen), 'utf-8'),
        contentType: 'text/markdown; charset=utf-8',
      });

      // 2. Auftrag — nur bei Owner-Absender und nur einmal
      if (zeile.lage === 'auftrag') {
        const dateiname = auftragsDateiname(new Date(mail.empfangenIso), mail.betreff);
        if (auftragSchonZugestellt(inboxDir, dateiname)) {
          zeile.hinweis = 'Auftragsdatei lag bereits in ~/inbox — nicht erneut zugestellt';
        } else {
          fs.mkdirSync(inboxDir, { recursive: true });
          const part = path.join(inboxDir, `.${dateiname}.part`);
          fs.writeFileSync(part, auftragsInhalt(mail, ziel, namen), 'utf-8');
          fs.renameSync(part, path.join(inboxDir, dateiname));
          zeile.auftragsDatei = path.join(inboxDir, dateiname);
        }
      }

      // 3. Vermerk
      vermerk.ids.push(mail.messageId);

      // 4. Postfach aufraeumen
      zeile.einsortiert = await deps.postfach.einsortieren(mail.id)
        .catch(() => 'nicht_moeglich' as const);

      log?.info(`[mail-eingang] ${zeile.lage}: ${mail.betreff} → ${ziel}`);
      lauf.verarbeitet.push(zeile);
      await deps.melde?.(zeile);
    } catch (e: any) {
      zeile.lage = 'fehler';
      zeile.hinweis = e?.message ? String(e.message).slice(0, 200) : 'unbekannter Fehler';
      log?.warn(`[mail-eingang] ${mail.betreff}: ${zeile.hinweis}`);
      lauf.verarbeitet.push(zeile);
      await deps.melde?.(zeile);
    }
  }

  vermerk.letzterLauf = now.toISOString();
  speichereVermerk(deps.vermerkPfad, vermerk);
  return lauf;
}

/** Eine Zeile fuer die Telegram-Kurzmeldung. */
export function meldungstext(zeile: MailEingangZeile): string {
  const betreff = zeile.betreff || '(ohne Betreff)';
  if (zeile.lage === 'fehler') {
    return `Mail-Eingang Fehler: ${betreff} — ${zeile.hinweis ?? 'siehe Protokoll'}`;
  }
  const kopf = zeile.auftragsDatei
    ? `Mail-Eingang: ${betreff} → Auftrag ${path.basename(zeile.auftragsDatei)}`
    : `Mail-Eingang: ${betreff} → Ablage ${zeile.ablagePfad}`;
  return zeile.fremderAbsender ? `${kopf} (fremder Absender ${zeile.absender})` : kopf;
}

/** Abschnitt „Mail-Eingang" fuer den naechsten Report. */
export function reportAbschnitt(lauf: MailEingangLauf): string {
  if (!lauf.verarbeitet.length) return '## Mail-Eingang\n\nKeine Mail im Eingangskanal.\n';
  const z: string[] = ['## Mail-Eingang', ''];
  z.push('| Datum | Betreff | Anhänge | Ablage | Lage |');
  z.push('|---|---|---|---|---|');
  for (const e of lauf.verarbeitet) {
    const anh = e.anhaenge.length ? `${e.anhaenge.length}: ${e.anhaenge.join(', ')}` : 'keine';
    const lageText = e.lage === 'auftrag' && e.auftragsDatei
      ? `Auftrag (${path.basename(e.auftragsDatei)})`
      : e.lage === 'fehler' ? `Fehler — ${e.hinweis ?? ''}`
      : e.fremderAbsender ? 'Ablage (fremder Absender)' : 'Ablage';
    z.push(`| ${datumDeutsch(new Date(e.empfangenIso))} | ${e.betreff} | ${anh} `
      + `| \`${e.ablagePfad}\` | ${lageText} |`);
  }
  z.push('');
  return z.join('\n');
}
