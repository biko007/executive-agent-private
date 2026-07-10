/**
 * mail/commands — Telegram command handlers for Mail module.
 * Commands: /mailstatus, /inbox, /yinbox, /yverify, /draftcreate, /draftedit,
 *           /draftlist, /draftshow, /draftapprove, /draftsend, /ytest, /scanmail
 */
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { graphToken, graphGet, graphPost } from '../../shared/m365/index.js';
import { nowIso, makeId } from '../../shared/utils/index.js';
import {
  initMailStore,
  saveDraft, loadDraft, listDrafts as listDraftsStore,
  isProcessed, markProcessed,
} from './store.js';
import type { MailDraft, UnifiedMsg, Account } from './types.js';

// Re-export for external consumers (/brief, generateBriefingText)
export { listDraftsStore as listDrafts };
export type { MailDraft, UnifiedMsg, Account };

// ── Dependency Injection ───────────────────────────────────────────────────

export interface MailDeps {
  // M365
  m365Enabled: boolean;
  tenantId: string;
  clientId: string;
  m365Secret: string;
  m365User: string;
  // Yahoo
  yahooEnabled: boolean;
  yahooUser: string;
  yahooPass: string;
  yahooImapHost: string;
  yahooImapPort: number;
  yahooSmtpHost: string;
  yahooSmtpPort: number;
  yahooSmtpSecure: boolean;
  // Signatures
  sigM365: string;
  sigYahoo: string;
  // Policy
  requireApproval: boolean;
  // Workspace
  workspace: string;
  // Telegram
  sendTelegram: (chatId: string, text: string) => Promise<any>;
  sendTelegramWithKeyboard: (chatId: string, text: string, keyboard: any[][]) => Promise<any>;
  // Travel integration (booking + meeting scanner)
  analyzeMailForBooking: (subject: string, from: string, body: string) => Promise<any>;
  formatBookingMessage: (booking: any) => string;
  formatMeetingMessage: (meeting: any) => string;
  isMeeting: (result: any) => boolean;
  // Logger
  logger: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

let deps: MailDeps;

export function initMailCommands(d: MailDeps): void {
  deps = d;
  initMailStore(d.workspace);
}

// ── State (exported for callback handler in index.ts) ─────────────────────

export const pendingBookings = new Map<string, {
  booking: any;
  source: Account;
  mailId: string;
  expiresAt: number;
}>();

export const pendingTripSelections = new Map<string, {
  bookingKey: string;
  trips: { id: string; name: string }[];
  expiresAt: number;
}>();

// ── Pending Meetings (globalThis for Multi-Load resilience) ───────────────

const PENDING_MEETINGS_KEY = '__ea_pendingMeetings';
export const pendingMeetings: Map<string, {
  meeting: any;
  source: Account;
  mailId: string;
  expiresAt: number;
}> = ((globalThis as any)[PENDING_MEETINGS_KEY] ??= new Map());

// ── Configuration Validation ──────────────────────────────────────────────

function ensureM365() {
  if (!deps.m365Enabled) throw new Error('m365_disabled');
  if (!deps.tenantId || !deps.clientId || !deps.m365User) throw new Error('m365_not_configured');
  if (!deps.m365Secret) throw new Error('m365_secret_missing');
}

function ensureYahoo() {
  if (!deps.yahooEnabled) throw new Error('yahoo_disabled');
  if (!deps.yahooUser || !deps.yahooImapHost || !deps.yahooSmtpHost) throw new Error('yahoo_not_configured');
  if (!deps.yahooPass) throw new Error('yahoo_secret_missing (YAHOO_APP_PASSWORD)');
}

// ── Mail Fetchers ─────────────────────────────────────────────────────────

export async function m365Unread(limit: number): Promise<UnifiedMsg[]> {
  ensureM365();
  await graphToken(deps.tenantId, deps.clientId, deps.m365Secret);

  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}` +
    `/mailFolders/Inbox/messages?$top=${limit}` +
    `&$select=receivedDateTime,from,subject,id,isRead` +
    `&$filter=isRead eq false` +
    `&$orderby=receivedDateTime desc`;

  const data = await graphGet(deps.tenantId, deps.clientId, deps.m365Secret, url);
  const vals = data.value || [];

  return vals.map((m: any) => ({
    source: 'm365' as Account,
    id: String(m.id),
    dateIso: String(m.receivedDateTime || nowIso()),
    from: m?.from?.emailAddress?.address || '?',
    subject: m?.subject || '(no subject)',
  }));
}

export async function m365Recent(limit: number, hours?: number): Promise<UnifiedMsg[]> {
  ensureM365();

  const base =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}` +
    `/mailFolders/Inbox/messages?$top=${limit}` +
    `&$select=receivedDateTime,from,subject,id,isRead` +
    `&$orderby=receivedDateTime desc`;

