/**
 * neuheiten/mail-lauf — der Mailteil des Stundenlaufs (juergen.bickel@ und Yahoo).
 *
 * Bis 27.10.2026 ~11:00 stand diese Logik in `scripts/mail-register-stunde.ts`.
 * Mit dem Dokumenten-Register (Owner 10:45) melden Mails und Dokumente
 * gemeinsam; deshalb liegt der Lauf jetzt hier und liefert nur Ergebnisse —
 * Report und Telegram macht `scripts/neuheiten-stunde.ts`.
 *
 * Nur lesend in den Postfaechern, siehe `mail-register/lesend.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { erstelleMailboxZugang, registerCsv, ladeRegister } from '../mail-register/index.js';
import {
  nurLesendGraph, erstelleImapQuelle, registriereLesend, bekannteIdsAus,
  type LeseQuelle, type LeseLauf, type GeseheneMail,
} from '../mail-register/lesend.js';
import {
  kopfAusschluss, bewerte, vorschlagText, kurzId, maskiere,
  type Regelwerk, type VorschlagCode,
} from '../mail-register/relevanz.js';
import { ladeJson, schreibeJson, type NeuheitZeile } from './bericht.js';
import type { Element } from '../sekretariat/element.js';
import type { DropboxAdapter } from '../../adapters/dropbox.js';

export const POSTFACH: Record<string, string> = {
  m365: 'juergen.bickel@bikolino.com', yahoo: 'jbickel2@yahoo.de',
};

/** Beginn des Registers fuer beide Postfaecher (Auftrag 27.10.2026). */
export const MAIL_START = '2026-10-18T00:00:00.000Z';
/** Rueckblick je Stundenlauf: spaet eintreffende oder verschobene Mails. */
const UEBERLAPPUNG_MS = 48 * 3_600_000;
/** Neben data-register.csv, eine Ebene hoeher als `data/`. */
export const DROPBOX_POSTFACH = '/bikosoc-reports/transfer/postfach';

export interface MailVorschlag {
  id: string;
  messageId: string;
  quelle: string;
  postfach: string;
  ordner: string;
  datum: string;
  absender: string;
  absenderName: string;
  betreff: string;
  objekt?: string;
  thema?: string;
  vorschlag: VorschlagCode;
  text: string;
  grund: string;
  erstelltIso: string;
}

export interface MailLaufOptionen {
  zustand: string;
  regeln: Regelwerk;
  env: (k: string) => string;
  probe?: boolean;
  nachlauf?: boolean;
  nur?: string;
  jetzt?: Date;
  dropbox?: DropboxAdapter | null;
  log?: (m: string) => void;
  warn?: (m: string) => void;
  /** Fuer Tests: eigene Quellen statt Graph/IMAP. */
  quellen?: Array<{ name: 'm365' | 'yahoo'; zugang: () => LeseQuelle }>;
  /**
   * Sekretariat (Spec v1, 27.10.2026): statt der Regelbewertung jede noch
   * unbekannte Mail als Element sammeln — mit Text (bis 3.000 Zeichen) und
   * Thread-IDs. `bekannt` sagt, was das Sekretariat schon hat.
   */
  sekretariat?: { bekannt: (kennung: string) => boolean };
}

export interface MailLaufErgebnis {
  /** Nur im Sekretariat-Modus: gesammelte Neuheiten. */
  elemente?: Element[];
  vorschlaege: MailVorschlag[];
  laeufe: LeseLauf[];
  zaehler: Record<string, number>;
  fehler: string[];
  zusammen: string;
}

export function mailZeile(v: MailVorschlag): NeuheitZeile {
  return {
    kennung: v.id, art: 'Mail', datum: v.datum,
    quelle: v.quelle === 'm365' ? 'juergen.bickel@' : 'Yahoo',
    von: `${v.absenderName || v.absender} (${v.absender})`, titel: v.betreff,
    vorschlag: v.vorschlag, text: v.text,
  };
}

