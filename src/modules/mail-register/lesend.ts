/**
 * mail-register/lesend — Register fuer juergen.bickel@ und Yahoo, nur lesend.
 *
 * Auftrag 27.10.2026 (Owner 10:26): beide Postfaecher stuendlich pruefen.
 * Anders als die Sammelstelle data@ darf hier nichts im Postfach geschehen:
 * kein Verschieben, kein Lesevermerk, keine Ablage. Darum gibt es eine eigene,
 * schmale Schnittstelle `LeseQuelle` — sie kennt nur Lesebefehle. Was nicht
 * darin steht, kann der Lauf nicht aufrufen.
 *
 *   Graph  `nurLesendGraph()` reicht aus dem vorhandenen Zugang nur die
 *          lesenden Methoden durch; `verschiebe`, `mime`, `anhaenge` bleiben
 *          draussen.
 *   IMAP   `erstelleImapQuelle()` oeffnet jeden Ordner mit `readOnly: true`
 *          (EXAMINE). Der Server setzt dann keinen Lesevermerk, auch nicht
 *          beim Abruf des Textes. Ein statischer Test haelt verändernde
 *          IMAP-Befehle aus dieser Datei heraus.
 */

import { ImapFlow } from 'imapflow';
import { eintragAus, ladeRegister, haengeAnRegister, ordnerUebergehen } from './index.js';
import { textAusKoerper } from '../mail-eingang/index.js';
import { graphGet } from '../../shared/m365/index.js';
import type { MailboxZugang, RohMail, RegisterEintrag } from './types.js';
import type { MailboxZugangsdaten } from './graph.js';

/** Was der stuendliche Lauf von einem Postfach braucht — nur Lesen. */
export interface LeseQuelle {
  ordner(): Promise<Array<{ id: string; name: string; anzahl: number }>>;
  mails(ordnerId: string, seitIso?: string): Promise<RohMail[]>;
  anhangsnamen(id: string): Promise<string[]>;
  text(id: string): Promise<string>;
  /** Message-IDs gesendeter Mails — um Antworten darauf zu erkennen. */
  gesendeteIds(seitIso: string): Promise<string[]>;
  /** Verbindung schliessen (IMAP); bei Graph ohne Wirkung. */
  schliessen(): Promise<void>;
}

/** Gesendete Ordner: gelesen nur fuer die Antworterkennung, nicht registriert. */
const GESENDET = /^(sent items|gesendete elemente|gesendet|sent)$/i;

/** Ordner, die das Register der beiden Postfaecher uebergeht. */
export function ordnerAusgeschlossen(name: string): boolean {
  const blatt = name.split('/').pop() ?? name;
  return ordnerUebergehen(blatt) || GESENDET.test(blatt.trim());
}

// ── Graph ──────────────────────────────────────────────────────────────────

/**
 * Nur die lesenden Methoden eines Graph-Zugangs. Das Objekt hat keine
 * Methode, mit der sich etwas im Postfach aendern liesse.
 */
