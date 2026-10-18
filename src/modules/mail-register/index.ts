/**
 * mail-register — die Sammelstelle data@bikolino.com als Register.
 *
 * Owner-Entscheidung 18.10.2026, 17:15: `data@bikolino.com` ist die einzige
 * Sammelstelle fuer Weiterleitungen aus Fremdpostfaechern. Die erste ist
 * Proton (jbickel2@protonmail.com → data@, eingerichtet 17:12). Yahoo bleibt
 * bei IMAP, der Eingangskanal `+bikosoc` bleibt unberuehrt.
 *
 * Das Modul nimmt die Nachrichten dieses Postfachs in dasselbe Register auf,
 * das am 17.10.2026 fuer juergen.bickel@bikolino.com angelegt wurde: Ordner
 * durchlaufen, Kopfdaten einsammeln, mit `mail/inventar` einordnen. Die
 * Einordnung ist damit nachweislich dieselbe — eine zweite Regelsammlung
 * waere ein zweiter Ort, der auseinanderlaufen kann.
 *
 * Zwei Dinge kommen hinzu, die es beim Geschaeftspostfach nicht gab:
 *
 *   1. **Herkunft.** Eine weitergeleitete Nachricht traegt die Kopfzeile
 *      `X-Pm-Forwarded-From`; der Rueckweg steht in `Return-Path` als
 *      `…@forward.protonmail.ch`. Beides ist ein Beleg, keine Vermutung. Der
 *      urspruengliche Absender bleibt in `From` stehen, das Originaldatum in
 *      `Date` — beide werden uebernommen, nicht das Eintreffdatum bei M365.
 *   2. **Ablage.** Was per Proton kam, wandert in den Ordner `Proton` des
 *      Sammelpostfachs. Geloescht wird nichts.
 *
 * Rein lesend ist dieses Modul nicht — es verschiebt. Es versendet aber
 * keine Mail und loescht keine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { kategorisiere, ausschluss } from '../mail/index.js';
import type {
  Herkunft, RegisterEintrag, RegisterStand, MailboxZugang, RohMail,
} from './types.js';

export type { Herkunft, RegisterEintrag, RegisterStand, MailboxZugang, RohMail } from './types.js';
export { erstelleMailboxZugang } from './graph.js';
export type { MailboxZugangsdaten } from './graph.js';

/** Das Sammelpostfach. */
export const SAMMELSTELLE = 'data@bikolino.com';

/** Ordner, in den Proton-Weiterleitungen wandern. */
export const PROTON_ORDNER = 'Proton';

/** Ablage der Registerdateien in Dropbox, neben dem Register vom 17.10.2026. */
export const DROPBOX_REGISTER = '/bikosoc-reports/transfer/postfach/data';

/** Ordner, die nicht ins Register gehoeren. */
const UEBERGEHEN = /^(deleted items|gel(ö|oe)schte elemente|junk email|junk-e-mail|drafts|entw(ü|ue)rfe|outbox|postausgang|conversation history|unterhaltungsverlauf|sync issues|synchronisierungsprobleme)$/i;

export function ordnerUebergehen(name: string): boolean {
  return UEBERGEHEN.test(name.trim());
}

// ── Herkunft ───────────────────────────────────────────────────────────────

/** Proton-Adressen, die als Systempost des Dienstes gelten. */
const PROTON_ABSENDER = /@(proton\.me|mail\.proton\.me|notify\.proton\.me|protonmail\.(com|ch)|pm\.me)$/i;

/** Rueckweg einer Proton-Weiterleitung. */
const PROTON_RUECKWEG = /@forward\.protonmail\.ch\b/i;

export interface HerkunftBefund {
  herkunft: Herkunft;
  /** Die Kopfzeile, die den Befund traegt. */
  beleg?: string;
  weitergeleitetVon?: string;
  protonBezug: boolean;
}

/**
 * Herkunft aus den Kopfzeilen bestimmen.
 *
 * `proton` nur mit Beleg: entweder `X-Pm-Forwarded-From` oder ein
 * `Return-Path` ueber `forward.protonmail.ch`. Ein Absender bei Proton allein
 * genuegt nicht — der Owner schreibt auch unmittelbar an data@, und das ist
 * keine Weiterleitung.
 */