function standardQuellen(o: MailLaufOptionen): Array<{ name: 'm365' | 'yahoo'; zugang: () => LeseQuelle }> {
  const { env } = o;
  const warn = o.warn ?? (() => {});
  const raus: Array<{ name: 'm365' | 'yahoo'; zugang: () => LeseQuelle }> = [];
  if (!o.nur || o.nur === 'm365' || o.nur === 'mail') {
    if (env('M365_TENANT_ID') && env('M365_CLIENT_ID') && env('M365_CLIENT_SECRET')) {
      const z = {
        tenantId: env('M365_TENANT_ID'), clientId: env('M365_CLIENT_ID'),
        clientSecret: env('M365_CLIENT_SECRET'), postfach: POSTFACH.m365,
      };
      raus.push({ name: 'm365', zugang: () => nurLesendGraph(erstelleMailboxZugang(z), z) });
    } else warn('neuheiten: M365-Zugang fehlt — juergen.bickel@ übersprungen.');
  }
  if (!o.nur || o.nur === 'yahoo' || o.nur === 'mail') {
    if (env('YAHOO_USER') && env('YAHOO_APP_PASSWORD')) {
      raus.push({
        name: 'yahoo',
        zugang: () => erstelleImapQuelle({
          host: env('YAHOO_IMAP_HOST') || 'imap.mail.yahoo.com',
          port: Number(env('YAHOO_IMAP_PORT') || 993),
          user: env('YAHOO_USER'), pass: env('YAHOO_APP_PASSWORD'),
        }),
      });
    } else warn('neuheiten: Yahoo-Zugang fehlt — Yahoo übersprungen.');
  }
  return raus;
}

/**
 * Ein Durchlauf ueber beide Postfaecher. Schreibt Register, Bewertung, Stand
 * und CSV (ausser bei `probe`); meldet nichts.
 */