  let url = base;
  if (hours && Number.isFinite(hours) && hours > 0) {
    const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    url += `&$filter=receivedDateTime ge ${sinceIso}`;
  }

  const data = await graphGet(deps.tenantId, deps.clientId, deps.m365Secret, url);
  const vals = data.value || [];

  return vals.map((m: any) => ({
    source: 'm365' as Account,
    id: String(m.id),
    dateIso: String(m.receivedDateTime || nowIso()),
    from: m?.from?.emailAddress?.address || '?',
    subject: m?.subject || '(no subject)',
  }));
}

function createSafeImapClient(opts?: { socketTimeout?: number }): InstanceType<typeof ImapFlow> {
  const client = new ImapFlow({
    host: deps.yahooImapHost,
    port: deps.yahooImapPort,
    secure: true,
    auth: { user: deps.yahooUser, pass: deps.yahooPass },
    socketTimeout: opts?.socketTimeout ?? 15000,
    logger: false,
  });
  client.on('error', (err: any) => {
    deps.logger.warn(`[executive-agent] IMAP connection error (handled): ${err.message}`);
  });
  return client;
}

export async function yahooUnread(limit: number): Promise<UnifiedMsg[]> {
  ensureYahoo();
  const client = createSafeImapClient();

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    const out: UnifiedMsg[] = [];
    for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true, internalDate: true })) {
      out.push({
        source: 'yahoo',
        id: String(msg.uid),
        dateIso: msg.internalDate ? new Date(msg.internalDate).toISOString() : nowIso(),
        from: msg.envelope?.from?.[0]?.address || '?',
        subject: msg.envelope?.subject || '(no subject)',
      });
      if (out.length >= limit) break;
    }
    return out;
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function yahooRecent(limit: number, hours?: number): Promise<UnifiedMsg[]> {
  ensureYahoo();
  const client = createSafeImapClient();

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    const effectiveHours = (hours && Number.isFinite(hours) && hours > 0) ? hours : (24 * 30);
    const since = new Date(Date.now() - effectiveHours * 60 * 60 * 1000);

    const searchRes = await client.search({ since });
    const uids: number[] = Array.isArray(searchRes) ? searchRes : [];
    uids.sort((a: number, b: number) => b - a);
    const pick = uids.slice(0, limit);

    const out: UnifiedMsg[] = [];
    if (pick.length) {
      for await (const msg of client.fetch(pick, { uid: true, envelope: true, internalDate: true })) {
        out.push({
          source: 'yahoo',
          id: String(msg.uid),
          dateIso: msg.internalDate ? new Date(msg.internalDate).toISOString() : nowIso(),
          from: msg.envelope?.from?.[0]?.address || '?',
          subject: msg.envelope?.subject || '(no subject)',
        });
      }
    }
    return out;
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── Body Fetchers ─────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function m365FetchBody(messageId: string): Promise<string> {
  ensureM365();
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}` +
    `/messages/${encodeURIComponent(messageId)}?$select=body,subject,from`;

  const data = await graphGet(deps.tenantId, deps.clientId, deps.m365Secret, url);
  const bodyContent: string = data?.body?.content || '';
  const contentType: string = data?.body?.contentType || 'html';

  if (contentType.toLowerCase() === 'text') return bodyContent;
  return stripHtml(bodyContent);
}

async function yahooFetchBody(uid: string): Promise<string> {
  ensureYahoo();
  const client = createSafeImapClient({ socketTimeout: 20000 });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    const msg: any = await client.fetchOne(uid, { source: true });
    if (!msg || !msg.source) return '';

    const raw = msg.source.toString('utf-8');
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd === -1) return raw.slice(0, 2000);

    const body = raw.slice(headerEnd + 4);

    if (body.includes('<html') || body.includes('<HTML') || body.includes('<body')) {
      return stripHtml(body).slice(0, 5000);
    }

    const contentTypeMatch = raw.match(/Content-Type:\s*multipart\/[^;]+;\s*boundary="?([^"\r\n]+)"?/i);
    if (contentTypeMatch) {
      const boundary = contentTypeMatch[1];
      const parts = body.split(`--${boundary}`);
      for (const part of parts) {
        if (part.match(/Content-Type:\s*text\/plain/i)) {
          const partBody = part.indexOf('\r\n\r\n');
          if (partBody !== -1) return part.slice(partBody + 4).replace(/--\s*$/, '').trim().slice(0, 5000);
        }
      }
      for (const part of parts) {
        if (part.match(/Content-Type:\s*text\/html/i)) {
          const partBody = part.indexOf('\r\n\r\n');
          if (partBody !== -1) return stripHtml(part.slice(partBody + 4)).slice(0, 5000);
        }
      }
    }

    return body.slice(0, 5000);
  } catch (e: any) {
    deps.logger.warn(`[executive-agent] yahooFetchBody(${uid}) Fehler: ${e.message}`);
    return '';
  } finally {
    await client.logout().catch(() => {});
  }
}

// ── SMTP ──────────────────────────────────────────────────────────────────

function yahooTransport() {
  return nodemailer.createTransport({
    host: deps.yahooSmtpHost,
    port: deps.yahooSmtpPort,
    secure: deps.yahooSmtpSecure,
    auth: { user: deps.yahooUser, pass: deps.yahooPass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    requireTLS: !deps.yahooSmtpSecure,
    tls: { servername: 'smtp.mail.yahoo.com', minVersion: 'TLSv1.2' },
  });
}

async function yahooSend(d: MailDraft) {
  ensureYahoo();
  const transporter = yahooTransport();
  await transporter.sendMail({
    from: deps.yahooUser,
    to: d.to.join(', '),
    subject: d.subject,
    text: d.bodyText,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseKvArgs(inputRaw: string): Record<string, string> {
  const s = String(inputRaw || '').trim();
  const out: Record<string, string> = {};
  if (!s) return out;

  const re = /(\w+)=("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const key = m[1].toLowerCase();
    let val = m[2] || '';
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    val = val.replace(/\\n/g, '\n');
    out[key] = val;
  }
  return out;
}

// ── Mail Scanner ──────────────────────────────────────────────────────────

export async function scanMailsForBookings(reportChatId?: string): Promise<{ scanned: number; found: number; details: string[] }> {
  const details: string[] = [];
  let scanned = 0;
  let found = 0;

  const allMails: UnifiedMsg[] = [];

  if (deps.m365Enabled) {
    try {
      const msgs = await m365Unread(20);
      allMails.push(...msgs);
    } catch (e: any) {
      deps.logger.warn(`[executive-agent] mail-scanner m365 Fehler: ${e.message}`);
    }
  }

  if (deps.yahooEnabled) {
    try {
      const msgs = await yahooUnread(20);
      allMails.push(...msgs);
    } catch (e: any) {
      deps.logger.warn(`[executive-agent] mail-scanner yahoo Fehler: ${e.message}`);
    }
  }

  for (const mail of allMails) {
    if (isProcessed(mail.source, mail.id)) continue;

    scanned++;

    try {
      let bodyText = '';
      if (mail.source === 'm365') {
        bodyText = await m365FetchBody(mail.id);
      } else {
        bodyText = await yahooFetchBody(mail.id);
      }

      const result = await deps.analyzeMailForBooking(mail.subject, mail.from, bodyText);
      markProcessed(mail.source, mail.id);

      if (!result) continue;

      found++;

      // ── MEETING path ──
      if (deps.isMeeting(result)) {
        const msg = deps.formatMeetingMessage(result);
        details.push(msg);

        if (reportChatId) {
          const meetingKey = `meeting_${crypto.randomBytes(6).toString('hex')}`;
          pendingMeetings.set(meetingKey, {
            meeting: result,
            source: mail.source,
            mailId: mail.id,
            expiresAt: Date.now() + 30 * 60_000,
          });

          const keyboard = [
            [
              { text: '\ud83d\udcc5 In Kalender eintragen', callback_data: `${meetingKey}::calendar` },
            ],
            [
              { text: '\u274c Ignorieren', callback_data: `${meetingKey}::ignore` },
            ],
          ];

          await deps.sendTelegramWithKeyboard(
            reportChatId,
            `${msg}\n\nIn Kalender eintragen?`,
            keyboard,
          );
        }
        continue;
      }

      // ── BOOKING path (unchanged) ──
      const msg = deps.formatBookingMessage(result);
      details.push(msg);

      if (reportChatId) {
        const bookingKey = `booking_${crypto.randomBytes(6).toString('hex')}`;
        pendingBookings.set(bookingKey, {
          booking: result,
          source: mail.source,
          mailId: mail.id,
          expiresAt: Date.now() + 30 * 60_000,
        });

        const keyboard = [
          [
            { text: '\ud83c\udd95 Neue Reise', callback_data: `${bookingKey}::new` },
            { text: '\ud83d\udccb Zu bestehender Reise', callback_data: `${bookingKey}::existing` },
          ],
          [
            { text: '\u274c Ignorieren', callback_data: `${bookingKey}::ignore` },
          ],
        ];

        await deps.sendTelegramWithKeyboard(
          reportChatId,
          `${msg}\n\nZu Reise hinzuf\u00fcgen?`,
          keyboard,
        );
      }
    } catch (e: any) {
      deps.logger.warn(`[executive-agent] mail-scanner Fehler bei ${mail.source}:${mail.id}: ${e.message}`);
      markProcessed(mail.source, mail.id);
    }
  }

  return { scanned, found, details };
}

// ── Command Registration ──────────────────────────────────────────────────

export function registerMailCommands(api: any): void {
  // /mailstatus
  api.registerCommand({
    name: 'mailstatus',
    description: 'Mail status (Executive-Agent only)',
    requireAuth: true,
    handler: () => {
      const m365Ok = deps.m365Enabled && deps.tenantId && deps.clientId && deps.m365User && deps.m365Secret;
      const yOk = deps.yahooEnabled && deps.yahooUser && deps.yahooImapHost && deps.yahooSmtpHost && deps.yahooPass;

      return {
        text:
          '\ud83d\udcec Mail-Status (Executive-Agent)\n\n' +
          `\u2022 M365: ${m365Ok ? '\u2705' : '\u274c'}  (${deps.m365User || '(unset)'})\n` +
          `\u2022 Yahoo: ${yOk ? '\u2705' : '\u274c'}  (${deps.yahooUser || '(unset)'})\n` +
          `\u2022 Send-Policy: ${deps.requireApproval ? 'requireApproval=true \u2705' : 'requireApproval=false \u26a0\ufe0f'}\n\n` +
          'Hinweis: pr\u00fcft nur plugins.entries.executive-agent.config + ENV Secrets (nicht daily-briefing/skills).',
      };
    },
  });

  // /inbox — unified inbox
  api.registerCommand({
    name: 'inbox',
    description: 'Unified inbox (default: unread). Usage: /inbox [n] | /inbox last [24h] [n]',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const tokens = raw ? raw.split(/\s+/) : [];

        let mode: 'unread' | 'last' = 'unread';
        let hours: number | undefined = undefined;
        let n: any = 10;

        if (tokens[0]?.toLowerCase() === 'last') {
          mode = 'last';
          const t1 = tokens[1];
          const t2 = tokens[2];

          if (t1 && /h$/i.test(t1)) {
            const h = Number(t1.replace(/h$/i, ''));
            if (Number.isFinite(h) && h > 0) hours = h;
            if (t2) n = Number(t2);
          } else if (t1) {
            n = Number(t1);
          }
        } else if (tokens[0]) {
          n = Number(tokens[0]);
        }

        n = Math.max(1, Math.min(20, Number.isFinite(n) ? Number(n) : 10));
        const perSource = Math.max(10, n);

        const [mMsgs, yMsgs] =
          mode === 'last'
            ? await Promise.all([
                deps.m365Enabled ? m365Recent(perSource, hours) : Promise.resolve([] as UnifiedMsg[]),
                deps.yahooEnabled ? yahooRecent(perSource, hours) : Promise.resolve([] as UnifiedMsg[]),
              ])
            : await Promise.all([
                deps.m365Enabled ? m365Unread(perSource) : Promise.resolve([] as UnifiedMsg[]),
                deps.yahooEnabled ? yahooUnread(perSource) : Promise.resolve([] as UnifiedMsg[]),
              ]);

        const combined = [...mMsgs, ...yMsgs]
          .sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1))
          .slice(0, n);

        if (!combined.length) {
          return {
            text:
              mode === 'last'
                ? '\ud83d\udce5 Unified Inbox: keine Mails im gew\u00e4hlten Zeitraum.'
                : '\ud83d\udce5 Unified Inbox: keine ungelesenen Mails.',
          };
        }

        const lines = combined.map(m => {
          const src = m.source === 'm365' ? '[M365]' : '[YAHOO]';
          const dt = m.dateIso.replace('T', ' ').replace('Z', 'Z');
          return `${src} ${dt} | ${m.from}\n${m.subject}\n(id: ${m.id})`;
        });

        const title =
          mode === 'last'
            ? `\ud83d\udce5 Unified Inbox (last${hours ? ' ' + hours + 'h' : ''}, top ${n})`
            : `\ud83d\udce5 Unified Inbox (unread, top ${n})`;

        return { text: `${title}\n\n${lines.join('\n\n')}` };
      } catch (e: any) {
        return { text: `\u274c /inbox failed: ${e.message}` };
      }
    },
  });

  // /yinbox — Yahoo-only inbox
  api.registerCommand({
    name: 'yinbox',
    description: 'Yahoo unread. Usage: /yinbox [n]',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const n = Math.max(1, Math.min(20, Number(String(ctx.args || '5').trim() || '5')));
        const msgs = await yahooUnread(n);
        if (!msgs.length) return { text: '\ud83d\udce5 Yahoo: keine ungelesenen Mails.' };
        return { text: '\ud83d\udce5 Yahoo (unread)\n\n' + msgs.map(m => `${m.id}\n  ${m.dateIso} | ${m.from}\n  ${m.subject}`).join('\n\n') };
      } catch (e: any) {
        return { text: `\u274c /yinbox failed: ${e.message}` };
      }
    },
  });

  // /yverify — Verify Yahoo SMTP
  api.registerCommand({
    name: 'yverify',
    description: 'Verify Yahoo SMTP connectivity. Usage: /yverify',
    requireAuth: true,
    handler: async () => {
      try {
        ensureYahoo();
        const t = yahooTransport();
        await t.verify();
        return { text: `\u2705 Yahoo SMTP verify: OK (port ${deps.yahooSmtpPort}, secure=${deps.yahooSmtpSecure})` };
      } catch (e: any) {
        return { text: `\u274c Yahoo SMTP verify FAILED: ${e.message}` };
      }
    },
  });

  // /draftcreate
  api.registerCommand({
    name: 'draftcreate',
    description: 'Create draft quickly. Usage: /draftcreate account=yahoo|m365 to=a@b.com[,c@d.com] subject=... body=...',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      try {
        const kv = parseKvArgs(ctx.args || '');
        const account = (kv.account || '').toLowerCase();

        if (account !== 'yahoo' && account !== 'm365') {
          return { text: '\u274c account=yahoo oder account=m365 ist Pflicht.' };
        }
        if (account === 'yahoo') ensureYahoo();
        if (account === 'm365') ensureM365();

        const to = (kv.to || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!to.length) return { text: '\u274c to=... ist Pflicht (kommagetrennt).' };

        const subject = kv.subject || '';
        if (!subject) return { text: '\u274c subject=... ist Pflicht.' };

        const sig = account === 'yahoo' ? deps.sigYahoo : deps.sigM365;
        const body = kv.body ? `${kv.body}\n\n---\n${sig}\n` : '';

        const d: MailDraft = {
          id: makeId(account),
          createdAt: nowIso(),
          status: 'draft',
          account: account as Account,
          user: account === 'yahoo' ? deps.yahooUser : deps.m365User,
          to,
          subject,
          bodyText: body,
        };
        saveDraft(d);

        return {
          text:
            `\u2705 Draft erstellt: ${d.id}\n\n` +
            `Account: ${d.account}\nTo: ${d.to.join(', ')}\nSubject: ${d.subject}\n\n` +
            `N\u00e4chste Schritte:\n/draftshow ${d.id}\n/draftedit ${d.id} body=...\n/draftapprove ${d.id}\n/draftsend ${d.id}`,
        };
      } catch (e: any) {
        return { text: `\u274c /draftcreate failed: ${e.message}` };
      }
    },
  });

  // /draftedit
  api.registerCommand({
    name: 'draftedit',
    description: 'Edit draft fields. Usage: /draftedit <id> [to=...] [subject=...] [body=...]',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const m = raw.match(/^(\S+)\s*([\s\S]*)$/);
        if (!m) return { text: 'Usage: /draftedit <id> [to=...] [subject=...] [body=...]' };

        const id = m[1];
        const rest = m[2] || '';
        const d = loadDraft(id);
        if (!d) return { text: `Draft not found: ${id}` };
        if (d.status === 'sent') return { text: `\u274c Draft already sent: ${id}` };

        const kv = parseKvArgs(rest);
        let changed = false;
        if (kv.to) {
          d.to = kv.to.split(',').map(s => s.trim()).filter(Boolean);
          changed = true;
        }
        if (kv.subject) {
          d.subject = kv.subject;
          changed = true;
        }
        if (kv.body) {
          const sig = d.account === 'yahoo' ? deps.sigYahoo : deps.sigM365;
          d.bodyText = `${kv.body}\n\n---\n${sig}\n`;
          changed = true;
        }

        if (!changed) return { text: 'Keine \u00c4nderungen erkannt. Nutze key=value Syntax.' };
        saveDraft(d);
        return { text: `\u2705 Draft aktualisiert: ${id}\n/draftshow ${id}` };
      } catch (e: any) {
        return { text: `\u274c /draftedit failed: ${e.message}` };
      }
    },
  });

  // /draftlist
  api.registerCommand({
    name: 'draftlist',
    description: 'List open drafts. Usage: /draftlist [n]',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      try {
        const n = Math.max(1, Math.min(20, Number(String(ctx.args || '5').trim() || '5')));
        const ds = listDraftsStore('draft', n);
        if (!ds.length) return { text: '\ud83d\udcdd Drafts: keine offenen Drafts.' };

        const lines = ds.map(d =>
          `\u2022 ${d.id} [${d.account}]\n  To: ${(d.to || []).join(', ')}\n  ${d.subject}`
        );
        return { text: `\ud83d\udcdd Drafts (open, top ${n})\n\n${lines.join('\n\n')}` };
      } catch (e: any) {
        return { text: `\u274c /draftlist failed: ${e.message}` };
      }
    },
  });

  // /draftshow
  api.registerCommand({
    name: 'draftshow',
    description: 'Show draft. Usage: /draftshow <draftId>',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const id = String(ctx.args || '').trim();
      if (!id) return { text: 'Usage: /draftshow <draftId>' };
      const d = loadDraft(id);
      if (!d) return { text: `Draft not found: ${id}` };
      return { text: `\ud83e\uddf6 ${d.id} (${d.status}) [${d.account}]\nTo: ${d.to.join(', ')}\nSubject: ${d.subject}\n\n${d.bodyText}` };
    },
  });

  // /draftapprove
  api.registerCommand({
    name: 'draftapprove',
    description: 'Approve draft (plugin). Usage: /draftapprove <draftId>',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const id = String(ctx.args || '').trim();
      if (!id) return { text: 'Usage: /draftapprove <draftId>' };
      const d = loadDraft(id);
      if (!d) return { text: `Draft not found: ${id}` };
      d.status = 'approved';
      saveDraft(d);
      return { text: `\u2705 Draft approved: ${id}\nNow: /draftsend ${id}` };
    },
  });

  // /draftsend
  api.registerCommand({
    name: 'draftsend',
    description: 'Send approved draft. Usage: /draftsend <draftId>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const id = String(ctx.args || '').trim();
        if (!id) return { text: 'Usage: /draftsend <draftId>' };
        const d = loadDraft(id);
        if (!d) return { text: `Draft not found: ${id}` };
        if (deps.requireApproval && d.status !== 'approved') {
          return { text: `\u274c Draft not approved. Erst /draftapprove ${id}` };
        }
        if (d.status === 'sent') return { text: `\u2139\ufe0f Draft already sent: ${id}` };

        if (d.account === 'yahoo') {
          await yahooSend(d);
        } else {
          ensureM365();
          const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}/sendMail`;
          const payload = {
            message: {
              subject: d.subject,
              body: { contentType: 'Text', content: d.bodyText },
              toRecipients: d.to.map(addr => ({ emailAddress: { address: addr } })),
            },
            saveToSentItems: true,
          };
          await graphPost(deps.tenantId, deps.clientId, deps.m365Secret, url, payload);
        }

        d.status = 'sent';
        saveDraft(d);
        return { text: `\ud83d\udce4 Sent draft: ${id} via ${d.account}` };
      } catch (e: any) {
        return { text: `\u274c /draftsend failed: ${e.message}` };
      }
    },
  });

  // /ytest
  api.registerCommand({
    name: 'ytest',
    description: 'Create Yahoo test draft. Usage: /ytest <email>',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      try {
        ensureYahoo();
        const to = String(ctx.args || '').trim();
        if (!to || !to.includes('@')) return { text: 'Usage: /ytest user@example.com' };

        const d: MailDraft = {
          id: makeId('yahoo'),
          createdAt: nowIso(),
          status: 'draft',
          account: 'yahoo',
          user: deps.yahooUser,
          to: [to],
          subject: 'Yahoo Test (Hans Dampf)',
          bodyText: 'Hallo,\n\nDies ist eine Yahoo-Testmail.\n\n\u2014\n' + deps.sigYahoo + '\n',
        };
        saveDraft(d);

        return {
          text:
            `\u2705 Yahoo Draft: ${d.id}\n` +
            `/draftshow ${d.id}\n` +
            `/draftapprove ${d.id}\n` +
            `/draftsend ${d.id}`,
        };
      } catch (e: any) {
        return { text: `\u274c /ytest failed: ${e.message}` };
      }
    },
  });

  // /scanmail
  api.registerCommand({
    name: 'scanmail',
    description: 'Manueller Mail-Scan auf Buchungen und Termine',
    handler: async (ctx: any) => {
      if (!deps.m365Enabled && !deps.yahooEnabled) {
        return { text: '\u274c Kein Mail-Account aktiviert (m365/yahoo).' };
      }

      const chatId = String(ctx?.chatId || ctx?.threadId || ctx?.conversationId || ctx?.senderId || '');

      try {
        const { scanned, found } = await scanMailsForBookings(chatId);

        if (found === 0) {
          return { text: `\u2705 ${scanned} neue Mails gescannt \u2014 keine Buchungen erkannt.` };
        }

        return { text: `\ud83d\udcec ${scanned} Mails gescannt, ${found} Buchung(en) erkannt.` };
      } catch (e: any) {
        return { text: `\u274c Mail-Scan Fehler: ${e.message}` };
      }
    },
  });
}