export function herkunftAusKopf(
  kopf: Record<string, string>, absender = '',
): HerkunftBefund {
  /* Das Verzeichnis aus `graph.ts` schreibt die Namen klein. Wer rohe
     Kopfzeilen hereingibt, soll trotzdem denselben Befund erhalten. */
  const klein: Record<string, string> = {};
  for (const [k, v] of Object.entries(kopf)) klein[k.toLowerCase()] = v;
  const lies = (n: string) => (klein[n] ?? '').trim();
  const protonBezug = PROTON_ABSENDER.test(absender.trim());

  const weitergeleitet = lies('x-pm-forwarded-from');
  if (weitergeleitet) {
    return {
      herkunft: 'proton',
      beleg: `X-Pm-Forwarded-From: ${weitergeleitet}`,
      weitergeleitetVon: weitergeleitet.toLowerCase(),
      protonBezug,
    };
  }

  const rueckweg = lies('return-path');
  if (PROTON_RUECKWEG.test(rueckweg)) {
    /* Der Rueckweg nennt die weiterleitende Adresse in der Form
       `jbickel2=protonmail.com+data=bikolino.com@forward.protonmail.ch`. */
    const treffer = rueckweg.match(/([a-z0-9._%-]+)=([a-z0-9.-]+\.[a-z]{2,})\+/i);
    return {
      herkunft: 'proton',
      beleg: `Return-Path: ${rueckweg}`,
      weitergeleitetVon: treffer ? `${treffer[1]}@${treffer[2]}`.toLowerCase() : undefined,
      protonBezug,
    };
  }

  return { herkunft: 'direkt', protonBezug };
}

/**
 * Datum des Originals aus der Kopfzeile `Date`.
 *
 * Bei einer Weiterleitung liegt das Eintreffdatum bei M365 Minuten oder Tage
 * nach dem Original. Fuer eine Rechnung zaehlt das Original.
 */
