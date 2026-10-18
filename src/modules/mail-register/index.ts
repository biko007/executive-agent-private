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
import {
  DROPBOX_MAIL_INBOX, ablageOrdner, anhangName, bodyMarkdown, istAuftrag,
  istOwnerAbsender, auftragsDateiname, auftragsInhalt, auftragSchonZugestellt,
  adresseNormal, type Konfiguration, type EingangsMail,
} from '../mail-eingang/index.js';
import type {
  Herkunft, RegisterEintrag, RegisterStand, MailboxZugang, RohMail, Ablagestand,
} from './types.js';
import type { DropboxAdapter } from '../../adapters/dropbox.js';

export type {
  Herkunft, RegisterEintrag, RegisterStand, MailboxZugang, RohMail, Ablagestand,
} from './types.js';
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

// ── Ablage in Dropbox (Owner-Regel 18.10.2026, 20:20) ─────────────────────
//
// Was der Owner weiterleitet, soll der Chat lesen koennen. Deshalb bekommt
// jede Nachricht, die NICHT ueber die Proton-Weiterleitung kam, dieselbe
// Ablage wie der Eingangskanal `+bikosoc`:
//
//   transfer/mail-inbox/JJJJ-MM-TT_HHMM_<betreff>/{mail.eml, body.md, Anhaenge}
//
// Proton-Post bleibt draussen. Sie kommt in Masse und wuerde den
// Austauschordner fluten; fuer sie genuegt das Register.

/** Die Kopfzeile, die Outlook und Apple Mail in einen weitergeleiteten Text setzen. */
const WEITERGELEITET_VON = /^\s*(?:Von|From)\s*:\s*(.+)$/im;

/**
 * Urspruenglicher Absender einer weitergeleiteten Nachricht.
 *
 * Bei einer Proton-Weiterleitung steht er in der Kopfzeile und bleibt im
 * Feld `From`. Leitet der Owner dagegen aus seinem Postfach weiter, ist er
 * selbst der Absender, und das Original steht nur im Text — dort sucht diese
 * Funktion die erste „Von:"-Zeile. Findet sie keine, liefert sie null; dann
 * steht in body.md „nicht erkennbar" und nichts Erfundenes.
 */
export function originalAbsenderAusText(text: string): string | null {
  const treffer = WEITERGELEITET_VON.exec(String(text ?? ''));
  if (!treffer) return null;
  const zeile = treffer[1].trim();
  const adresse = zeile.match(/<([^>]+@[^>]+)>/) ?? zeile.match(/([^\s<>,;]+@[^\s<>,;]+)/);
  if (adresse) return adresseNormal(adresse[1]);
  return zeile.length >= 3 ? zeile.slice(0, 120) : null;
}

export function ladeAblagestand(pfad: string): Ablagestand {
  try {
    const roh = JSON.parse(fs.readFileSync(pfad, 'utf-8'));
    if (roh && typeof roh.ordner === 'object') return { version: 1, ordner: { ...roh.ordner } };
  } catch { /* erster Lauf */ }
  return { version: 1, ordner: {} };
}

export function speichereAblagestand(pfad: string, stand: Ablagestand): void {
  fs.mkdirSync(path.dirname(pfad), { recursive: true });
  fs.writeFileSync(pfad, JSON.stringify(stand, null, 2), 'utf-8');
}

/**
 * Gehoert die Nachricht in die Dropbox-Ablage?
 *
 * Nein bei Proton-Weiterleitungen (Abschnitt 2 des Auftrags) und nein, wenn
 * dieselbe Message-ID schon abgelegt ist.
 */
export function ablageNoetig(eintrag: RegisterEintrag, stand: Ablagestand): boolean {
  if (eintrag.herkunft === 'proton') return false;
  return !stand.ordner[eintrag.messageId];
}

export interface AblageDeps {
  postfach: MailboxZugang;
  dropbox: DropboxAdapter;
  homeDir: string;
  konfiguration: Konfiguration;
  ablageStandPfad: string;
  inboxDir?: string;
  /**
   * Schon registrierte Nachrichten ab diesem Zeitpunkt nachtragen. Gedacht
   * fuer den Umstieg: Was vor dieser Erweiterung nur im Register stand, soll
   * einmal auch in die Ablage.
   */
  nachtragenSeitIso?: string;
}

export interface AblageErgebnis {
  messageId: string;
  betreff: string;
  ablagePfad: string;
  dateien: string[];
  originalAbsender: string | null;
  auftragsDatei?: string;
  hinweis?: string;
}