export function nurLesendGraph(
  zugang: MailboxZugang, z: MailboxZugangsdaten,
  hole: (url: string) => Promise<any> = (url) => graphGet(z.tenantId, z.clientId, z.clientSecret, url),
): LeseQuelle {
  const basis = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(z.postfach)}`;
  return {
    ordner: () => zugang.ordner(),
    mails: (id, seit) => zugang.mails(id, seit),
    anhangsnamen: (id) => zugang.anhangsnamen(id),
    text: (id) => zugang.text(id),
    async gesendeteIds(seitIso) {
      const raus: string[] = [];
      let url: string | null = `${basis}/mailFolders/sentitems/messages?$top=100`
        + `&$select=internetMessageId&$filter=sentDateTime ge ${seitIso}`;
      while (url) {
        const seite: any = await hole(url);
        for (const m of seite?.value ?? []) if (m?.internetMessageId) raus.push(String(m.internetMessageId));
        url = typeof seite?.['@odata.nextLink'] === 'string' ? seite['@odata.nextLink'] : null;
      }
      return raus;
    },
    async schliessen() { /* zustandslos */ },
  };
}

// ── IMAP (Yahoo) ───────────────────────────────────────────────────────────

/** Die Yahoo-Ordner aus dem Auftrag. „Bulk" (Spam) bleibt draussen. */
export const YAHOO_ORDNER = ['INBOX', 'Technik-Backups', 'Lesestoff', 'Angebote', 'Soziale Updates'];

export interface ImapZugangsdaten {
  host: string;
  port: number;
  user: string;
  pass: string;
  ordner?: string[];
}

/** Kopfzeilen aus dem Rohtext, Schluessel klein; Folgezeilen werden angehaengt. */
export function kopfAusRoh(roh: string): Record<string, string> {
  const raus: Record<string, string> = {};
  let letzter = '';
  for (const zeile of String(roh ?? '').split(/\r?\n/)) {
    if (/^\s/.test(zeile) && letzter) { raus[letzter] += ' ' + zeile.trim(); continue; }
    const t = zeile.match(/^([!-9;-~]+):\s*(.*)$/);
    if (!t) continue;
    letzter = t[1].toLowerCase();
    raus[letzter] = raus[letzter] ? `${raus[letzter]}\n${t[2]}` : t[2];
  }
  return raus;
}

/** Erster Textteil (plain vor html) aus einer IMAP-Bodystructure. */
export function textTeil(knoten: any): { part: string; html: boolean } | null {
  const suche = (n: any, typ: string): string | null => {
    if (!n) return null;
    if (Array.isArray(n.childNodes) && n.childNodes.length) {
      for (const k of n.childNodes) { const t = suche(k, typ); if (t) return t; }
      return null;
    }
    if (String(n.type ?? '').toLowerCase() === typ
      && String(n.disposition ?? '').toLowerCase() !== 'attachment') return n.part ?? '1';
    return null;
  };
  const plain = suche(knoten, 'text/plain');
  if (plain) return { part: plain, html: false };
  const html = suche(knoten, 'text/html');
  return html ? { part: html, html: true } : null;
}

function anhangsnamenAus(knoten: any): string[] {
  const raus: string[] = [];
  const geh = (n: any) => {
    if (!n) return;
    for (const k of n.childNodes ?? []) geh(k);
    const name = n.dispositionParameters?.filename ?? n.parameters?.name;
    if (name && String(n.disposition ?? '').toLowerCase() !== 'inline') raus.push(String(name));
  };
  geh(knoten);
  return raus;
}

const KOPF_FELDER = ['date', 'list-unsubscribe', 'precedence', 'in-reply-to', 'references',
  'return-path', 'x-pm-forwarded-from', 'auto-submitted'];

/**
 * Yahoo ueber IMAP, nur lesend. `id` einer Nachricht ist `<ordner>\u0000<uid>`.
 * Der Client wird bei Bedarf verbunden und mit `schliessen()` beendet.
 */
export function erstelleImapQuelle(z: ImapZugangsdaten): LeseQuelle {
  let client: ImapFlow | null = null;
  const verbinde = async (): Promise<ImapFlow> => {
    if (client) return client;
    const c = new ImapFlow({
      host: z.host, port: z.port, secure: true, auth: { user: z.user, pass: z.pass },
      logger: false, socketTimeout: 120000,
    });
    c.on('error', () => { /* der laufende Befehl wirft selbst */ });
    await c.connect();
    client = c;
    return c;
  };
  const zerlege = (id: string) => {
    const i = id.lastIndexOf('\u0000');
    return { pfad: id.slice(0, i), uid: id.slice(i + 1) };
  };
  /** Ordner immer nur lesend oeffnen (EXAMINE). */
  const imOrdner = async <T>(pfad: string, f: (c: ImapFlow) => Promise<T>): Promise<T> => {
    const c = await verbinde();
    const sperre = await c.getMailboxLock(pfad, { readOnly: true });
    try { return await f(c); } finally { sperre.release(); }
  };
  const erlaubt = new Set((z.ordner ?? YAHOO_ORDNER).map((o) => o.toLowerCase()));

  return {
    async ordner() {
      const c = await verbinde();
      const raus: Array<{ id: string; name: string; anzahl: number }> = [];
      for (const o of await c.list()) {
        if (!erlaubt.has(o.path.toLowerCase())) continue;
        raus.push({ id: o.path, name: o.path, anzahl: 0 });
      }
      return raus;
    },

    async mails(pfad, seitIso) {
      return imOrdner(pfad, async (c) => {
        const seit = seitIso ? new Date(seitIso) : new Date('1990-01-01');
        const uids = await c.search({ since: seit }, { uid: true });
        const raus: RohMail[] = [];
        if (!uids || !uids.length) return raus;
        for await (const m of c.fetch(uids, {
          uid: true, envelope: true, internalDate: true, bodyStructure: true,
          headers: KOPF_FELDER,
        }, { uid: true })) {
          const kopf = kopfAusRoh(m.headers?.toString('utf-8') ?? '');
          const datum = m.internalDate ?? m.envelope?.date;
          const iso = datum ? new Date(datum).toISOString() : new Date().toISOString();
          /* IMAP-SINCE rechnet in ganzen Tagen; genauer schneidet hier. */
          if (seitIso && iso < seitIso) continue;
          const anh = anhangsnamenAus(m.bodyStructure);
          raus.push({
            id: `${pfad}\u0000${m.uid}`,
            messageId: String(m.envelope?.messageId ?? `${pfad}#${m.uid}`),
            empfangenIso: iso,
            absender: String(m.envelope?.from?.[0]?.address ?? ''),
            absenderName: String(m.envelope?.from?.[0]?.name ?? ''),
            betreff: String(m.envelope?.subject ?? ''),
            hatAnhaenge: anh.length > 0,
            kopf,
          });
        }
        return raus.sort((a, b) => b.empfangenIso.localeCompare(a.empfangenIso));
      });
    },

    async anhangsnamen(id) {
      const { pfad, uid } = zerlege(id);
      return imOrdner(pfad, async (c) => {
        const m = await c.fetchOne(uid, { uid: true, bodyStructure: true }, { uid: true });
        return m ? anhangsnamenAus(m.bodyStructure) : [];
      });
    },

    async text(id) {
      const { pfad, uid } = zerlege(id);
      return imOrdner(pfad, async (c) => {
        const m = await c.fetchOne(uid, { uid: true, bodyStructure: true }, { uid: true });
        const teil = m ? textTeil(m.bodyStructure) : null;
        if (!teil) return '';
        /* download() holt mit BODY.PEEK und decodiert Transfer-Kodierung
           und Zeichensatz. Begrenzt, weil nur Stichworte gesucht werden. */
        const { content } = await c.download(uid, teil.part, { uid: true, maxBytes: 100_000 });
        const stuecke: Buffer[] = [];
        for await (const s of content) stuecke.push(Buffer.isBuffer(s) ? s : Buffer.from(s));
        const roh = Buffer.concat(stuecke).toString('utf-8');
        return teil.html ? textAusKoerper(roh, 'html') : roh.trim();
      });
    },

    async gesendeteIds(seitIso) {
      const c = await verbinde();
      const ordner = (await c.list()).find((o) => o.specialUse === '\\Sent' || /^sent$/i.test(o.path));
      if (!ordner) return [];
      return imOrdner(ordner.path, async (cc) => {
        const uids = await cc.search({ since: new Date(seitIso) }, { uid: true });
        const raus: string[] = [];
        if (!uids || !uids.length) return raus;
        for await (const m of cc.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          if (m.envelope?.messageId) raus.push(String(m.envelope.messageId));
        }
        return raus;
      });
    },

    async schliessen() {
      if (client) { await client.logout().catch(() => { /* egal */ }); client = null; }
    },
  };
}