export function originalDatum(kopf: Record<string, string>, rueckfallIso: string): string {
  const roh = (kopf['date'] ?? '').trim();
  if (roh) {
    const d = new Date(roh);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return rueckfallIso;
}

// ── Eintrag ────────────────────────────────────────────────────────────────

export function eintragAus(
  mail: RohMail, ordner: string, anhaenge: string[], jetztIso: string, quelle = 'data',
): RegisterEintrag {
  const befund = herkunftAusKopf(mail.kopf, mail.absender);
  const kopfdaten = {
    betreff: mail.betreff, adresse: mail.absender, name: mail.absenderName,
  };
  return {
    quelle,
    herkunft: befund.herkunft,
    beleg: befund.beleg,
    weitergeleitetVon: befund.weitergeleitetVon,
    protonBezug: befund.protonBezug,
    ordner,
    messageId: mail.messageId,
    graphId: mail.id,
    empfangenIso: mail.empfangenIso,
    originalIso: originalDatum(mail.kopf, mail.empfangenIso),
    absender: mail.absender.toLowerCase(),
    absenderName: mail.absenderName,
    betreff: mail.betreff,
    anhaenge,
    register: kategorisiere(kopfdaten),
    ausschluss: ausschluss(kopfdaten),
    erfasstIso: jetztIso,
  };
}

// ── Registerdatei ──────────────────────────────────────────────────────────

export function ladeRegister(pfad: string): RegisterStand {
  try {
    const zeilen = fs.readFileSync(pfad, 'utf-8').split('\n').filter((z) => z.trim());
    return { version: 1, eintraege: zeilen.map((z) => JSON.parse(z) as RegisterEintrag) };
  } catch {
    return { version: 1, eintraege: [] };
  }
}

/** Haengt an. Eine Zeile je Eintrag — so kann kein Lauf die Datei zerreissen. */
export function haengeAnRegister(pfad: string, neue: RegisterEintrag[]): void {
  if (!neue.length) return;
  fs.mkdirSync(path.dirname(pfad), { recursive: true });
  fs.appendFileSync(pfad, neue.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function csvWert(wert: unknown): string {
  const s = String(wert ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return /[",;]/.test(s) ? `"${s}"` : s;
}

/** Register als CSV — dieselben Spalten wie das Register vom 17.10.2026, plus Herkunft. */
export function registerCsv(eintraege: RegisterEintrag[]): string {
  const kopf = ['quelle', 'herkunft', 'weitergeleitet_von', 'proton_bezug', 'ordner',
    'original_datum', 'empfangen', 'absender', 'absender_name', 'betreff',
    'register', 'ausschluss', 'anhaenge'];
  const zeilen = [kopf.join(';')];
  for (const e of [...eintraege].sort((a, b) => a.originalIso.localeCompare(b.originalIso))) {
    zeilen.push([
      e.quelle, e.herkunft, e.weitergeleitetVon ?? '', e.protonBezug ? 'ja' : 'nein',
      e.ordner, e.originalIso.slice(0, 19), e.empfangenIso.slice(0, 19),
      e.absender, e.absenderName, e.betreff,
      e.register.join('|'), e.ausschluss ?? '', e.anhaenge.join('|'),
    ].map(csvWert).join(';'));
  }
  return zeilen.join('\n') + '\n';
}

/**
 * Belegzeilen: Rechnungen, Versicherungen und Vertraege.
 *
 * Dieselbe Auswahl wie bei der Postfach-Vollanalyse — die drei Register, die
 * einen Kostenbezug tragen. Ausgeschlossene Post (Gesundheit, Rundschreiben)
 * bleibt draussen.
 */
export const BELEG_REGISTER = ['rechnungen', 'versicherungen', 'vertraege'] as const;

export function belegEintraege(eintraege: RegisterEintrag[]): RegisterEintrag[] {
  return eintraege.filter((e) => !e.ausschluss
    && e.register.some((r) => (BELEG_REGISTER as readonly string[]).includes(r)));
}

export function belegCsv(eintraege: RegisterEintrag[]): string {
  return registerCsv(belegEintraege(eintraege));
}

// ── Ein Durchlauf ──────────────────────────────────────────────────────────

export interface RegisterLauf {
  ordnerGesehen: number;
  mailsGesehen: number;
  neu: RegisterEintrag[];
  bekannt: number;
  verschoben: number;
  nichtVerschoben: number;
  /** Ordner, die uebergangen wurden, mit Zaehlerstand. */
  uebergangen: Array<{ name: string; anzahl: number }>;
}

export interface RegisterDeps {
  postfach: MailboxZugang;
  registerPfad: string;
  quelle?: string;
  /** Proton-Post in den Ordner verschieben. Vorgabe: ja. */
  verschieben?: boolean;
  now?: Date;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export async function verarbeiteRegisterEinmal(deps: RegisterDeps): Promise<RegisterLauf> {
  const jetzt = (deps.now ?? new Date()).toISOString();
  const quelle = deps.quelle ?? 'data';
  const log = deps.logger;
  const stand = ladeRegister(deps.registerPfad);
  const bekannt = new Set(stand.eintraege.map((e) => e.messageId));

  const lauf: RegisterLauf = {
    ordnerGesehen: 0, mailsGesehen: 0, neu: [], bekannt: 0,
    verschoben: 0, nichtVerschoben: 0, uebergangen: [],
  };

  for (const o of await deps.postfach.ordner()) {
    if (ordnerUebergehen(o.name)) {
      if (o.anzahl > 0) lauf.uebergangen.push({ name: o.name, anzahl: o.anzahl });
      continue;
    }
    lauf.ordnerGesehen++;
    const mails = await deps.postfach.mails(o.id);
    lauf.mailsGesehen += mails.length;

    for (const mail of mails) {
      if (bekannt.has(mail.messageId)) { lauf.bekannt++; continue; }
      const anhaenge = mail.hatAnhaenge
        ? await deps.postfach.anhangsnamen(mail.id).catch(() => [])
        : [];
      const eintrag = eintragAus(mail, o.name, anhaenge, jetzt, quelle);
      lauf.neu.push(eintrag);
      bekannt.add(mail.messageId);

      /* Verschieben erst nach dem Eintrag: Bricht es danach ab, steht die
         Nachricht im Register und liegt noch im alten Ordner — der naechste
         Lauf kennt sie und ruehrt sie nicht mehr an. Das ist der harmlosere
         der beiden Fehler. */
      if (deps.verschieben !== false && eintrag.herkunft === 'proton'
          && o.name !== PROTON_ORDNER) {
        const erg = await deps.postfach.verschiebe(mail.id, PROTON_ORDNER)
          .catch(() => 'nicht_moeglich' as const);
        if (erg === 'verschoben') { lauf.verschoben++; eintrag.ordner = PROTON_ORDNER; }
        else lauf.nichtVerschoben++;
      }

      log?.info(`[mail-register] ${eintrag.herkunft}: ${eintrag.betreff.slice(0, 60)} `
        + `| ${eintrag.absender} | Register: ${eintrag.register.join(',') || '–'}`);
    }
  }

  haengeAnRegister(deps.registerPfad, lauf.neu);
  return lauf;
}

/** Abschnitt „Sammelstelle data@" fuer einen Report. */
export function reportAbschnitt(lauf: RegisterLauf, gesamt: number): string {
  const z: string[] = ['## Sammelstelle data@bikolino.com', ''];
  z.push(`${gesamt} Nachrichten im Register, davon ${lauf.neu.length} in diesem Lauf neu.`);
  z.push('');
  if (lauf.neu.length) {
    z.push('| Original | Herkunft | Absender | Betreff | Register |');
    z.push('|---|---|---|---|---|');
    for (const e of lauf.neu) {
      z.push(`| ${e.originalIso.slice(0, 16).replace('T', ' ')} | ${e.herkunft}`
        + `${e.protonBezug && e.herkunft === 'direkt' ? ' (Proton-Bezug)' : ''} `
        + `| ${e.absender} | ${e.betreff} | ${e.register.join(', ') || '–'} |`);
    }
    z.push('');
  }
  if (lauf.uebergangen.length) {
    z.push('Übergangen: ' + lauf.uebergangen
      .map((o) => `${o.name} (${o.anzahl})`).join(', ') + '.');
    z.push('');
  }
  return z.join('\n');
}