/**
 * Einen freien Ablageordner vergeben. Zwei Nachrichten derselben Minute mit
 * demselben Betreff bekaemen denselben Ordner und wuerden sich ueberschreiben;
 * die Vergabe wird deshalb je Message-ID festgehalten.
 */
export function vergebeAblageordner(
  gewuenscht: string, messageId: string, stand: Ablagestand,
): string {
  const schon = stand.ordner[messageId];
  if (schon) return schon;
  const belegt = (n: string) => Object.entries(stand.ordner)
    .some(([id, o]) => o === n && id !== messageId);
  let name = gewuenscht;
  for (let i = 2; belegt(name) && i < 100; i++) name = `${gewuenscht}-${i}`;
  return name;
}

/** Eine Nachricht ablegen: Anhaenge, mail.eml, body.md — und ggf. Auftragsdatei. */
export async function legeAb(
  mail: RohMail, eintrag: RegisterEintrag, deps: AblageDeps, stand: Ablagestand,
): Promise<AblageErgebnis> {
  /* Ordnername aus dem Eintreffzeitpunkt — wie beim Eingangskanal `+bikosoc`.
     Bei einer Weiterleitung liegt das Datum des Originals Tage zurueck; die
     Ablage soll aber zeigen, wann die Nachricht hier ankam. Das Original steht
     im Text und sein Absender als Kopfpunkt in body.md. */
  const ordnerName = vergebeAblageordner(
    ablageOrdner(new Date(mail.empfangenIso), eintrag.betreff), eintrag.messageId, stand);
  const ziel = `${DROPBOX_MAIL_INBOX}/${ordnerName}`;

  const text = await deps.postfach.text(mail.id).catch(() => '');
  const roh = await deps.postfach.mime(mail.id);
  const anhaenge = mail.hatAnhaenge ? await deps.postfach.anhaenge(mail.id) : [];

  const namen: string[] = [];
  for (const [i, a] of anhaenge.entries()) {
    const name = anhangName(a.name, i + 1);
    await deps.dropbox.uploadFile({
      path: `${ziel}/${name}`, body: a.bytes,
      contentType: a.contentType || 'application/octet-stream',
    });
    namen.push(name);
  }

  /* Bei einer Weiterleitung des Owners ist er selbst der Absender; das
     Original steht nur im Text. Die Kopfzeile der Proton-Weiterleitung hat
     Vorrang, falls sie doch einmal vorliegt. */
  const originalAbsender = eintrag.weitergeleitetVon
    ?? originalAbsenderAusText(text);

  const eingang: EingangsMail = {
    id: mail.id, messageId: mail.messageId, empfangenIso: mail.empfangenIso,
    absender: mail.absender, to: [SAMMELSTELLE], cc: [], betreff: mail.betreff,
    text, hatAnhaenge: mail.hatAnhaenge,
  };
  const zusatz = [`**Ursprünglicher Absender:** ${originalAbsender ?? 'nicht erkennbar'}`];

  await deps.dropbox.uploadFile({
    path: `${ziel}/mail.eml`, body: Buffer.from(roh, 'utf-8'), contentType: 'message/rfc822',
  });
  await deps.dropbox.uploadFile({
    path: `${ziel}/body.md`,
    body: Buffer.from(bodyMarkdown(eingang, namen, zusatz), 'utf-8'),
    contentType: 'text/markdown; charset=utf-8',
  });

  const ergebnis: AblageErgebnis = {
    messageId: eintrag.messageId, betreff: eintrag.betreff, ablagePfad: ziel,
    dateien: [...namen, 'mail.eml', 'body.md'], originalAbsender,
  };

  /* Auftrag nur vom Owner. Ein fremder Absender wird abgelegt und
     registriert, aber nie ausgefuehrt. */
  if (istAuftrag(eintrag.betreff)) {
    if (!istOwnerAbsender(eintrag.absender, deps.konfiguration.ownerAbsender)) {
      ergebnis.hinweis = 'Betreff „Auftrag:", aber fremder Absender — nur abgelegt';
    } else {
      const inboxDir = deps.inboxDir ?? path.join(deps.homeDir, 'inbox');
      const dateiname = auftragsDateiname(new Date(mail.empfangenIso), eintrag.betreff);
      if (auftragSchonZugestellt(inboxDir, dateiname)) {
        ergebnis.hinweis = 'Auftragsdatei lag bereits in ~/inbox — nicht erneut zugestellt';
      } else {
        fs.mkdirSync(inboxDir, { recursive: true });
        const part = path.join(inboxDir, `.${dateiname}.part`);
        fs.writeFileSync(part, auftragsInhalt(eingang, ziel, namen), 'utf-8');
        fs.renameSync(part, path.join(inboxDir, dateiname));
        ergebnis.auftragsDatei = path.join(inboxDir, dateiname);
      }
    }
  }

  stand.ordner[eintrag.messageId] = ordnerName;
  return ergebnis;
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
  /** Nach Dropbox abgelegte Nachrichten (alles ausser Proton). */
  abgelegt: AblageErgebnis[];
  /** Nachtraeglich abgelegte, schon vorher registrierte Nachrichten. */
  nachgetragen: AblageErgebnis[];
}