export async function mailLauf(o: MailLaufOptionen): Promise<MailLaufErgebnis> {
  const log = o.log ?? (() => {});
  const warn = o.warn ?? (() => {});
  const jetzt = o.jetzt ?? new Date();
  const P = {
    data: path.join(o.zustand, 'data.jsonl'),
    m365: path.join(o.zustand, 'm365.jsonl'),
    yahoo: path.join(o.zustand, 'yahoo.jsonl'),
    vorschlaege: path.join(o.zustand, 'vorschlaege.jsonl'),
    bewertet: path.join(o.zustand, 'bewertet.json'),
    stand: path.join(o.zustand, 'stunde-stand.json'),
  };
  const probeDatei = (q: string) => path.join(os.tmpdir(), `mail-register-probe-${process.pid}-${q}.jsonl`);

  const stand = ladeJson<{ letzterLauf: Record<string, string> }>(P.stand, { letzterLauf: {} });
  const bewertet = ladeJson<{ version: 1; ids: Record<string, string> }>(P.bewertet, { version: 1, ids: {} });
  const bekannte = bekannteIdsAus([P.data, P.m365, P.yahoo]);
  const fehler: string[] = [];
  const laeufe: LeseLauf[] = [];
  const offen: Array<{ g: GeseheneMail; zugang: LeseQuelle }> = [];
  const zugaenge: LeseQuelle[] = [];
  const gesendet = new Set<string>();
  /* Ohne die gesendeten IDs ist „Antwort auf eigene Mail" nicht pruefbar;
     dann wird ein „nicht relevant" nicht festgeschrieben, sondern spaeter wiederholt. */
  let gesendetVollstaendig = true;
  const sentSeit = new Date(jetzt.getTime() - 90 * 86_400_000).toISOString();

  for (const q of o.quellen ?? standardQuellen(o)) {
    const zugang = q.zugang();
    zugaenge.push(zugang);
    const letzter = stand.letzterLauf[q.name];
    const seit = o.nachlauf || !letzter ? MAIL_START
      : new Date(Math.max(Date.parse(MAIL_START), Date.parse(letzter) - UEBERLAPPUNG_MS)).toISOString();
    try {
      const lauf = await registriereLesend({
        quelle: q.name, postfach: zugang, bekannteIds: bekannte, seitIso: seit, now: jetzt,
        /* Probe: Register in eine Wegwerfdatei, damit nichts dauerhaft entsteht. */
        registerPfad: o.probe ? probeDatei(q.name) : P[q.name],
        logger: { info: log, warn },
      });
      laeufe.push(lauf);
      for (const g of lauf.gesehen) offen.push({ g, zugang });
      try {
        for (const id of await zugang.gesendeteIds(sentSeit)) gesendet.add(id.toLowerCase());
      } catch (e: any) {
        gesendetVollstaendig = false;
        fehler.push(`${POSTFACH[q.name]}: gesendete Mails nicht lesbar (${String(e?.message ?? e).slice(0, 120)})`);
      }
      if (!o.probe) stand.letzterLauf[q.name] = jetzt.toISOString();
    } catch (e: any) {
      fehler.push(`${POSTFACH[q.name]}: nicht lesbar (${String(e?.message ?? e).slice(0, 160)})`);
      warn(`neuheiten ${q.name} Fehler: ${e?.message ?? e}`);
    }
  }

  if (o.sekretariat) {
    /* Sekretariat: jede unbekannte Mail genau einmal sammeln. Text nur, wenn
       der Kopf nicht schon offensichtlich ausscheidet (Newsletter, Paket …) —
       das spart Abrufe; die endgueltige Entscheidung trifft das Sekretariat. */
    const OFFENSICHTLICH = new Set(['eigene Mail', 'Gesundheit', 'Newsletter', 'Paketstatus', 'Systemmeldung', 'Social']);
    const elemente: Element[] = [];
    const anhaenge = new Map<string, string[]>();
    for (const l of laeufe) for (const e of l.neu) anhaenge.set(e.messageId.trim(), e.anhaenge);
    let textFehlerS = 0;
    for (const { g, zugang } of offen) {
      const mid = g.mail.messageId.trim();
      const kennung = kurzId(mid);
      if (o.sekretariat.bekannt(kennung) || elemente.some((x) => x.kennung === kennung)) continue;
      const k = g.mail.kopf;
      const grund = kopfAusschluss({ absender: g.mail.absender, absenderName: g.mail.absenderName,
        betreff: g.mail.betreff, ordner: g.ordner, kopf: k }, o.regeln);
      let text = '';
      if (!grund || !OFFENSICHTLICH.has(grund)) {
        try { text = (await zugang.text(g.mail.id)).slice(0, 3000); } catch { textFehlerS++; continue; }
      }
      const thread = `${k['references'] ?? ''} ${k['in-reply-to'] ?? ''}`.match(/<[^<>\s]+>/g) ?? [];
      elemente.push({
        typ: 'mail', kennung, quelle: g.quelle, datum: g.mail.empfangenIso, titel: g.mail.betreff,
        von: g.mail.absender.toLowerCase(), vonName: g.mail.absenderName, text, anhaenge: anhaenge.get(mid),
        messageId: mid, threadIds: [...new Set(thread)], ordner: g.ordner, kopf: k,
      });
    }
    for (const z of zugaenge) await z.schliessen();
    if (textFehlerS) fehler.push(`${textFehlerS} Mailtext(e) nicht lesbar — werden im nächsten Lauf erneut gesammelt`);
    if (!o.probe) schreibeJson(P.stand, stand);
    const zusammen = `mail: ${laeufe.map((l) => `${l.quelle} ${l.mailsGesehen} gesehen/${l.neu.length} neu`).join(', ')}; `
      + `${elemente.length} für das Sekretariat`;
    if (o.probe) for (const q of ['m365', 'yahoo']) { try { fs.unlinkSync(probeDatei(q)); } catch { /* keine */ } }
    else await csvHochladen();
    return { elemente, vorschlaege: [], laeufe, zaehler: {}, fehler, zusammen };
  }

  /* Relevanz: jede Nachricht genau einmal, auch wenn sie in beiden Postfaechern liegt. */
  const vorschlaege: MailVorschlag[] = [];
  const zaehler: Record<string, number> = {};
  let textFehler = 0;
  for (const { g, zugang } of offen) {
    const mid = g.mail.messageId.trim();
    if (bewertet.ids[mid]) continue;
    const eingang = {
      absender: g.mail.absender, absenderName: g.mail.absenderName, betreff: g.mail.betreff,
      ordner: g.ordner, kopf: g.mail.kopf,
    };
    const aus = kopfAusschluss(eingang, o.regeln);
    let ergebnis;
    if (aus) ergebnis = { relevant: false, grund: aus } as const;
    else {
      /* Scheitert der Text, wird die Mail nicht bewertet und im naechsten
         Lauf erneut versucht — sonst bliebe ein „kein Merkmal" fuer immer stehen. */
      let text: string;
      try { text = await zugang.text(g.mail.id); } catch {
        textFehler++;
        continue;
      }
      ergebnis = bewerte({ ...eingang, text }, o.regeln, gesendet);
      if (!ergebnis.relevant && !gesendetVollstaendig) continue;
    }
    bewertet.ids[mid] = ergebnis.relevant ? 'relevant' : ergebnis.grund;
    if (!ergebnis.relevant) { zaehler[ergebnis.grund] = (zaehler[ergebnis.grund] ?? 0) + 1; continue; }
    const b = ergebnis as ReturnType<typeof bewerte>;
    vorschlaege.push({
      id: kurzId(mid), messageId: mid, quelle: g.quelle, postfach: POSTFACH[g.quelle],
      ordner: g.ordner, datum: g.mail.empfangenIso, absender: g.mail.absender.toLowerCase(),
      absenderName: maskiere(g.mail.absenderName), betreff: maskiere(g.mail.betreff),
      objekt: b.objekt, thema: b.thema, vorschlag: b.vorschlag, text: vorschlagText(b),
      grund: b.grund, erstelltIso: jetzt.toISOString(),
    });
  }
  for (const z of zugaenge) await z.schliessen();
  if (textFehler) fehler.push(`${textFehler} Mailtext(e) nicht lesbar — werden im nächsten Lauf erneut bewertet`);

  const zusammen = `mail: ${laeufe.map((l) => `${l.quelle} ${l.mailsGesehen} gesehen/${l.neu.length} neu`).join(', ')}; `
    + `${vorschlaege.length} relevant`;

  if (o.probe) {
    for (const q of ['m365', 'yahoo']) { try { fs.unlinkSync(probeDatei(q)); } catch { /* keine */ } }
    return { vorschlaege, laeufe, zaehler, fehler, zusammen };
  }

  schreibeJson(P.bewertet, bewertet);
  schreibeJson(P.stand, stand);
  if (vorschlaege.length) {
    fs.appendFileSync(P.vorschlaege, vorschlaege.map((v) => JSON.stringify(v)).join('\n') + '\n', 'utf-8');
  }

  await csvHochladen();
  return { vorschlaege, laeufe, zaehler, fehler, zusammen };

  /* CSV nur, wenn das Register gewachsen ist. */
  async function csvHochladen(): Promise<void> {
  for (const l of laeufe.filter((x) => x.neu.length)) {
    const name = `${l.quelle}-register.csv`;
    /* Betreff gekuerzt um IBAN/Kontonummern, bevor er Dropbox erreicht. */
    const inhalt = registerCsv(ladeRegister(P[l.quelle as 'm365' | 'yahoo']).eintraege
      .map((e) => ({ ...e, betreff: maskiere(e.betreff), absenderName: maskiere(e.absenderName) })));
    fs.writeFileSync(path.join(o.zustand, name), inhalt, 'utf-8');
    if (o.dropbox) {
      await o.dropbox.uploadFile({
        path: `${DROPBOX_POSTFACH}/${name}`, body: Buffer.from(inhalt, 'utf-8'),
        contentType: 'text/csv; charset=utf-8',
      }).then(() => log(`${DROPBOX_POSTFACH}/${name} (${Buffer.byteLength(inhalt)} B)`))
        .catch((e: any) => { fehler.push(`CSV ${name} nicht hochgeladen: ${e?.message ?? e}`); });
    }
  }
  }
}