// ── Ein lesender Durchlauf ─────────────────────────────────────────────────

export interface GeseheneMail {
  quelle: string;
  ordner: string;
  mail: RohMail;
}

export interface LeseLauf {
  quelle: string;
  ordnerGesehen: number;
  mailsGesehen: number;
  /** Neu ins Register dieser Quelle geschrieben. */
  neu: RegisterEintrag[];
  /** Schon in irgendeinem Register (data@, m365, yahoo) — nicht doppelt. */
  doppelt: number;
  /** Alle gesehenen Mails, fuer die Relevanzpruefung. */
  gesehen: GeseheneMail[];
}

export interface LeseDeps {
  quelle: string;
  postfach: LeseQuelle;
  registerPfad: string;
  /** Message-IDs aus allen Registern — Doppel werden nicht geschrieben. */
  bekannteIds: Set<string>;
  seitIso: string;
  now?: Date;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

/**
 * Ordner durchlaufen, neue Nachrichten registrieren. Ruft am Postfach nur
 * `ordner`, `mails` und `anhangsnamen` auf. `bekannteIds` wird ergaenzt, damit
 * die naechste Quelle desselben Laufs dieselbe Mail nicht noch einmal nimmt.
 */
export async function registriereLesend(deps: LeseDeps): Promise<LeseLauf> {
  const jetzt = (deps.now ?? new Date()).toISOString();
  const lauf: LeseLauf = {
    quelle: deps.quelle, ordnerGesehen: 0, mailsGesehen: 0, neu: [], doppelt: 0, gesehen: [],
  };
  for (const o of await deps.postfach.ordner()) {
    if (ordnerAusgeschlossen(o.name)) continue;
    lauf.ordnerGesehen++;
    const mails = await deps.postfach.mails(o.id, deps.seitIso);
    lauf.mailsGesehen += mails.length;
    for (const mail of mails) {
      lauf.gesehen.push({ quelle: deps.quelle, ordner: o.name, mail });
      const mid = mail.messageId.trim();
      if (deps.bekannteIds.has(mid)) { lauf.doppelt++; continue; }
      const anhaenge = mail.hatAnhaenge
        ? await deps.postfach.anhangsnamen(mail.id).catch(() => [])
        : [];
      lauf.neu.push(eintragAus(mail, o.name, anhaenge, jetzt, deps.quelle));
      deps.bekannteIds.add(mid);
    }
  }
  haengeAnRegister(deps.registerPfad, lauf.neu);
  deps.logger?.info(`[mail-register:${deps.quelle}] ${lauf.mailsGesehen} gesehen, `
    + `${lauf.neu.length} neu, ${lauf.doppelt} schon registriert`);
  return lauf;
}

/** Message-IDs aus mehreren Registerdateien. */
export function bekannteIdsAus(pfade: string[]): Set<string> {
  const ids = new Set<string>();
  for (const p of pfade) for (const e of ladeRegister(p).eintraege) ids.add(e.messageId.trim());
  return ids;
}