export interface RegisterDeps {
  postfach: MailboxZugang;
  registerPfad: string;
  quelle?: string;
  /** Proton-Post in den Ordner verschieben. Vorgabe: ja. */
  verschieben?: boolean;
  /**
   * Zusaetzliche Ablage in Dropbox fuer alles, was nicht per Proton kam
   * (Owner-Regel 18.10.2026). Fehlt sie, laeuft nur das Register wie bisher.
   */
  ablage?: Omit<AblageDeps, 'postfach'>;
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
    verschoben: 0, nichtVerschoben: 0, uebergangen: [], abgelegt: [], nachgetragen: [],
  };

  const ablageDeps = deps.ablage
    ? { ...deps.ablage, postfach: deps.postfach } as AblageDeps : null;
  const ablagestand = ablageDeps ? ladeAblagestand(ablageDeps.ablageStandPfad) : null;

  /* Nachtragen: Was vor dieser Erweiterung nur im Register stand, einmal auch
     ablegen. Die Ordnernamen sind deterministisch, ein Upload ueberschreibt —
     ein zweiter Lauf schadet deshalb nicht. */
  if (ablageDeps?.nachtragenSeitIso && ablagestand) {
    const grenze = ablageDeps.nachtragenSeitIso;
    for (const alt of stand.eintraege) {
      if (alt.herkunft === 'proton') continue;
      if (alt.originalIso < grenze && alt.empfangenIso < grenze) continue;
      if (!ablageNoetig(alt, ablagestand)) continue;
      const ersatz: RohMail = {
        id: alt.graphId, messageId: alt.messageId, empfangenIso: alt.empfangenIso,
        absender: alt.absender, absenderName: alt.absenderName, betreff: alt.betreff,
        hatAnhaenge: alt.anhaenge.length > 0, kopf: {},
      };
      try {
        const erg = await legeAb(ersatz, alt, ablageDeps, ablagestand);
        lauf.nachgetragen.push(erg);
        log?.info(`[mail-register] nachgetragen: ${alt.betreff.slice(0, 50)} → ${erg.ablagePfad}`);
      } catch (e: any) {
        log?.warn(`[mail-register] Nachtrag fehlgeschlagen (${alt.betreff.slice(0, 40)}): `
          + `${e?.message ?? e}`);
      }
    }
    speichereAblagestand(ablageDeps.ablageStandPfad, ablagestand);
  }

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

      /* Ablage vor dem Verschieben und nach dem Registereintrag. Proton
         bleibt draussen — dafuer sorgt ablageNoetig(). */
      if (ablageDeps && ablagestand && ablageNoetig(eintrag, ablagestand)) {
        try {
          const erg = await legeAb(mail, eintrag, ablageDeps, ablagestand);
          lauf.abgelegt.push(erg);
          speichereAblagestand(ablageDeps.ablageStandPfad, ablagestand);
          log?.info(`[mail-register] abgelegt: ${erg.ablagePfad}`
            + `${erg.auftragsDatei ? ' + Auftrag ' + path.basename(erg.auftragsDatei) : ''}`);
        } catch (e: any) {
          log?.warn(`[mail-register] Ablage fehlgeschlagen (${eintrag.betreff.slice(0, 40)}): `
            + `${e?.message ?? e}`);
        }
      }

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
  const abgelegt = [...(lauf.abgelegt ?? []), ...(lauf.nachgetragen ?? [])];
  if (abgelegt.length) {
    z.push('**In Dropbox abgelegt** (alles ausser Proton):');
    z.push('');
    for (const a of abgelegt) {
      z.push(`- \`${a.ablagePfad}\` — ${a.dateien.length} Datei(en)`
        + `${a.auftragsDatei ? `, Auftrag \`${path.basename(a.auftragsDatei)}\`` : ''}`
        + `${a.hinweis ? ` (${a.hinweis})` : ''}`);
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
