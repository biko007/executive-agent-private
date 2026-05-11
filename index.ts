import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
import SunCalc from "suncalc";
import {
  createTrip, getTrip, listTrips,
  fetchWeatherBriefing,
  analyzeMailForBooking, formatBookingMessage,
  registerTravelCommands, initTravelCommands, addBookingAsSegment, handleSegmentDeletionCallback,
  BOOKING_EMOJI,
} from "./src/modules/travel/index.js";
import type { ParsedBooking } from "./src/modules/travel/index.js";
import { registerAssetsCommands } from "./src/modules/assets/index.js";
import {
  readEntries, lastEntry, getWeightTrend, checkHealthAlerts,
  registerHealthCommands, initHealthCommands, syncWithingsForBriefing,
} from "./src/modules/health/index.js";
import type { HealthAlert } from "./src/modules/health/index.js";
import { listSites, listDrives, searchDocuments, getRecentFiles, pollForChanges, fullSync, searchLocalIndex, getIndexAge } from "./sharepoint-store.js";
import {
  getAllVehicles, checkDeadlines,
  registerFleetCommands, initFleetCommands,
} from "./src/modules/fleet/index.js";
import {
  getLinksForEntity, addSharePointLink, addLocalLink, removeLink,
  searchSharePointForLinking, formatLinksForTelegram,
} from "./link-store.js";
import { registerPECommands } from "./src/modules/pe/index.js";
import type { SpSearchResult } from "./link-store.js";
import {
  registerInstagramCommands, initInstagramCommands, bootstrapInstagramToken,
  // State exports for command-guard
  instaSubmitActive, instaSubmitLastActivatedAt,
  pendingInstaSubmits, activeRawSessions,
  // Helpers for command-guard
  detectMediaType, formatFileSize, loadRawSession, saveRawSession, createRawSession,
  generateRawSessionId, sessionDir,
  findRecentAudioFile, transcribeVoice,
  // Briefing
  getInstagramBriefingLines,
  // Store re-exports for system-health DI
  tokenDaysRemaining,
  loadInstaTokens, ensureInstaToken,
} from "./src/modules/instagram/index.js";
import type { RawSession } from "./src/modules/instagram/index.js";
import { openPage, extractText, screenshot, closeBrowser } from "./browser-agent.js";
import {
  initSystemHealth,
  runStartupChecks, formatHealthReport, checkAndRefreshInstagramToken,
  evaluateTokenAlert, safeTelegramSend, formatEscalation,
  preFlightInstagram, preFlightTrading, formatPreFlightFailure,
  runDailyHealthCheck,
} from "./system-health.js";
import type { HealthReport, Escalation } from "./system-health.js";
import { HealthMonitor } from "./src/modules/executive/index.js";
import { runMigrations, query as dbQuery } from "./src/shared/db/index.js";
import {
  nowIso, makeId, sleep, fetchWithTimeout, parseRetryAfterMs,
  berlinDate, readAnthropicKey, readOpenAIKey,
} from "./src/shared/utils/index.js";
import {
  loadSettings, saveSettings, getLocationSettings, DEFAULT_LOCATION,
} from "./src/shared/settings/index.js";
import type { Settings, LocationSetting } from "./src/shared/settings/index.js";
import {
  graphToken, graphRequest, graphGet, graphPost, graphDelete,
} from "./src/shared/m365/index.js";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

type DraftStatus = "draft" | "approved" | "sent";
type Account = "m365" | "yahoo";

type MailDraft = {
  id: string;
  createdAt: string;
  status: DraftStatus;
  account: Account;
  user: string;
  to: string[];
  subject: string;
  bodyText: string;
};

type UnifiedMsg = {
  source: Account;
  id: string;          // m365 message id OR yahoo UID
  dateIso: string;     // ISO timestamp
  from: string;
  subject: string;
};

interface ProcessedMails {
  version: 1;
  ids: string[];  // "m365::<msgId>" or "yahoo::<uid>"
}

/* ---------------- Settings + Helpers ---------------- */
// Settings, LocationSetting, loadSettings, saveSettings, getLocationSettings, DEFAULT_LOCATION → src/shared/settings
// berlinDate → src/shared/utils

interface AstroData {
  sunrise: string;   // HH:MM
  sunset: string;    // HH:MM
  moonrise: string | null;  // HH:MM or null (no rise today)
  moonset: string | null;   // HH:MM or null (no set today)
  moonIcon: string;
  moonPhase: string;
  illumination: number; // 0-100
}

function getAstroData(date: Date, location: LocationSetting = DEFAULT_LOCATION): AstroData {
  const tz = 'Europe/Berlin';
  const fmt = (d: Date) => new Intl.DateTimeFormat('de-DE', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);

  const sun = SunCalc.getTimes(date, location.lat, location.lon);
  const moonTimes = SunCalc.getMoonTimes(date, location.lat, location.lon);
  const moon = SunCalc.getMoonIllumination(date);
  const phase = moon.phase;

  let moonIcon: string;
  let moonPhase: string;
  if (phase < 0.03 || phase >= 0.97) { moonIcon = '🌑'; moonPhase = 'Neumond'; }
  else if (phase < 0.22) { moonIcon = '🌒'; moonPhase = 'Zunehmende Sichel'; }
  else if (phase < 0.28) { moonIcon = '🌓'; moonPhase = 'Erstes Viertel'; }
  else if (phase < 0.47) { moonIcon = '🌔'; moonPhase = 'Zunehmender Mond'; }
  else if (phase < 0.53) { moonIcon = '🌕'; moonPhase = 'Vollmond'; }
  else if (phase < 0.72) { moonIcon = '🌖'; moonPhase = 'Abnehmender Mond'; }
  else if (phase < 0.78) { moonIcon = '🌗'; moonPhase = 'Letztes Viertel'; }
  else                    { moonIcon = '🌘'; moonPhase = 'Abnehmende Sichel'; }

  return {
    sunrise: fmt(sun.sunrise),
    sunset: fmt(sun.sunset),
    moonrise: moonTimes.rise ? fmt(moonTimes.rise) : null,
    moonset: moonTimes.set ? fmt(moonTimes.set) : null,
    moonIcon,
    moonPhase,
    illumination: Math.round(moon.fraction * 100),
  };
}

/* ---------------- Plugin ---------------- */

export default function (api: any) {
  // ── Global Error Safety Net — register FIRST, before any async work ──
  // Prevents socket timeouts, IMAP errors, and Telegram fetch failures from killing the process.
  process.on("uncaughtException", (err: Error) => {
    const isSocketTimeout = err.message?.includes("Socket timeout") || err.message?.includes("ETIMEDOUT");
    const isFetchError = err.message?.includes("fetch failed") || err.message?.includes("ECONNRESET");
    const severity = (isSocketTimeout || isFetchError) ? "warn" : "error";
    api.logger[severity](`[executive-agent] Uncaught exception (${severity}, not crashing): ${err.message}`);
    if (!isSocketTimeout && !isFetchError) {
      api.logger.error(`[executive-agent] Stack: ${err.stack}`);
    }
  });
  process.on("unhandledRejection", (reason: any) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    const isNetworkError = msg.includes("fetch failed") || msg.includes("Socket timeout")
      || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ECONNREFUSED")
      || msg.includes("UND_ERR_SOCKET") || msg.includes("AbortError");
    const severity = isNetworkError ? "warn" : "error";
    api.logger[severity](`[executive-agent] Unhandled rejection (${severity}, not crashing): ${msg}`);
    if (!isNetworkError && stack) {
      api.logger.error(`[executive-agent] Rejection stack: ${stack}`);
    }
  });

  const workspace: string = api?.config?.agents?.defaults?.workspace || "/home/biko/.openclaw/workspace";
  const draftsDir = path.join(workspace, "artifacts", "mail-drafts");
  fs.mkdirSync(draftsDir, { recursive: true });

  // pluginConfig maps to: plugins.entries.executive-agent.config
  const pcfg = api.pluginConfig || {};
  const mailCfg = pcfg.mail || {};
  const m365 = mailCfg.m365 || {};
  const yahoo = mailCfg.yahoo || {};
  const signatures = mailCfg.signatures || {};
  const sendPolicy = mailCfg.sendPolicy || {};

  const requireApproval: boolean = sendPolicy.requireApproval !== false; // default true

  // ---- M365 config
// ---- M365 config
  const m365Enabled: boolean = !!m365.enabled;
  const tenantId: string = process.env.M365_TENANT_ID || m365.tenantId || "";
  const clientId: string = process.env.M365_CLIENT_ID || m365.clientId || "";
  const m365User: string = process.env.M365_USER || m365.email || "";
  const m365Secret: string = process.env.M365_CLIENT_SECRET || "";
 
  // ---- Yahoo config
  const yahooEnabled: boolean = !!yahoo.enabled;
  const yahooUser: string = yahoo.email || "";
  const yahooPass = process.env.YAHOO_APP_PASSWORD || "";
  const yahooImapHost: string = yahoo.imapHost || "";
  const yahooImapPort: number = yahoo.imapPort || 993;
  const yahooSmtpHost: string = yahoo.smtpHost || "";
  const yahooSmtpPort: number = yahoo.smtpPort || 587;
  const yahooSmtpSecure: boolean = (yahooSmtpPort === 465);

  // ---- Signatures (normalize literal "\n" to real newlines)
  const sigM365 = String(signatures.m365 || "Mit freundlichem Gruß\n\nKI-Agent Hans Dampf\nim Auftrag von\nJürgen Bickel").replace(/\\n/g, "\n");
  const sigYahoo = String(signatures.yahoo || "Mit freundlichem Gruß\n\nKI-Agent Hans Dampf\nim Auftrag von\nJürgen Bickel").replace(/\\n/g, "\n");

  // ---- Telegram Bot Token (for direct API fallback)
  let telegramBotToken = '';
  try {
    const ocCfgPath = path.join(process.env.HOME || '/root', '.openclaw/openclaw.json');
    if (fs.existsSync(ocCfgPath)) {
      const ocCfg = JSON.parse(fs.readFileSync(ocCfgPath, 'utf-8'));
      telegramBotToken = ocCfg?.channels?.telegram?.botToken || '';
    }
  } catch { /* ignore */ }

  /**
   * Send a Telegram message with fallback: plugin API → direct Bot API.
   * Retries up to 3 times with exponential backoff on network failures.
   * Returns true if the message was sent successfully.
   */
  const TELEGRAM_RETRY_DELAYS = [2_000, 5_000, 15_000];

  async function sendTelegram(chatId: string, text: string): Promise<boolean> {
    for (let attempt = 0; attempt <= TELEGRAM_RETRY_DELAYS.length; attempt++) {
      // Try plugin API first
      try {
        if (api.runtime?.channel?.telegram?.sendMessageTelegram) {
          await api.runtime.channel.telegram.sendMessageTelegram(chatId, text);
          return true;
        }
      } catch (err: any) {
        const isRetryable = isRetryableError(err);
        if (attempt === 0) {
          api.logger.warn(`[executive-agent] plugin telegram-send failed: ${err.message}, trying direct API...`);
        }
        if (!isRetryable) break; // non-retryable → fall through to direct API
      }

      // Fallback: direct Telegram Bot API
      if (!telegramBotToken) {
        api.logger.error('[executive-agent] No bot token available for direct Telegram send');
        return false;
      }
      try {
        const res = await fetchWithTimeout(
          `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
          },
          15000,
        );
        if (res.ok) {
          if (attempt > 0) api.logger.info(`[executive-agent] Telegram sent after ${attempt + 1} attempts`);
          return true;
        }
        const body = await res.text().catch(() => '');
        // 4xx client errors (except 429) are not retryable
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          api.logger.error(`[executive-agent] direct telegram-send HTTP ${res.status}: ${body}`);
          return false;
        }
        api.logger.warn(`[executive-agent] telegram-send HTTP ${res.status} (attempt ${attempt + 1}): ${body}`);
      } catch (err: any) {
        api.logger.warn(`[executive-agent] telegram-send failed (attempt ${attempt + 1}): ${err.message}`);
      }

      // Backoff before retry
      if (attempt < TELEGRAM_RETRY_DELAYS.length) {
        await sleep(TELEGRAM_RETRY_DELAYS[attempt]);
      }
    }

    api.logger.error(`[executive-agent] telegram-send failed after ${TELEGRAM_RETRY_DELAYS.length + 1} attempts`);
    return false;
  }

  function isRetryableError(err: any): boolean {
    const msg = err?.message || '';
    return msg.includes('fetch failed') || msg.includes('Socket timeout')
      || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')
      || msg.includes('ECONNREFUSED') || msg.includes('UND_ERR_SOCKET')
      || msg.includes('AbortError') || msg.includes('fetch_timeout');
  }

  /**
   * Send Telegram message with inline keyboard buttons.
   */
  async function sendTelegramWithKeyboard(
    chatId: string,
    text: string,
    keyboard: { text: string; callback_data: string }[][],
  ): Promise<boolean> {
    if (!telegramBotToken) {
      api.logger.error('[executive-agent] No bot token for keyboard message');
      return false;
    }
    for (let attempt = 0; attempt <= TELEGRAM_RETRY_DELAYS.length; attempt++) {
      try {
        const res = await fetchWithTimeout(
          `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: keyboard },
            }),
          },
          15000,
        );
        if (res.ok) return true;
        const body = await res.text().catch(() => '');
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          api.logger.error(`[executive-agent] keyboard-send HTTP ${res.status}: ${body}`);
          return false;
        }
        api.logger.warn(`[executive-agent] keyboard-send HTTP ${res.status} (attempt ${attempt + 1}): ${body}`);
      } catch (err: any) {
        api.logger.warn(`[executive-agent] keyboard-send failed (attempt ${attempt + 1}): ${err.message}`);
      }
      if (attempt < TELEGRAM_RETRY_DELAYS.length) {
        await sleep(TELEGRAM_RETRY_DELAYS[attempt]);
      }
    }
    api.logger.error(`[executive-agent] keyboard-send failed after ${TELEGRAM_RETRY_DELAYS.length + 1} attempts`);
    return false;
  }

  async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!telegramBotToken) return;
    try {
      await fetchWithTimeout(
        `https://api.telegram.org/bot${telegramBotToken}/answerCallbackQuery`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: text || '',
          }),
        },
        10000,
      );
    } catch {}
  }

  async function sendTelegramPhoto(chatId: string, photoPath: string, caption?: string): Promise<boolean> {
    if (!telegramBotToken) return false;
    try {
      const photoData = fs.readFileSync(photoPath);
      const blob = new Blob([photoData], { type: 'image/png' });
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('photo', blob, 'screenshot.png');
      if (caption) form.append('caption', caption);
      const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      return res.ok;
    } catch (e: any) {
      api.logger.error(`[executive-agent] sendTelegramPhoto failed: ${e.message}`);
      return false;
    }
  }

  /* --- Pending-Booking State (mail scanner → travel integration) --- */

  const pendingBookings = new Map<string, {
    booking: ParsedBooking;
    source: Account;
    mailId: string;
    expiresAt: number;
  }>();

  // Pending trip-selection state (user picked "Zu bestehender Reise")
  const pendingTripSelections = new Map<string, {
    bookingKey: string;
    trips: { id: string; name: string }[];
    expiresAt: number;
  }>();

  const draftPath = (id: string) => path.join(draftsDir, `${id}.json`);
  function saveDraft(d: MailDraft) { fs.writeFileSync(draftPath(d.id), JSON.stringify(d, null, 2), "utf-8"); }
  function loadDraft(id: string): MailDraft | null {
    const p = draftPath(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  function listDrafts(status?: MailDraft["status"], limit: number = 5): MailDraft[] {
    if (!fs.existsSync(draftsDir)) return [];
    const files = fs.readdirSync(draftsDir).filter(f => f.endsWith(".json"));
    const out: MailDraft[] = [];

    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(draftsDir, f), "utf-8");
        const d = JSON.parse(raw);
        if (!d?.id || !d?.status) continue;
        if (status && d.status !== status) continue;
        out.push(d as MailDraft);
      } catch {
        // ignore broken draft file
      }
    }

    out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return out.slice(0, Math.max(1, Math.min(20, limit)));
  }

  function ensureM365Configured() {
    if (!m365Enabled) throw new Error("m365_disabled");
    if (!tenantId || !clientId || !m365User) throw new Error("m365_not_configured");
    if (!m365Secret) throw new Error("m365_secret_missing");
  }
  function ensureYahooConfigured() {
    if (!yahooEnabled) throw new Error("yahoo_disabled");
    if (!yahooUser || !yahooImapHost || !yahooSmtpHost) throw new Error("yahoo_not_configured");
    if (!yahooPass) throw new Error("yahoo_secret_missing (YAHOO_APP_PASSWORD)");
  }

  /* ---------------- Processed-Mail Store (Duplikat-Tracking) ---------------- */

  const processedMailPath = path.join(workspace, 'artifacts', 'personal', 'mail-parsing', 'processed.json');

  function loadProcessed(): ProcessedMails {
    try {
      if (fs.existsSync(processedMailPath)) {
        return JSON.parse(fs.readFileSync(processedMailPath, 'utf-8'));
      }
    } catch {}
    return { version: 1, ids: [] };
  }

  function saveProcessed(p: ProcessedMails): void {
    fs.mkdirSync(path.dirname(processedMailPath), { recursive: true });
    fs.writeFileSync(processedMailPath, JSON.stringify(p, null, 2), 'utf-8');
  }

  function isProcessed(source: Account, id: string): boolean {
    const key = `${source}::${id}`;
    return loadProcessed().ids.includes(key);
  }

  function markProcessed(source: Account, id: string): void {
    const p = loadProcessed();
    const key = `${source}::${id}`;
    if (!p.ids.includes(key)) {
      p.ids.push(key);
      // Keep last 2000 entries to avoid unbounded growth
      if (p.ids.length > 2000) p.ids = p.ids.slice(-2000);
      saveProcessed(p);
    }
  }

  /* ---------------- Unified: unread fetchers ---------------- */

  async function m365Unread(limit: number): Promise<UnifiedMsg[]> {
    ensureM365Configured();
    const token = await graphToken(tenantId, clientId, m365Secret);

    // unread only, newest first
    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
      `/mailFolders/Inbox/messages?$top=${limit}` +
      `&$select=receivedDateTime,from,subject,id,isRead` +
      `&$filter=isRead eq false` +
      `&$orderby=receivedDateTime desc`;

    const data = await graphGet(tenantId, clientId, m365Secret, url);
    const vals = data.value || [];

    return vals.map((m: any) => ({
      source: "m365",
      id: String(m.id),
      dateIso: String(m.receivedDateTime || nowIso()),
      from: m?.from?.emailAddress?.address || "?",
      subject: m?.subject || "(no subject)",
    }));
  }


  async function m365Recent(limit: number, hours?: number): Promise<UnifiedMsg[]> {
    ensureM365Configured();

    // newest first, optional time filter
    const base =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
      `/mailFolders/Inbox/messages?$top=${limit}` +
      `&$select=receivedDateTime,from,subject,id,isRead` +
      `&$orderby=receivedDateTime desc`;

    let url = base;
    if (hours && Number.isFinite(hours) && hours > 0) {
      const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      url += `&$filter=receivedDateTime ge ${sinceIso}`;
    }

    const data = await graphGet(tenantId, clientId, m365Secret, url);
    const vals = data.value || [];

    return vals.map((m: any) => ({
      source: "m365",
      id: String(m.id),
      dateIso: String(m.receivedDateTime || nowIso()),
      from: m?.from?.emailAddress?.address || "?",
      subject: m?.subject || "(no subject)",
    }));
  }

  /**
   * Create an ImapFlow client with error handler to prevent uncaught exceptions.
   * Always use try/finally with client.logout() when using this.
   */
  function createSafeImapClient(opts?: { socketTimeout?: number }): InstanceType<typeof ImapFlow> {
    const client = new ImapFlow({
      host: yahooImapHost,
      port: yahooImapPort,
      secure: true,
      auth: { user: yahooUser, pass: yahooPass },
      socketTimeout: opts?.socketTimeout ?? 15000,
      logger: false,
    });
    // Prevent unhandled 'error' events from crashing the process
    client.on('error', (err: any) => {
      api.logger.warn(`[executive-agent] IMAP connection error (handled): ${err.message}`);
    });
    return client;
  }

  async function yahooUnread(limit: number): Promise<UnifiedMsg[]> {
    ensureYahooConfigured();
    const client = createSafeImapClient();

    try {
      await client.connect();
      await client.mailboxOpen("INBOX");

      const out: UnifiedMsg[] = [];
      for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true, internalDate: true })) {
        out.push({
          source: "yahoo",
          id: String(msg.uid),
          dateIso: msg.internalDate ? new Date(msg.internalDate).toISOString() : nowIso(),
          from: msg.envelope?.from?.[0]?.address || "?",
          subject: msg.envelope?.subject || "(no subject)",
        });
        if (out.length >= limit) break;
      }
      return out;
    } finally {
      await client.logout().catch(() => {});
    }
  }


  async function yahooRecent(limit: number, hours?: number): Promise<UnifiedMsg[]> {
    ensureYahooConfigured();
    const client = createSafeImapClient();

    try {
      await client.connect();
      await client.mailboxOpen("INBOX");

      // Without a time bound, IMAP "recent" can be heavy; use safe default window.
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
            source: "yahoo",
            id: String(msg.uid),
            dateIso: msg.internalDate ? new Date(msg.internalDate).toISOString() : nowIso(),
            from: msg.envelope?.from?.[0]?.address || "?",
            subject: msg.envelope?.subject || "(no subject)",
          });
        }
      }
      return out;
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /* ---------------- Mail Body Fetchers (für Buchungserkennung) ---------------- */

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
    ensureM365Configured();
    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
      `/messages/${encodeURIComponent(messageId)}?$select=body,subject,from`;

    const data = await graphGet(tenantId, clientId, m365Secret, url);
    const bodyContent: string = data?.body?.content || '';
    const contentType: string = data?.body?.contentType || 'html';

    if (contentType.toLowerCase() === 'text') return bodyContent;
    return stripHtml(bodyContent);
  }

  async function yahooFetchBody(uid: string): Promise<string> {
    ensureYahooConfigured();

    const client = createSafeImapClient({ socketTimeout: 20000 });

    try {
      await client.connect();
      await client.mailboxOpen('INBOX');

      const msg: any = await client.fetchOne(uid, { source: true });
      if (!msg || !msg.source) return '';

      // source is a Buffer containing the raw RFC822 message
      const raw = msg.source.toString('utf-8');

      // Simple extraction: find the text/plain part or strip HTML from body
      // Look for the body after headers (double CRLF)
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) return raw.slice(0, 2000);

      const body = raw.slice(headerEnd + 4);

      // Check if it looks like HTML
      if (body.includes('<html') || body.includes('<HTML') || body.includes('<body')) {
        return stripHtml(body).slice(0, 5000);
      }

      // For multipart messages, try to extract text/plain part
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
        // Fallback: look for text/html part and strip
        for (const part of parts) {
          if (part.match(/Content-Type:\s*text\/html/i)) {
            const partBody = part.indexOf('\r\n\r\n');
            if (partBody !== -1) return stripHtml(part.slice(partBody + 4)).slice(0, 5000);
          }
        }
      }

      return body.slice(0, 5000);
    } catch (e: any) {
      api.logger.warn(`[executive-agent] yahooFetchBody(${uid}) Fehler: ${e.message}`);
      return '';
    } finally {
      await client.logout().catch(() => {});
    }
  }

  // analyzeMailForBooking → src/modules/travel/enrichment.ts

  /* ---------------- SMTP (Yahoo) ---------------- */

  function yahooTransport() {
    // Port 587 => STARTTLS (secure:false), Port 465 => SMTPS (secure:true)
    return nodemailer.createTransport({
      host: yahooSmtpHost,
      port: yahooSmtpPort,
      secure: yahooSmtpSecure,
      auth: { user: yahooUser, pass: yahooPass },
      // timeouts to avoid hanging calls
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      // for STARTTLS, enforce TLS upgrade
      requireTLS: !yahooSmtpSecure,
      tls: { servername: "smtp.mail.yahoo.com", minVersion: "TLSv1.2" },
    });
  }

  async function yahooSend(d: MailDraft) {
    ensureYahooConfigured();
    const transporter = yahooTransport();
    await transporter.sendMail({
      from: yahooUser,
      to: d.to.join(", "),
      subject: d.subject,
      text: d.bodyText,
    });
  }

async function createMeetingWithConflictCheck(
  force: boolean,
  tenantId: string,
  clientId: string,
  m365Secret: string,
  m365User: string,
  graphGetFn: typeof graphGet,
  graphPostFn: typeof graphPost,
  input: string
): Promise<{ text: string }> {
  // parse (mit Default-Dauer) – hier Ihren bestehenden Parser verwenden
  const parts = input.trim().split(/\s+/);

  let dateStr: string;
  let timeStr: string;
  let durationMin: number;
  let title: string;

  if (parts.length >= 4 && !isNaN(Number(parts[2]))) {
    dateStr = parts[0];
    timeStr = parts[1];
    durationMin = Number(parts[2]);
    title = parts.slice(3).join(" ");
  } else if (parts.length >= 3) {
    dateStr = parts[0];
    timeStr = parts[1];
    durationMin = 60;
    title = parts.slice(2).join(" ");
  } else {
    return { text: "Usage: /meet DD.MM HH:MM [durationMin] Title" };
  }

  const [day, month] = dateStr.split(".");
  const [hour, minute] = timeStr.split(":");
  if (!day || !month || !hour || !minute || !title) {
    return { text: "Invalid format. Example: /meet 27.02 14:00 60 Strategic Call" };
  }

  const year = new Date().getFullYear();
  const start = new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute), 0);
  const end = new Date(start.getTime() + durationMin * 60000);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return { text: "Invalid date/time." };

  // ---- conflict check via calendarView
  const calUrl =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
    `/calendarView?startDateTime=${encodeURIComponent(start.toISOString())}` +
    `&endDateTime=${encodeURIComponent(end.toISOString())}` +
    `&$select=subject,start,end`;

  const cal = await graphGetFn(tenantId, clientId, m365Secret, calUrl);
// robust conflict scan: query a wider window and check overlaps ourselves
const scanStart = new Date(start.getTime() - 12 * 60 * 60 * 1000).toISOString();
const scanEnd   = new Date(end.getTime()   + 12 * 60 * 60 * 1000).toISOString();

const candidates = await listConflicts(scanStart, scanEnd);

const startMs = start.getTime();
const endMs = end.getTime();

// overlap if: eventStart < end && eventEnd > start
const conflicts = candidates.filter((ev: any) => {
  const s = new Date(ev?.start?.dateTime).getTime();
  const e = new Date(ev?.end?.dateTime).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  return s < endMs && e > startMs;
});

if (conflicts.length && !force) {
  const tz = "Europe/Berlin";
  const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

  const bucket = new Map<string, string[]>();
  for (const ev of conflicts) {
    const s = new Date(ev.start.dateTime);
    const e = new Date(ev.end.dateTime);
    const key = `${fmtTime.format(s)}–${fmtTime.format(e)}`;
    const arr = bucket.get(key) || [];
    arr.push(ev.subject || "(ohne Titel)");
    bucket.set(key, arr);
  }

  const lines: string[] = [];
  for (const [range, subs] of Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`• ${range}`);
    for (const subj of subs) lines.push(`  - ${subj}`);
  }

  return {
    text:
      "⚠️ Zeitraum ist belegt. Termin NICHT erstellt.\n\n" +
      lines.join("\n") +
      "\n\nErzwingen mit:\n" +
      `/meetf ${dateStr} ${timeStr} ${durationMin} ${title}`,
  };
}



  // ---- create event
  const payload: any = {
    subject: title,
    start: { dateTime: start.toISOString(), timeZone: "Europe/Berlin" },
    end: { dateTime: end.toISOString(), timeZone: "Europe/Berlin" },
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
  };

  const createUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}/events`;
  const created = await graphPostFn(tenantId, clientId, m365Secret, createUrl, payload);

  return {
    text:
      `📅 Termin erstellt${conflicts.length ? " (trotz Konflikt)" : ""}:\n\n` +
      `${dateStr}, ${timeStr} (${durationMin} Min)\n` +
      `${title}\n\n` +
      (created?.webLink ? created.webLink : ""),
  };
}


  /* ---------------- Command Guard: suppress AI agent for registered commands ---------------- */

  // All registered plugin commands. When user sends one of these,
  // the AI agent must NOT respond — the command handler handles it.
  const REGISTERED_COMMANDS = new Set([
    'mailstatus', 'scanmail', 'screenshot', 'browse',
    'costs', 'lease', 'leaseset', 'nebenkostenabrechnung',
    'properties', 'property', 'propertyrent',
    'healthalerts', 'healthreportday', 'healthsync', 'healthtrend',
    'withingsauth', 'withingstoken',
    'sharepoint', 'spdocs', 'sprecent', 'spsync',
    'fleet', 'fleetadd', 'fleetdel', 'fleetdocs', 'fleetedit',
    'fleetinsurance', 'fleetlink', 'fleetservice', 'fleetshow', 'fleettuev',
    'link', 'linkadd', 'linkdel', 'triplink', 'fleetlink',
    'pe', 'peedit', 'penew', 'peshow', 'pevalue',
    'insta', 'instaapprove', 'instadraft', 'instadrafts', 'instaedit',
    'instaplan', 'instapost', 'instaposts', 'instastyle', 'instasubmit', 'instasync',
    'instacraft', 'instaforensic', 'instaraw', 'instascan', 'instatokentest', 'instatop', 'instatrend', 'instavariants',
    'trade', 'tradedebug', 'tradeindex', 'trademode', 'tradeorders',
    'tradepaper', 'tradeperf', 'tradepos', 'tradescan', 'tradescanstatus',
    'tradetop', 'tradeuniverse', 'tradeunwatch', 'tradewatch', 'tradewatchlist',
    'briefing', 'briefingtime',
  ]);

  // before_agent_start: fires before every AI agent turn.
  // - For registered commands: instructs AI to stay silent (NO_REPLY) so plugin handler responds.
  // - For voice messages: transcribes audio via Whisper and injects transcript as context.
  // - For bare media (image/video): saves to raw session and suppresses AI commentary.
  api.on('before_agent_start', async (event: any) => {
    const prompt: string = event?.prompt ?? '';

    // Suppress AI for registered commands
    const match = prompt.match(/^\s*\/([a-z_]+)/i);
    if (match) {
      const cmd = match[1].toLowerCase();
      if (REGISTERED_COMMANDS.has(cmd)) {
        api.logger.info(`[executive-agent] command-guard: /${cmd} erkannt — AI agent wird unterdrückt`);
        return {
          prependContext:
            `CRITICAL INSTRUCTION: The user message is the registered command /${cmd}. ` +
            `A plugin command handler will respond to this command. ` +
            `You MUST NOT generate any response. Reply with exactly: NO_REPLY`,
        };
      }
    }

    // Voice message: transcribe and inject transcript so AI can respond naturally
    const hasAudio = prompt.includes('<media:audio>') || /\[media attached:.*?audio\/ogg/i.test(prompt);
    if (hasAudio) {
      api.logger.info(`[executive-agent] command-guard: Audio erkannt — starte Whisper-Transkription`);
      try {
        const pathMatch = prompt.match(/\[media attached:\s*([^\s(|]+\.(?:ogg|oga|opus|mp3|wav|m4a))/i);
        let audioPath: string | null = null;

        if (pathMatch) {
          audioPath = pathMatch[1];
        } else {
          const recent = findRecentAudioFile();
          audioPath = recent?.path ?? null;
        }

        if (audioPath && fs.existsSync(audioPath)) {
          const transcript = await transcribeVoice(audioPath);
          api.logger.info(`[executive-agent] command-guard: Transkription erfolgreich (${transcript.length} Zeichen)`);
          return {
            prependContext:
              `VOICE MESSAGE TRANSCRIPTION — The user sent a voice message. ` +
              `The following is the transcription of the audio:\n\n` +
              `"${transcript}"\n\n` +
              `Respond to the voice message content naturally. Do NOT say you cannot listen to audio — ` +
              `the transcription above IS the user's message.`,
          };
        } else {
          api.logger.warn(`[executive-agent] command-guard: Audio-Datei nicht gefunden`);
        }
      } catch (e: any) {
        api.logger.error(`[executive-agent] command-guard: Whisper-Transkription fehlgeschlagen: ${e?.message}`);
      }
    }

    // Bare media (image/video): save to raw session and suppress AI commentary.
    // The prompt contains [media attached: /path/to/file.jpg (image/jpeg) | ...] after media understanding.
    const IMAGE_VIDEO_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'mp4', 'mov', 'avi', 'mkv', 'webm'];
    const mediaMatches = [...prompt.matchAll(/\[media attached(?:\s+\d+\/\d+)?:\s*([^\s|)]+)/gi)];
    const mediaFiles = mediaMatches
      .map(m => m[1])
      .filter(p => {
        const ext = p.split('.').pop()?.toLowerCase() || '';
        return IMAGE_VIDEO_EXTS.includes(ext);
      });

    if (mediaFiles.length > 0) {
      // Bare media detection: the gateway uses <media:image>/<media:video> placeholders
      // ONLY when the message has no user-provided text (no caption).
      // If the user sends an image with a caption, the placeholder is replaced by the caption text.
      const isBareMedia = prompt.includes('<media:image>') || prompt.includes('<media:video>');

      api.logger.info(`[executive-agent] command-guard: Media erkannt (${mediaFiles.length} Dateien), bare=${isBareMedia}`);

      if (isBareMedia) {
        // Skip if instasubmit flow is active
        if (instaSubmitActive.size > 0 || Date.now() - instaSubmitLastActivatedAt < 120_000) {
          api.logger.info(`[executive-agent] command-guard: Media übersprungen — instasubmit aktiv`);
          return; // Let AI handle normally (instasubmit flow)
        }

        // Check for pending instasubmit
        for (const [, pending] of pendingInstaSubmits) {
          if (Date.now() < pending.expiresAt) {
            api.logger.info(`[executive-agent] command-guard: Media übersprungen — pending instasubmit`);
            return; // Let instasubmit-media-handler deal with it
          }
        }

        // Extract chatId from prompt metadata
        const chatIdMatch = prompt.match(/id:(\d{5,})/);
        const chatId = chatIdMatch?.[1] || '';

        try {
          // Find or create active raw session for this sender
          const senderId = chatId;
          let sessionId = senderId ? activeRawSessions.get(senderId) : undefined;
          let session: RawSession | null = sessionId ? loadRawSession(sessionId) : null;
          if (!session || session.status !== 'active') {
            sessionId = generateRawSessionId();
            session = createRawSession(sessionId);
            if (senderId) activeRawSessions.set(senderId, sessionId);
            api.logger.info(`[executive-agent] command-guard: Neue Raw-Session erstellt: ${sessionId}`);
          }

          // Copy each media file to session/original/ with speaking names
          const saved: string[] = [];
          const origDir = path.join(sessionDir(session.id), 'original');
          const existingCount = fs.existsSync(origDir)
            ? fs.readdirSync(origDir).filter(f => !f.startsWith('.')).length
            : 0;
          let fileNum = existingCount;
          for (const filePath of mediaFiles) {
            if (!fs.existsSync(filePath)) {
              api.logger.warn(`[executive-agent] command-guard: Media-Datei nicht gefunden: ${filePath}`);
              continue;
            }
            fileNum++;
            const ext = path.extname(filePath).toLowerCase() || '.bin';
            const now = new Date();
            const yymmdd = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
            const newName = `${yymmdd}-jb-${String(fileNum).padStart(2, '0')}${ext}`;
            const destPath = path.join(origDir, newName);
            fs.copyFileSync(filePath, destPath);
            const fileSize = fs.statSync(destPath).size;
            const fileType = detectMediaType(newName) || 'document';

            session.files.push({
              name: newName,
              size: fileSize,
              type: fileType,
              addedAt: new Date().toISOString(),
            });
            saved.push(`${newName} (${formatFileSize(fileSize)})`);
          }

          if (saved.length > 0) {
            saveRawSession(session);
            api.logger.info(`[executive-agent] command-guard: ${saved.length} Dateien → ${session.id}`);

            // Send Telegram confirmation with inline submit button
            if (chatId) {
              const msg = saved.length === 1
                ? `📥 ${saved[0]} → Session ${session.id}`
                : `📥 ${saved.length} Dateien → Session ${session.id}`;
              const keyboard = [[
                { text: '▶️ Jetzt submitten', callback_data: `isub_${session.id}`.slice(0, 64) },
              ]];
              sendTelegramWithKeyboard(chatId, msg, keyboard).catch(err => {
                // Fallback to plain text if keyboard fails
                sendTelegram(chatId, msg).catch(() => {});
                api.logger.error(`[executive-agent] command-guard: Telegram-Bestätigung fehlgeschlagen: ${err?.message}`);
              });
            }

            // Suppress AI commentary — media was handled
            return {
              prependContext:
                `SYSTEM: The user sent ${saved.length} media file(s) which have been automatically saved to raw material session "${session.id}". ` +
                `A confirmation message has already been sent to the user. ` +
                `You MUST NOT describe, analyze, or comment on the image/video content. ` +
                `Reply with exactly: NO_REPLY`,
            };
          }
        } catch (e: any) {
          api.logger.error(`[executive-agent] command-guard: Raw-Session-Speicherung fehlgeschlagen: ${e?.message}\n${e?.stack || ''}`);
          // Fall through — let AI handle normally
        }
      }
      // If not bare media (has caption text), let AI respond normally
    }
  }, { priority: 100 });

  /* ---------------- Commands ---------------- */

  api.registerCommand({
    name: "mailstatus",
    description: "Mail status (Executive-Agent only)",
    requireAuth: true,
    handler: () => {
      const m365Ok = m365Enabled && tenantId && clientId && m365User && m365Secret;
      const yOk = yahooEnabled && yahooUser && yahooImapHost && yahooSmtpHost && yahooPass;

      return {
        text:
          "📬 Mail-Status (Executive-Agent)\n\n" +
          `• M365: ${m365Ok ? "✅" : "❌"}  (${m365User || "(unset)"})\n` +
          `• Yahoo: ${yOk ? "✅" : "❌"}  (${yahooUser || "(unset)"})\n` +
          `• Send-Policy: ${requireApproval ? "requireApproval=true ✅" : "requireApproval=false ⚠️"}\n\n` +
          "Hinweis: prüft nur plugins.entries.executive-agent.config + ENV Secrets (nicht daily-briefing/skills)."
      };
    },
  });

  // Executive brief: inbox unread + next events + open drafts
  api.registerCommand({
    name: "brief",
    description: "Executive snapshot: unread inbox + next events + open drafts. Usage: /brief",
    requireAuth: true,
    handler: async () => {
      const tz = "Europe/Berlin";
      const now = new Date();
      const fmtNow = new Intl.DateTimeFormat("de-DE", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const parts: string[] = [];
      parts.push(`🧠 Brief — ${fmtNow.format(now)}`);
      parts.push("");

      // (A) Unread unified inbox (top 5)
      try {
        const n = 5;
        const perSource = 10;
        const [mMsgs, yMsgs] = await Promise.all([
          m365Enabled ? m365Unread(perSource) : Promise.resolve([]),
          yahooEnabled ? yahooUnread(perSource) : Promise.resolve([]),
        ]);
        const combined = [...mMsgs, ...yMsgs].sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1)).slice(0, n);

        parts.push("📥 Unread Inbox (top 5)");
        if (!combined.length) {
          parts.push("• keine ungelesenen Mails");
        } else {
          for (const m of combined) {
            const src = m.source === "m365" ? "[M365]" : "[YAHOO]";
            const dt = m.dateIso.replace("T", " ").replace("Z", "Z");
            parts.push(`• ${src} ${dt} — ${m.from} — ${m.subject}`);
          }
        }
        parts.push("");
      } catch (e) {
        parts.push("📥 Unread Inbox");
        parts.push("• ❌ Fehler beim Laden");
        parts.push("");
      }

      // (B) Next events (top 3, next 7 days)
      try {
        if (!m365Enabled) throw new Error("m365_disabled");
        ensureM365Configured();

        const start = new Date();
        const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        let url =
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
          `/calendarView?startDateTime=${encodeURIComponent(start.toISOString())}` +
          `&endDateTime=${encodeURIComponent(end.toISOString())}` +
          `&$select=subject,start,end,location` +
          `&$orderby=start/dateTime`;

        const events: any[] = [];
        for (let i = 0; i < 10 && events.length < 3; i++) {
          const json = await graphGet(tenantId, clientId, m365Secret, url);
          if (Array.isArray(json?.value)) events.push(...json.value);
          const next = json?.["@odata.nextLink"];
          if (!next) break;
          url = next;
        }

        const fmtDate = new Intl.DateTimeFormat("de-DE", {
          timeZone: tz,
          weekday: "short",
          month: "2-digit",
          day: "2-digit",
        });
        const fmtTime = new Intl.DateTimeFormat("de-DE", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });

        parts.push("📅 Next Events (top 3)");
        const top = events.slice(0, 3);
        if (!top.length) {
          parts.push("• keine Termine (7 Tage)");
        } else {
          for (const ev of top) {
            const subj = ev?.subject || "(ohne Titel)";
            const sdt = ev?.start?.dateTime ? new Date(ev.start.dateTime) : null;
            const edt = ev?.end?.dateTime ? new Date(ev.end.dateTime) : null;
            const when =
              sdt && edt
                ? `${fmtDate.format(sdt)} ${fmtTime.format(sdt)}–${fmtTime.format(edt)}`
                : "(time?)";
            const loc = ev?.location?.displayName ? ` | ${ev.location.displayName}` : "";
            parts.push(`• ${when} — ${subj}${loc}`);
          }
        }
        parts.push("");
      } catch (e) {
        parts.push("📅 Next Events");
        parts.push("• ❌ Fehler beim Laden");
        parts.push("");
      }

      // (C) Open drafts (status=draft, top 5)
      try {
        const ds = listDrafts("draft", 5);
        parts.push("📝 Drafts (open, top 5)");
        if (!ds.length) {
          parts.push("• keine offenen Drafts");
        } else {
          for (const d of ds) {
            parts.push(`• ${d.id} [${d.account}] — To: ${(d.to || []).join(", ")} — ${d.subject}`);
          }
        }
        parts.push("");
      } catch (e) {
        parts.push("📝 Drafts");
        parts.push("• ❌ Fehler beim Laden");
        parts.push("");
      }

      return { text: parts.join("\n").trim() };
    },
  });

  // Unified inbox: unread + chronological
  api.registerCommand({
    name: "inbox",
    description: "Unified inbox (default: unread). Usage: /inbox [n] | /inbox last [24h] [n]",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || "").trim();
        const tokens = raw ? raw.split(/\s+/) : [];

        let mode: "unread" | "last" = "unread";
        let hours: number | undefined = undefined;
        let n: any = 10;

        if (tokens[0]?.toLowerCase() === "last") {
          mode = "last";
          const t1 = tokens[1];
          const t2 = tokens[2];

          if (t1 && /h$/i.test(t1)) {
            const h = Number(t1.replace(/h$/i, ""));
            if (Number.isFinite(h) && h > 0) hours = h;
            if (t2) n = Number(t2);
          } else if (t1) {
            n = Number(t1);
          }
        } else if (tokens[0]) {
          n = Number(tokens[0]);
        }

        n = Math.max(1, Math.min(20, Number.isFinite(n) ? Number(n) : 10));
        const perSource = Math.max(10, n); // fetch a bit more per source for better merge

        const [mMsgs, yMsgs] =
          mode === "last"
            ? await Promise.all([
                m365Enabled ? m365Recent(perSource, hours) : Promise.resolve([]),
                yahooEnabled ? yahooRecent(perSource, hours) : Promise.resolve([]),
              ])
            : await Promise.all([
                m365Enabled ? m365Unread(perSource) : Promise.resolve([]),
                yahooEnabled ? yahooUnread(perSource) : Promise.resolve([]),
              ]);

        const combined = [...mMsgs, ...yMsgs]
          .sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1))
          .slice(0, n);

        if (!combined.length) {
          return {
            text:
              mode === "last"
                ? "📥 Unified Inbox: keine Mails im gewählten Zeitraum."
                : "📥 Unified Inbox: keine ungelesenen Mails."
          };
        }

        const lines = combined.map(m => {
          const src = m.source === "m365" ? "[M365]" : "[YAHOO]";
          const dt = m.dateIso.replace("T", " ").replace("Z", "Z");
          return `${src} ${dt} | ${m.from}\n${m.subject}\n(id: ${m.id})`;
        });

        const title =
          mode === "last"
            ? `📥 Unified Inbox (last${hours ? " " + hours + "h" : ""}, top ${n})`
            : `📥 Unified Inbox (unread, top ${n})`;

        return { text: `${title}\n\n${lines.join("\n\n")}` };
      } catch (e: any) {
        return { text: `❌ /inbox failed: ${e.message}` };
      }
    },
  });

  // Yahoo-only inbox (unread)
  api.registerCommand({
    name: "yinbox",
    description: "Yahoo unread. Usage: /yinbox [n]",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const n = Math.max(1, Math.min(20, Number(String(ctx.args || "5").trim() || "5")));
        const msgs = await yahooUnread(n);
        if (!msgs.length) return { text: "📥 Yahoo: keine ungelesenen Mails." };
        return { text: "📥 Yahoo (unread)\n\n" + msgs.map(m => `${m.id}\n  ${m.dateIso} | ${m.from}\n  ${m.subject}`).join("\n\n") };
      } catch (e: any) {
        return { text: `❌ /yinbox failed: ${e.message}` };
      }
    },
  });

  // Verify Yahoo SMTP
  api.registerCommand({
    name: "yverify",
    description: "Verify Yahoo SMTP connectivity. Usage: /yverify",
    requireAuth: true,
    handler: async () => {
      try {
        ensureYahooConfigured();
        const t = yahooTransport();
        await t.verify();
        return { text: `✅ Yahoo SMTP verify: OK (port ${yahooSmtpPort}, secure=${yahooSmtpSecure})` };
      } catch (e: any) {
        return { text: `❌ Yahoo SMTP verify FAILED: ${e.message}` };
      }
    },
  });

  // Draft ops (avoid collision with OpenClaw /approve)

  function parseKvArgs(inputRaw: string): Record<string, string> {
    const s = String(inputRaw || "").trim();
    const out: Record<string, string> = {};
    if (!s) return out;

    // Tokenize: key=value where value may be "..." or '...'
    const re = /(\w+)=("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const key = m[1].toLowerCase();
      let val = m[2] || "";
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      val = val.replace(/\\n/g, "\n");
      out[key] = val;
    }
    return out;
  }

  api.registerCommand({
    name: "draftcreate",
    description: 'Create draft quickly. Usage: /draftcreate account=yahoo|m365 to=a@b.com[,c@d.com] subject=... body=...',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      try {
        const kv = parseKvArgs(ctx.args || "");
        const account = (kv.account || "").toLowerCase();
        if (account !== "yahoo" && account !== "m365") return { text: 'Usage: /draftcreate account=yahoo|m365 to=... subject=... body=...' };

        if (account === "yahoo") ensureYahooConfigured();
        if (account === "m365") ensureM365Configured();

        const toRaw = kv.to || "";
        const to = toRaw.split(/[;,]/).map(x => x.trim()).filter(Boolean);
        if (!to.length || !to.every(x => x.includes("@"))) return { text: "❌ Invalid to=. Use: to=a@b.com[,c@d.com]" };

        const subject = kv.subject || "";
        const body = kv.body || "";
        if (!subject) return { text: '❌ Missing subject=. Example: subject=Hello' };
        if (!body) return { text: '❌ Missing body=. Example: body=Line1\\n\\nLine2' };

        const d: MailDraft = {
          id: makeId(account),
          createdAt: nowIso(),
          status: "draft",
          account: account as any,
          user: account === "yahoo" ? yahooUser : m365User,
          to,
          subject,
          bodyText: body,
        };

        saveDraft(d);
        return {
          text:
            `✅ Draft created: ${d.id} [${d.account}]
` +
            `/draftshow ${d.id}
` +
            `/draftedit ${d.id} subject="..."
` +
            `/draftedit ${d.id} body="..."
` +
            `/draftapprove ${d.id}
` +
            `/draftsend ${d.id}`
        };
      } catch (e: any) {
        return { text: `❌ /draftcreate failed: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: "draftedit",
    description: 'Edit draft fields. Usage: /draftedit <id> [to=...] [subject=...] [body=...]',
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      try {
        const raw = String(ctx.args || "").trim();
        const m = raw.match(/^(\S+)\s*(.*)$/);
        if (!m) return { text: 'Usage: /draftedit <id> subject=... | body=... | to=a@b.com[,c@d.com]' };
        const id = m[1];
        const rest = m[2] || "";

        const d = loadDraft(id);
        if (!d) return { text: `Draft not found: ${id}` };
        if (d.status === "sent") return { text: `❌ Draft already sent: ${id}` };

        const kv = parseKvArgs(rest);

        if (kv.to !== undefined) {
          const to = String(kv.to || "").split(/[;,]/).map(x => x.trim()).filter(Boolean);
          if (!to.length || !to.every(x => x.includes("@"))) return { text: "❌ Invalid to=. Use: to=a@b.com[,c@d.com]" };
          d.to = to;
        }
        if (kv.subject !== undefined) {
          const subject = String(kv.subject || "");
          if (!subject) return { text: "❌ subject= cannot be empty" };
          d.subject = subject;
        }
        if (kv.body !== undefined) {
          const body = String(kv.body || "");
          if (!body) return { text: "❌ body= cannot be empty" };
          d.bodyText = body;
        }

        saveDraft(d);
        return { text: `✅ Draft updated: ${id} (${d.status})
/draftshow ${id}` };
      } catch (e: any) {
        return { text: `❌ /draftedit failed: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: "draftlist",
    description: "List open drafts. Usage: /draftlist [n]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const nRaw = String(ctx.args || "").trim();
      const nNum = nRaw ? Number(nRaw) : 5;
      const n = Math.max(1, Math.min(20, Number.isFinite(nNum) ? nNum : 5));

      const ds = listDrafts("draft", n);
      if (!ds.length) return { text: "📝 Drafts: keine offenen Drafts." };

      const lines = ds.map(d => {
        const to = (d.to || []).join(", ");
        const when = String(d.createdAt || "").replace("T", " ").replace("Z", "Z");
        return `• ${d.id} [${d.account}] ${when}\n  To: ${to}\n  ${d.subject}`;
      });

      return { text: `📝 Drafts (open, top ${n})\n\n${lines.join("\n\n")}` };
    },
  });

  api.registerCommand({
    name: "draftshow",
    description: "Show draft. Usage: /draftshow <draftId>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const id = String(ctx.args || "").trim();
      if (!id) return { text: "Usage: /draftshow <draftId>" };
      const d = loadDraft(id);
      if (!d) return { text: `Draft not found: ${id}` };
      return { text: `🧾 ${d.id} (${d.status}) [${d.account}]\nTo: ${d.to.join(", ")}\nSubject: ${d.subject}\n\n${d.bodyText}` };
    },
  });

  api.registerCommand({
    name: "draftapprove",
    description: "Approve draft (plugin). Usage: /draftapprove <draftId>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      const id = String(ctx.args || "").trim();
      if (!id) return { text: "Usage: /draftapprove <draftId>" };
      const d = loadDraft(id);
      if (!d) return { text: `Draft not found: ${id}` };
      d.status = "approved";
      saveDraft(d);
      return { text: `✅ Draft approved: ${id}\nNow: /draftsend ${id}` };
    },
  });

  api.registerCommand({
    name: "draftsend",
    description: "Send approved draft. Usage: /draftsend <draftId>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        const id = String(ctx.args || "").trim();
        if (!id) return { text: "Usage: /draftsend <draftId>" };
        const d = loadDraft(id);
        if (!d) return { text: `Draft not found: ${id}` };
        if (requireApproval && d.status !== "approved") return { text: `❌ Draft not approved. Run /draftapprove ${id}` };
        if (d.status === "sent") return { text: `ℹ️ Draft already sent: ${id}` };

        if (d.account === "yahoo") {
          await yahooSend(d);
        } else {
  ensureM365Configured();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}/sendMail`;
 const payload = {
    message: {
      subject: d.subject,
      body: { contentType: "Text", content: d.bodyText },
      toRecipients: d.to.map(addr => ({ emailAddress: { address: addr } })),
    },
    saveToSentItems: true,
  };
  await graphPost(tenantId, clientId, m365Secret, url, payload);
        }

        d.status = "sent";
        saveDraft(d);
        return { text: `📤 Sent draft: ${id} via ${d.account}` };
      } catch (e: any) {
        return { text: `❌ /draftsend failed: ${e.message}` };
      }
    },
  });

  // Create Yahoo test draft
  api.registerCommand({
    name: "ytest",
    description: "Create Yahoo test draft. Usage: /ytest <email>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      try {
        ensureYahooConfigured();
        const to = String(ctx.args || "").trim();
        if (!to.includes("@")) return { text: "Usage: /ytest <email>" };

        const d: MailDraft = {
          id: makeId("yahoo"),
          createdAt: nowIso(),
          status: "draft",
          account: "yahoo",
          user: yahooUser,
          to: [to],
          subject: "Yahoo Test (Hans Dampf)",
          bodyText: "Hallo,\n\nDies ist eine Yahoo-Testmail.\n\n—\n" + sigYahoo + "\n",
        };
        saveDraft(d);
        return { text: `✅ Yahoo Draft: ${d.id}\n/draftshow ${d.id}\n/draftapprove ${d.id}\n/draftsend ${d.id}` };
      } catch (e: any) {
        return { text: `❌ /ytest failed: ${e.message}` };
      }
    },
  });
  // M365 calendar: next 7 days
  api.registerCommand({
    name: "calendar",
    description: "M365 Calendar (next 7 days). Usage: /calendar",
    requireAuth: true,
    handler: async () => {
      try {
        ensureM365Configured();

        const start = new Date();
        const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        const startIso = start.toISOString();
        const endIso = end.toISOString();

        let url =
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
          `/calendarView?startDateTime=${encodeURIComponent(startIso)}` +
          `&endDateTime=${encodeURIComponent(endIso)}` +
          `&$select=subject,start,end,isAllDay,location,organizer,onlineMeeting` +
          `&$orderby=start/dateTime`;

        const events: any[] = [];
        for (let i = 0; i < 10; i++) {
          const json = await graphGet(tenantId, clientId, m365Secret, url);
          if (json?.value?.length) events.push(...json.value);
          const next = json?.["@odata.nextLink"];
          if (!next) break;
          url = next;
        }

        if (!events.length) return { text: "📅 Calendar: keine Termine in den nächsten 7 Tagen." };

        const tz = "Europe/Berlin";
        const fmtDate = new Intl.DateTimeFormat("de-DE", {
          timeZone: tz,
          weekday: "long",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        const fmtTime = new Intl.DateTimeFormat("de-DE", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const dayKey = (d: Date) =>
          new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(d);

        // Group by day
        const groups = new Map<string, any[]>();
        for (const ev of events) {
          const sdt = ev?.start?.dateTime;
          if (!sdt) continue;
          const s = new Date(sdt);
          if (isNaN(s.getTime())) continue;
          const k = dayKey(s);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(ev);
        }

        const days = Array.from(groups.keys()).sort();
 const out: string[] = [];

for (const k of days) {
  const dayEvents = groups.get(k)!;
  dayEvents.sort((a, b) =>
    String(a?.start?.dateTime).localeCompare(String(b?.start?.dateTime))
  );

  const dayDate = new Date(dayEvents[0].start.dateTime);

  out.push(
    `🗓️ ${fmtDate.format(dayDate)}`
  );

  for (const ev of dayEvents) {
    const subj = ev?.subject || "(ohne Titel)";
    const s = new Date(ev.start.dateTime);
    const e = new Date(ev.end.dateTime);
    const time = `${fmtTime.format(s)}–${fmtTime.format(e)}`;

    const loc = ev?.location?.displayName
      ? ` | ${ev.location.displayName}`
      : "";

    out.push(`• ${time}  ${subj}${loc}`);
  }

  out.push("");
}

        return { text: out.join("\n").trim() };
      } catch (e: any) {
        return { text: `❌ /calendar failed: ${e.message}` };
      }
    },
  });


  /* ---------------- Calendar Create + Conflict ---------------- */

  async function listConflicts(startIso: string, endIso: string): Promise<any[]> {
    let url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
      `/calendarView?startDateTime=${encodeURIComponent(startIso)}` +
      `&endDateTime=${encodeURIComponent(endIso)}` +
      `&$select=subject,start,end`;

    const conflicts: any[] = [];
    for (let i = 0; i < 10; i++) {
      const json = await graphGet(tenantId, clientId, m365Secret, url);
      if (Array.isArray(json?.value)) conflicts.push(...json.value);
      const next = json?.["@odata.nextLink"];
      if (!next) break;
      url = next;
    }
    return conflicts;
  }

  function parseMeetArgs(inputRaw: string): {
    dateStr: string;
    timeStr: string;
    durationMin: number;
    title: string;
  } | null {
    const input = String(inputRaw || "").trim();
    if (!input) return null;

    const parts = input.split(/\s+/);
    if (parts.length < 2) return null;

    const tz = "Europe/Berlin";

    function fmtDDMM(d: Date) {
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      return `${dd}.${mm}`;
    }

    function nextWeekday(target: number) {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const cur = d.getDay(); // 0=Sun..6=Sat
      let delta = (target - cur + 7) % 7;
      if (delta === 0) delta = 7; // "next", not "today"
      d.setDate(d.getDate() + delta);
      return d;
    }

    function parseDuration(token?: string): number | null {
      if (!token) return null;
      const t = token.toLowerCase();

      // 45min / 45m
      if (/^\d+(min|m)$/.test(t)) {
        const n = Number(t.replace(/(min|m)$/, ""));
        return Number.isFinite(n) && n > 0 ? n : null;
      }

      // 1h / 1.5h
      if (/^\d+(\.\d+)?h$/.test(t)) {
        const h = Number(t.replace(/h$/, ""));
        return Number.isFinite(h) && h > 0 ? Math.round(h * 60) : null;
      }

      // plain minutes (e.g. 45)
      if (/^\d+$/.test(t)) {
        const n = Number(t);
        return Number.isFinite(n) && n > 0 ? n : null;
      }

      return null;
    }

    // Date token can be DD.MM or heute/morgen or weekday
    const dateTok = parts[0].toLowerCase();
    const timeTok = parts[1];

    let dateStr = "";
    if (/^\d{1,2}\.\d{1,2}$/.test(dateTok)) {
      dateStr = parts[0];
    } else if (dateTok === "heute") {
      dateStr = fmtDDMM(new Date());
    } else if (dateTok === "morgen") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      dateStr = fmtDDMM(d);
    } else {
      const map: Record<string, number> = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };
      if (map[dateTok] !== undefined) {
        dateStr = fmtDDMM(nextWeekday(map[dateTok]));
      } else {
        return null;
      }
    }

    if (!/^\d{1,2}:\d{2}$/.test(timeTok)) return null;
    const timeStr = timeTok;

    // Optional duration as 3rd token
    const dur = parseDuration(parts[2]);
    const durationMin = dur ?? 60;

    // Title starts after date+time(+duration)
    const titleStart = dur ? 3 : 2;
    let title = parts.slice(titleStart).join(" ").trim();

    if (!title) {
      title = `Meeting ${dateStr} ${timeStr}`;
    }

    return { dateStr, timeStr, durationMin, title };
  }

  function buildStartEnd(dateStr: string, timeStr: string, durationMin: number): { start: Date; end: Date } | null {
    const [day, month] = (dateStr || "").split(".");
    const [hour, minute] = (timeStr || "").split(":");
    if (!day || !month || !hour || !minute) return null;

    const year = new Date().getFullYear();
    const start = new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute), 0);
    if (isNaN(start.getTime())) return null;

    const end = new Date(start.getTime() + durationMin * 60000);
    return { start, end };
  }

  async function handleMeet(ctx: any, force: boolean) {
    ensureM365Configured();

    const parsed = parseMeetArgs(ctx.args);
    if (!parsed) {
      return { text: "Usage: /meet DD.MM HH:MM [durationMin] Title\nForce: /meetf DD.MM HH:MM [durationMin] Title" };
    }

    const { dateStr, timeStr, durationMin, title } = parsed;
    const se = buildStartEnd(dateStr, timeStr, durationMin);
    if (!se) return { text: "Invalid date/time. Example: /meet 27.02 14:00 60 Strategic Call" };
    const { start, end } = se;

    const startIso = start.toISOString();
    const endIso = end.toISOString();

    // Conflict check
    // Conflict check (robust): scan wider window and compute overlaps locally
    const scanStartIso = new Date(start.getTime() - 12 * 60 * 60 * 1000).toISOString();
    const scanEndIso   = new Date(end.getTime()   + 12 * 60 * 60 * 1000).toISOString();

    const candidates = await listConflicts(scanStartIso, scanEndIso);

    const startMs = start.getTime();
    const endMs = end.getTime();

    // overlap if: eventStart < end && eventEnd > start
    const conflicts = candidates.filter((ev: any) => {
      const s = new Date(ev?.start?.dateTime).getTime();
      const e = new Date(ev?.end?.dateTime).getTime();
      if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
      return s < endMs && e > startMs;
    });

    if (conflicts.length && !force) {
      const tz = "Europe/Berlin";
      const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

      // group identical time ranges together
      const bucket = new Map<string, string[]>();
      for (const ev of conflicts) {
        const s = new Date(ev.start.dateTime);
        const e = new Date(ev.end.dateTime);
        const key = `${fmtTime.format(s)}–${fmtTime.format(e)}`;
        const arr = bucket.get(key) || [];
        arr.push(ev.subject || "(ohne Titel)");
        bucket.set(key, arr);
      }

      const lines: string[] = [];
      for (const [range, subs] of Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`• ${range}`);
        for (const subj of subs) lines.push(`  - ${subj}`);
      }

      return {
        text:
          "⚠️ Zeitraum ist belegt. Termin NICHT erstellt.\n\n" +
          lines.join("\n") +
          "\n\nErzwingen mit:\n" +
          `/meetf ${dateStr} ${timeStr} ${durationMin} ${title}`,
      };
    }

    // Create
    const payload = {
      subject: title,
      start: { dateTime: startIso, timeZone: "Europe/Berlin" },
      end: { dateTime: endIso, timeZone: "Europe/Berlin" },
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
    };

    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}/events`;
    const created = await graphPost(tenantId, clientId, m365Secret, url, payload);

    return {
      text:
        `📅 Termin erstellt${conflicts.length ? " (trotz Konflikt)" : ""}:\n\n` +
        `${dateStr}, ${timeStr} (${durationMin} Min)\n` +
        `${title}\n\n` +
        (created?.webLink ? created.webLink : ""),
    };
  }

  api.registerCommand({
    name: "meet",
    description: "Create meeting (blocks on conflicts). Usage: /meet DD.MM HH:MM [durationMin] Title",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try { return await handleMeet(ctx, false); }
      catch (e: any) { return { text: `❌ /meet failed: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: "meetf",
    description: "Force create meeting (ignores conflicts). Usage: /meetf DD.MM HH:MM [durationMin] Title",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try { return await handleMeet(ctx, true); }
      catch (e: any) { return { text: `❌ /meetf failed: ${e.message}` }; }
    },
  });

  api.registerCommand({
    name: "free",
    description: "Check availability. Usage: /free DD.MM HH:MM-HH:MM",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        ensureM365Configured();

        const input = String(ctx.args || "").trim();
        const [dateStr, range] = input.split(/\s+/);
        if (!dateStr || !range || !range.includes("-")) {
          return { text: "Usage: /free 26.02 14:00-18:00" };
        }

        const [day, month] = dateStr.split(".");
        const [startStr, endStr] = range.split("-");
        const [sh, sm] = startStr.split(":");
        const [eh, em] = endStr.split(":");

        const year = new Date().getFullYear();
        const start = new Date(year, Number(month) - 1, Number(day), Number(sh), Number(sm), 0);
        const end = new Date(year, Number(month) - 1, Number(day), Number(eh), Number(em), 0);

        if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
          return { text: "Invalid time range. Example: /free 26.02 14:00-18:00" };
        }

        const events = await listConflicts(start.toISOString(), end.toISOString());

        if (!events.length) {
          return { text: `🟢 Frei am ${dateStr} zwischen ${startStr}-${endStr}.` };
        }

        // Build busy intervals
        const busyIntervals = events
          .map((ev: any) => ({
            s: new Date(ev.start.dateTime).getTime(),
            e: new Date(ev.end.dateTime).getTime(),
            subject: ev.subject || "(ohne Titel)",
          }))
          .filter(x => Number.isFinite(x.s) && Number.isFinite(x.e))
          .sort((a, b) => a.s - b.s);

        // Merge to compute free slots
        const free: Array<{ s: number; e: number }> = [];
        let cursor = start.getTime();

        // For display
        const tz = "Europe/Berlin";
        const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

        for (const b of busyIntervals) {
          const bs = Math.max(b.s, start.getTime());
          const be = Math.min(b.e, end.getTime());
          if (be <= cursor) continue;

          if (bs > cursor) free.push({ s: cursor, e: bs });
          cursor = Math.max(cursor, be);
        }
        if (cursor < end.getTime()) free.push({ s: cursor, e: end.getTime() });

        const freeLines = free.length
          ? free.map(x => `• ${fmtTime.format(new Date(x.s))}–${fmtTime.format(new Date(x.e))}`).join("\n")
          : "• (kein freies Zeitfenster)";

        // Group busy by identical time range
        const bucket = new Map<string, string[]>();
        for (const ev of events) {
          const s = new Date(ev.start.dateTime);
          const e = new Date(ev.end.dateTime);
          const key = `${fmtTime.format(s)}–${fmtTime.format(e)}`;
          const arr = bucket.get(key) || [];
          arr.push(ev.subject || "(ohne Titel)");
          bucket.set(key, arr);
        }

        const busyLines: string[] = [];
        for (const [range2, subs] of Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
          busyLines.push(`• ${range2}`);
          for (const subj of subs) busyLines.push(`  - ${subj}`);
        }

        return {
          text:
            `🟢 Frei am ${dateStr} zwischen ${startStr}-${endStr}:\n\n` +
            `${freeLines}\n\n` +
            `🔒 Belegt:\n\n` +
            busyLines.join("\n"),
        };
      } catch (e: any) {
        return { text: `❌ /free failed: ${e.message}` };
      }
    },
  });


  // ── Travel → src/modules/travel/commands.ts ──────────────────────────────
  initTravelCommands({
    sendTelegram,
    sendTelegramWithKeyboard,
    answerCallbackQuery,
    graphPost,
    graphDelete,
    getLinksForEntity,
    formatLinksForTelegram,
    m365Enabled,
    tenantId,
    clientId,
    m365Secret,
    m365User,
  });
  registerTravelCommands(api);

  // ── Health + Withings → src/modules/health/commands.ts ────────────────────
  initHealthCommands({ sendTelegram });
  registerHealthCommands(api);

  // ── Instagram → src/modules/instagram/commands.ts ─────────────────────────
  const metaAppId        = process.env.META_APP_ID || '';
  const metaAppSecret    = process.env.META_APP_SECRET || '';
  const igBusinessId     = process.env.INSTAGRAM_BUSINESS_ID || '';

  initInstagramCommands({
    sendTelegram,
    sendTelegramWithKeyboard,
    answerCallbackQuery,
    telegramBotToken,
    metaAppId,
    metaAppSecret,
    igBusinessId,
  });
  bootstrapInstagramToken(api);
  registerInstagramCommands(api);

  // ── Briefing ───────────────────────────────────────────────────────────────
  // syncWithingsForBriefing → src/modules/health/commands.ts (imported)

  function getBestEffortLocationForBriefing(now: Date): { loc: LocationSetting; isStale: boolean } {
    const s = loadSettings();
    const loc = s.location;

    // Wenn kein Handy-Standort vorhanden: auf gespeicherten/default Standort fallen
    if (!loc || loc.lat == null || loc.lon == null) {
      return { loc: getLocationSettings(), isStale: true };
    }

    // Standort-Frische prüfen, aber NICHT abbrechen
    const updatedAtMs = loc.updatedAt ? Date.parse(loc.updatedAt) : NaN;
    if (!Number.isFinite(updatedAtMs)) {
      return { loc, isStale: true };
    }
    const ageMs = now.getTime() - updatedAtMs;
    const maxAgeMs = 12 * 60 * 60 * 1000;
    return { loc, isStale: ageMs > maxAgeMs };
  }

  async function generateBriefingText(): Promise<string> {
    const tz  = 'Europe/Berlin';
    const now = new Date();
    const SEP = '━━━━━━━━━━━━━━━━━━━━';
    const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const fmtDateFull = new Intl.DateTimeFormat('de-DE', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const parts: string[] = [];

    // ── Header: Datum + Uhrzeit + Standort + Astronomie (immer) ──
    const locInfo = getBestEffortLocationForBriefing(now);
    const loc = locInfo.loc;
    const locAgeMs = loc.updatedAt ? now.getTime() - Date.parse(loc.updatedAt) : Infinity;
    const locLabel = !Number.isFinite(locAgeMs)
      ? `⚠️ ${loc.label} (geschätzt)`
      : locAgeMs > 6 * 3600_000
        ? `⚠️ ${loc.label} (Stand: vor ${Math.round(locAgeMs / 3600_000)}h)`
        : loc.label;
    const astro = getAstroData(now, loc);
    parts.push(`📅 *${fmtDateFull.format(now)} — ${fmtTime.format(now)} Uhr*`);
    parts.push(`📍 ${locLabel}`);
    parts.push(`☀️ Aufgang ${astro.sunrise}  •  Untergang ${astro.sunset}`);
    parts.push(`${astro.moonIcon} ${astro.moonPhase} (${astro.illumination}%)`);
    const moonTimeParts: string[] = [];
    if (astro.moonrise) moonTimeParts.push(`Aufgang ${astro.moonrise}`);
    if (astro.moonset) moonTimeParts.push(`Untergang ${astro.moonset}`);
    const moonTimeStr = moonTimeParts.length ? moonTimeParts.join('  ·  ') : 'nicht sichtbar';
    parts.push(`🌙 ${moonTimeStr}`);

    // ── WETTER + INBOX + KALENDER parallel fetchen ──
    const rangeStart = new Date(now); rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(rangeStart); rangeEnd.setDate(rangeEnd.getDate() + 7); rangeEnd.setHours(23, 59, 59, 999);
    const calUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
      `/calendarView?startDateTime=${encodeURIComponent(rangeStart.toISOString())}` +
      `&endDateTime=${encodeURIComponent(rangeEnd.toISOString())}` +
      `&$select=subject,start,end,location&$orderby=start/dateTime&$top=50`;

    const perSource = 10;
    const [weatherResult, inboxResult, calendarResult] = await Promise.all([
      fetchWeatherBriefing(loc.lat, loc.lon).catch(() => null as any),
      Promise.all([
        m365Enabled ? m365Unread(perSource).catch(() => [] as any[]) : [],
        yahooEnabled ? yahooUnread(perSource).catch(() => [] as any[]) : [],
      ]),
      m365Enabled ? graphGet(tenantId, clientId, m365Secret, calUrl).catch(() => null) : null,
    ]);

    // ── WETTER (reiner Text, Zeilenformat) ──
    if (weatherResult) {
      const w = weatherResult;
      const [td, tm, tu] = w.days;
      parts.push('');
      parts.push(SEP);
      parts.push(`🌤 *WETTER — ${loc.label}*`);
      parts.push(SEP);
      parts.push(`Jetzt: ${w.currentTemp}°C, ${w.currentDesc}`);
      if (w.todayRainHour !== null) parts.push(`🌧 Regen ab ${String(w.todayRainHour).padStart(2, '0')}:00`);
      parts.push('');
      parts.push(`Heute: ${td.min}–${td.max}°C · Wind ${td.wind} · Regen ${td.precip}mm · UV ${td.uv}`);
      parts.push(`Morgen: ${tm.min}–${tm.max}°C · Wind ${tm.wind} · Regen ${tm.precip}mm · UV ${tm.uv}`);
      parts.push(`Überm.: ${tu.min}–${tu.max}°C · Wind ${tu.wind} · Regen ${tu.precip}mm · UV ${tu.uv}`);
      parts.push('');
      parts.push(`Druck: ${w.pressureHpa} hPa (${w.pressureTrend})`);
    }

    // ── INBOX ──
    {
      const [mMsgs, yMsgs] = inboxResult;
      const m365Count = mMsgs.length;
      const yahooCount = yMsgs.length;
      if (m365Count > 0 || yahooCount > 0) {
        const combined = [...mMsgs, ...yMsgs].sort((a: any, b: any) => (a.dateIso < b.dateIso ? 1 : -1));
        const newest = combined[0];
        parts.push('');
        parts.push(SEP);
        parts.push('📬 *INBOX*');
        parts.push(SEP);
        if (m365Count > 0) parts.push(`- ${m365Count} ungelesene M365-Mail${m365Count > 1 ? 's' : ''}`);
        if (yahooCount > 0) parts.push(`- ${yahooCount} ungelesene Yahoo-Mail${yahooCount > 1 ? 's' : ''}`);
        if (newest) parts.push(`  → Neueste: "${newest.subject}" — ${newest.from}`);
      }
    }

    // ── KALENDER (nächste 7 Tage, kompakt) ──
    {
      const allEvs: any[] = calendarResult?.value || [];
      if (allEvs.length > 0) {
        const fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        const fmtWeekday = new Intl.DateTimeFormat('de-DE', { timeZone: tz, weekday: 'short' });
        const fmtDayMonth = new Intl.DateTimeFormat('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit' });

        const byDay = new Map<string, any[]>();
        for (const ev of allEvs) {
          const evDate = new Date(ev.start.dateTime);
          const key = fmtDayKey.format(evDate);
          if (!byDay.has(key)) byDay.set(key, []);
          byDay.get(key)!.push(ev);
        }

        parts.push('');
        parts.push(SEP);
        parts.push('📆 *KALENDER*');
        parts.push(SEP);

        for (const [dayKey, evs] of byDay) {
          const dayDate = new Date(dayKey + 'T12:00:00');
          const wd = fmtWeekday.format(dayDate);
          const dm = fmtDayMonth.format(dayDate);
          const dayLabel = `${wd} ${dm}.`;

          for (let i = 0; i < evs.length; i++) {
            const ev = evs[i];
            const s = new Date(ev.start.dateTime);
            const e = new Date(ev.end.dateTime);
            const diffH = Math.round((e.getTime() - s.getTime()) / 3600000 * 10) / 10;
            const dur = diffH >= 1 ? `(${diffH}h)` : `(${Math.round(diffH * 60)}min)`;
            const prefix = i === 0 ? dayLabel : ' '.repeat(dayLabel.length);
            parts.push(`${prefix}  ${fmtTime.format(s)} ${ev.subject || '(kein Titel)'} ${dur}`);
          }
        }
      }
    }

    // ── DRAFTS ──
    try {
      const ds = listDrafts('draft', 5);
      if (ds.length > 0) {
        parts.push('');
        parts.push(SEP);
        parts.push('✏️ *DRAFTS*');
        parts.push(SEP);
        parts.push(`- ${ds.length} Entwürf${ds.length > 1 ? 'e' : ''} offen`);
        for (let i = 0; i < ds.length; i++) {
          const to = ds[i].to?.join(', ') || '?';
          parts.push(`  → #${i + 1}: "${ds[i].subject}" an ${to}`);
        }
      }
    } catch { /* drafts optional */ }

    // ── INSTAGRAM → src/modules/instagram/commands.ts ──
    {
      const instaLines = await getInstagramBriefingLines(metaAppId, metaAppSecret);
      if (instaLines.length > 0) {
        parts.push('');
        parts.push(SEP);
        parts.push('📸 *INSTAGRAM*');
        parts.push(SEP);
        parts.push(...instaLines);
      }
    }

    // ── HEALTH ──
    {
      const healthLines: string[] = [];
      const wt7 = getWeightTrend(7);
      const lastWeight = lastEntry('weight');

      if (lastWeight && wt7) {
        const arrow = wt7.direction === 'up' ? '↗' : wt7.direction === 'down' ? '↘' : '→';
        const sign = wt7.change > 0 ? '+' : '';
        healthLines.push(`- Gewicht:  ${wt7.current} kg  (Trend: ${arrow} ${sign}${wt7.change} kg/Woche)`);
      } else if (lastWeight) {
        healthLines.push(`- Gewicht:  ${lastWeight.value?.toFixed(1)} kg`);
      }

      // Last night sleep (dedup by day, pick longest)
      const sleepEntries = readEntries().filter(e => e.type === 'sleep');
      const sleepByDay = new Map<string, any>();
      for (const s of sleepEntries) {
        const day = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date(s.timestamp));
        const prev = sleepByDay.get(day);
        if (!prev || (Number(s.value || 0) > Number(prev.value || 0))) sleepByDay.set(day, s);
      }
      // 7-day average
      const sleepDays = Array.from(sleepByDay.values())
        .sort((a: any, b: any) => String(a.timestamp).localeCompare(String(b.timestamp)));
      const lastSleep = sleepDays.length ? sleepDays[sleepDays.length - 1] : null;
      const todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      const lastSleepDay = lastSleep ? new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(lastSleep.timestamp)) : null;

      if (lastSleep && lastSleepDay === todayStr) {
        const val = Number(lastSleep.value || 0);
        const hours = Math.floor(val);
        const mins = Math.round((val - hours) * 60);
        let sleepLine = `- Schlaf:   ${hours}h ${String(mins).padStart(2, '0')}min`;
        const last7 = sleepDays.slice(-7);
        if (last7.length >= 2) {
          const avg = last7.reduce((sum: number, e: any) => sum + Number(e.value || 0), 0) / last7.length;
          const avgH = Math.floor(avg);
          const avgM = Math.round((avg - avgH) * 60);
          sleepLine += `  (Ø 7 Tage: ${avgH}h ${String(avgM).padStart(2, '0')}min)`;
        }
        healthLines.push(sleepLine);
      } else {
        healthLines.push('- Schlaf:   Keine Schlafdaten (letzte Nacht)');
      }

      // Alerts
      const alerts = checkHealthAlerts();
      const activeAlerts = alerts.filter(a => a.severity === 'critical' || a.severity === 'warning');
      if (activeAlerts.length > 0) {
        const alertIcons: Record<string, string> = { critical: '🔴', warning: '⚠️' };
        healthLines.push(`- Alerts:   ${activeAlerts.length > 1 ? `${activeAlerts.length} aktiv` : '⚠️ 1 aktiv'} → "${activeAlerts[0].message}"`);
      }

      if (healthLines.length > 0) {
        parts.push('');
        parts.push(SEP);
        parts.push('❤️ *HEALTH*');
        parts.push(SEP);
        parts.push(...healthLines);
      }
    }

    // ── FUHRPARK — FRISTEN (nur wenn innerhalb 60 Tage) ──
    try {
      const deadlines = checkDeadlines().filter((w: any) => w.severity === 'overdue' || w.daysLeft <= 60);
      if (deadlines.length > 0) {
        parts.push('');
        parts.push(SEP);
        parts.push('🚗 *FUHRPARK — FRISTEN*');
        parts.push(SEP);
        for (const w of deadlines) {
          const icon = w.vehicleType === 'car' ? '🚗' : '🏍';
          const label = w.field === 'tuev' ? 'TÜV' : 'Versicherung';
          if (w.severity === 'overdue') {
            parts.push(`- ${icon} ${w.vehicleName} — ${label} überfällig seit ${Math.abs(w.daysLeft)} Tagen 🔴`);
          } else {
            const dateDE = `${w.date.slice(8, 10)}.${w.date.slice(5, 7)}.${w.date.slice(0, 4)}`;
            parts.push(`- ${icon} ${w.vehicleName} — ${label} in ${w.daysLeft} Tagen (${dateDE}) ⚠️`);
          }
        }
        // Add "Alle anderen: kein Handlungsbedarf" if there are vehicles without deadlines
        const allVehicles = getAllVehicles();
        const vehiclesWithDeadlines = new Set(deadlines.map((d: any) => d.vehicleName));
        if (allVehicles.length > deadlines.length) {
          parts.push('- Alle anderen: kein Handlungsbedarf');
        }
      }
    } catch { /* fleet deadlines optional */ }

    return parts.join('\n').trim();
  }

  api.registerCommand({
    name: 'briefing',
    description: 'Tages-Briefing: Wetter + Kalender + Gesundheit + Drafts',
    handler: async () => {
      try {
        const BRIEFING_TIMEOUT_MS = 45000;
        const briefingWork = async () => {
          // Withings-Sync ZUERST, damit aktuelle Schlafdaten vorhanden sind
          await syncWithingsForBriefing().catch((e: any) => {
            api.logger.warn(`[executive-agent] Briefing Withings-Sync Fehler: ${e.message}`);
          });
          return await generateBriefingText();
        };
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('briefing_timeout')), BRIEFING_TIMEOUT_MS)
        );
        const text = await Promise.race([briefingWork(), timeoutPromise]);
        return { text };
      } catch (e: any) {
        if (e?.message === 'briefing_timeout') {
          return { text: '⏱️ Briefing abgebrochen: Timeout nach 45s. Bitte erneut versuchen.' };
        }
        return { text: `❌ /briefing fehlgeschlagen: ${e.message}` };
      }
    },
  });

  // ── SharePoint-Befehle ──────────────────────────────────────────────────────

  api.registerCommand({
    name: 'sharepoint',
    acceptsArgs: true,
    description: 'SharePoint: Ohne Arg → Sites auflisten. Mit Arg (siteId) → Drives auflisten.',
    handler: async (ctx: any) => {
      if (!m365Enabled || !tenantId || !clientId || !m365Secret) {
        return { text: '❌ M365-Konfiguration fehlt (tenant/client/secret).' };
      }
      const arg = String(ctx.args || '').trim();
      try {
        if (!arg) {
          const sites = await listSites(tenantId, clientId, m365Secret);
          if (!sites.length) return { text: '📂 Keine SharePoint-Sites gefunden.' };
          const lines = sites.map((s, i) => `${i + 1}. **${s.displayName}**\n   ID: \`${s.id}\`\n   ${s.webUrl}`);
          return { text: `📂 **SharePoint-Sites** (${sites.length}):\n\n${lines.join('\n\n')}` };
        } else {
          const drives = await listDrives(tenantId, clientId, m365Secret, arg);
          if (!drives.length) return { text: `📂 Keine Dokumentbibliotheken für Site gefunden.` };
          const lines = drives.map((d, i) => `${i + 1}. **${d.name}** (${d.driveType})\n   ID: \`${d.id}\`\n   ${d.webUrl}`);
          return { text: `📂 **Drives** (${drives.length}):\n\n${lines.join('\n\n')}` };
        }
      } catch (e: any) {
        return { text: `❌ /sharepoint Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'spdocs',
    acceptsArgs: true,
    description: 'SharePoint-Suche im lokalen Index: /spdocs <suchbegriff>',
    handler: async (ctx: any) => {
      const query = String(ctx.args || '').trim();
      if (!query) return { text: '❌ Verwendung: /spdocs <suchbegriff>' };

      const hits = searchLocalIndex(query);
      if (hits === null) {
        const info = getIndexAge();
        if (!info.exists) {
          return { text: '📂 Kein SharePoint-Index vorhanden. Bitte zuerst /spsync ausführen.' };
        }
        return { text: '📂 Index ist leer. Bitte /spsync erneut ausführen.' };
      }

      if (!hits.length) return { text: `🔍 Keine Ergebnisse für „${query}" im lokalen Index.` };
      const info = getIndexAge();
      const syncInfo = info.syncedAt ? ` (Index: ${info.syncedAt.slice(0, 16).replace('T', ' ')}, ${info.fileCount} Dateien)` : '';
      const lines = hits.slice(0, 10).map((h, i) => {
        const size = h.size ? ` · ${(h.size / 1024).toFixed(0)} KB` : '';
        const date = h.lastModifiedDateTime ? ` · ${h.lastModifiedDateTime.slice(0, 10)}` : '';
        const snippet = h.summary ? `\n   ${h.summary}` : '';
        return `${i + 1}. **${h.name}**${size}${date}\n   ${h.webUrl}${snippet}`;
      });
      return { text: `🔍 **Ergebnisse für „${query}"** (${hits.length})${syncInfo}:\n\n${lines.join('\n\n')}` };
    },
  });

  api.registerCommand({
    name: 'sprecent',
    description: 'Kürzlich geänderte SharePoint-Dateien (letzte 24h)',
    handler: async () => {
      if (!m365Enabled || !tenantId || !clientId || !m365Secret) {
        return { text: '❌ M365-Konfiguration fehlt.' };
      }
      try {
        const files = await getRecentFiles(tenantId, clientId, m365Secret);
        if (!files.length) return { text: '📂 Keine Änderungen in den letzten 24 Stunden.' };
        const top = files.slice(0, 15);
        const lines = top.map((f, i) => {
          const date = f.lastModifiedDateTime ? f.lastModifiedDateTime.slice(0, 16).replace('T', ' ') : '';
          const size = f.size ? ` · ${(f.size / 1024).toFixed(0)} KB` : '';
          return `${i + 1}. **${f.name}**${size}\n   ${date}\n   ${f.webUrl}`;
        });
        return { text: `📂 **Kürzlich geändert** (${files.length}, max 15):\n\n${lines.join('\n\n')}` };
      } catch (e: any) {
        return { text: `❌ /sprecent Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'spsync',
    description: 'SharePoint-Vollsync: alle Sites/Drives/Dateien rekursiv indexieren',
    handler: async () => {
      if (!m365Enabled || !tenantId || !clientId || !m365Secret) {
        return { text: '❌ M365-Konfiguration fehlt.' };
      }
      const s = loadSettings();
      const chatId = s.telegramChatId;

      const send = async (msg: string) => {
        if (!chatId) {
          api.logger.warn('[executive-agent] spsync: kein telegramChatId – Nachricht wird nicht gesendet');
          return;
        }
        await sendTelegram(chatId, msg);
      };

      // fire-and-forget: sofort antworten, sync im Hintergrund
      const syncUser = m365User || process.env.M365_USER || '';

      (async () => {
        const lastTotal = getIndexAge().fileCount || 10000;
        const milestones = [25, 50, 75];
        let nextMilestone = 0;
        try {
          const result = await fullSync(tenantId, clientId, m365Secret, (count) => {
            if (nextMilestone < milestones.length) {
              const pct = Math.round((count / lastTotal) * 100);
              if (pct >= milestones[nextMilestone]) {
                nextMilestone++;
                send(`🔄 Sync läuft... ${pct}% (${count} Dateien)`).catch(() => {});
              }
            }
          }, syncUser || undefined);

          const durSec = (result.durationMs / 1000).toFixed(1);
          let summary = `✅ SharePoint-Sync abgeschlossen\n\n`;
          summary += `📂 ${result.totalFiles} Dateien · ${result.totalSites} Sites · ${result.totalDrives} Drives\n`;
          summary += `⏱ ${durSec}s`;
          if (result.skippedSites?.length) {
            summary += `\n\n⚠️ ${result.skippedSites.length} Sites übersprungen: ${result.skippedSites.join(', ')} (Blacklist)`;
          }
          if (result.errors.length) {
            summary += `\n\n⚠️ ${result.errors.length} Fehler:\n` + result.errors.slice(0, 5).map((e: string) => `• ${e}`).join('\n');
          }
          api.logger.info(`[executive-agent] spsync: ${result.totalFiles} files, ${result.totalSites} sites, ${result.totalDrives} drives, ${durSec}s`);
          await send(summary);
        } catch (e: any) {
          const msg = e?.message || String(e);
          api.logger.error(`[executive-agent] spsync error: ${msg}`);
          await send(`❌ SharePoint-Sync fehlgeschlagen: ${msg}`);
        }
      })().catch(e => {
        api.logger.error(`[executive-agent] spsync unhandled: ${e?.message || e}`);
      });

      return { text: '🔄 SharePoint-Vollsync gestartet. Fortschritt kommt via Telegram.' };
    },
  });

  // ── Fuhrpark-Befehle → src/modules/fleet/commands.ts ──────────────────────
  initFleetCommands({ getLinksForEntity, formatLinksForTelegram });
  registerFleetCommands(api);

  // ── Private Equity → src/modules/pe/commands.ts ──────────────────────────
  registerPECommands(api);

  // ── Trading ─────────────────────────────────────────────────────────────────

  const TRADING_URL = 'http://127.0.0.1:18793';

  async function tradingFetch(path: string, opts?: RequestInit & { timeoutMs?: number }): Promise<any> {
    try {
      const { timeoutMs, ...fetchOpts } = opts || {} as any;
      const r = await fetch(`${TRADING_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs || 5000), ...fetchOpts });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  function fmtTradingNum(n: number, d = 2): string {
    return n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function pnlSign(n: number): string {
    return n >= 0 ? `+${fmtTradingNum(n)}` : fmtTradingNum(n);
  }

  api.registerCommand({
    name: 'trade',
    description: 'Trading-Status: Modus, Positionen, P&L',
    handler: async () => {
      const s = await tradingFetch('/status');
      if (!s) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      const modeLabel = s.mode === 1 ? 'Monitoring' : s.mode === 2 ? 'Semi-Auto' : 'Full-Auto';
      return {
        text: [
          `📈 *Trading Status*`,
          ``,
          `Modus: ${s.mode} — ${modeLabel}`,
          `Verbindung: ${s.connected ? '✅ Verbunden' : '❌ Nicht verbunden'}`,
          `Paper: ${s.paperMode ? 'Ja' : 'Nein'}`,
          `Konto: ${s.account || '—'}`,
          ``,
          `Net Liquidation: ${fmtTradingNum(s.netLiquidation)} $`,
          `Cash: ${fmtTradingNum(s.cashBalance)} $`,
          `Tages-P&L: ${pnlSign(s.dailyPnl)} $`,
          `Unrealisiert: ${pnlSign(s.unrealizedPnl)} $`,
          `Realisiert: ${pnlSign(s.realizedPnl)} $`,
          ``,
          `Positionen: ${s.positions.length}`,
          `Stand: ${s.timestamp}`,
        ].join('\n'),
      };
    },
  });

  api.registerCommand({
    name: 'tradepos',
    description: 'Offene Trading-Positionen',
    handler: async () => {
      const s = await tradingFetch('/status');
      if (!s) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      if (!s.positions || s.positions.length === 0) return { text: 'Keine offenen Positionen.' };
      const lines = s.positions.map((p: any) =>
        `${p.symbol} | ${p.quantity} @ ${fmtTradingNum(p.avgCost)} | Markt: ${fmtTradingNum(p.marketPrice)} | P&L: ${pnlSign(p.unrealizedPnl)}`
      );
      return { text: ['📊 *Positionen*', '', ...lines].join('\n') };
    },
  });

  api.registerCommand({
    name: 'tradeorders',
    description: 'Offene Trading-Orders',
    handler: async () => {
      return { text: 'Keine offenen Orders. (Phase 1 — nur Monitoring)' };
    },
  });

  api.registerCommand({
    name: 'trademode',
    acceptsArgs: true,
    description: 'Trading-Modus anzeigen/setzen: /trademode [1|2|3]',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      if (!raw) {
        const s = await tradingFetch('/status');
        if (!s) return { text: '⚠️ Trading-Service nicht erreichbar.' };
        const labels: Record<number, string> = { 1: 'Monitoring', 2: 'Semi-Auto', 3: 'Full-Auto' };
        return { text: `Trading-Modus: ${s.mode} — ${labels[s.mode] || '?'}` };
      }
      const mode = Number(raw);
      if (![1, 2, 3].includes(mode)) return { text: '❌ Verwendung: /trademode 1|2|3\n1=Monitoring, 2=Semi-Auto, 3=Full-Auto' };
      const result = await tradingFetch('/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!result) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      return { text: `✅ Trading-Modus auf ${result.mode} — ${result.label} gesetzt.` };
    },
  });

  api.registerCommand({
    name: 'tradewatch',
    acceptsArgs: true,
    description: 'Symbol zur Watchlist: /tradewatch AAPL [SMART] [USD]',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      if (!raw) return { text: '❌ Verwendung: /tradewatch AAPL [SMART] [USD]' };
      const parts = raw.split(/\s+/);
      const symbol = parts[0].toUpperCase();
      const exchange = parts[1] || 'SMART';
      const currency = parts[2] || 'USD';
      const list = await tradingFetch('/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, exchange, currency }),
      });
      if (!list) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      return { text: `✅ ${symbol} zur Watchlist hinzugefügt. (${list.length} Einträge)` };
    },
  });

  api.registerCommand({
    name: 'tradeunwatch',
    acceptsArgs: true,
    description: 'Symbol von Watchlist entfernen: /tradeunwatch AAPL',
    handler: async (ctx: any) => {
      const symbol = String(ctx.args || '').trim().toUpperCase();
      if (!symbol) return { text: '❌ Verwendung: /tradeunwatch AAPL' };
      const list = await tradingFetch(`/watchlist/${symbol}`, { method: 'DELETE' });
      if (!list) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      return { text: `✅ ${symbol} von Watchlist entfernt. (${list.length} Einträge)` };
    },
  });

  api.registerCommand({
    name: 'tradewatchlist',
    description: 'Aktuelle Trading-Watchlist',
    handler: async () => {
      const list = await tradingFetch('/watchlist');
      if (!list) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      if (!list.length) return { text: 'Watchlist ist leer.' };
      const lines = list.map((w: any) =>
        `${w.symbol} (${w.exchange}/${w.currency})${w.lastPrice ? ` — ${fmtTradingNum(w.lastPrice)}` : ''}`
      );
      return { text: ['👁 *Watchlist*', '', ...lines].join('\n') };
    },
  });

  api.registerCommand({
    name: 'tradepaper',
    description: 'Paper-Trading Status',
    handler: async () => {
      const h = await tradingFetch('/health');
      if (!h) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      return {
        text: [
          '📋 *Paper-Trading Status*',
          '',
          `Service: ${h.ok ? '✅ Läuft' : '❌ Fehler'}`,
          `IBKR-Verbindung: ${h.connected ? '✅ Verbunden' : '❌ Nicht verbunden'}`,
          `Modus: Paper Trading (Port 7497)`,
          '',
          'Phase 1: Nur Monitoring, keine Order-Ausführung.',
        ].join('\n'),
      };
    },
  });

  api.registerCommand({
    name: 'tradeperf',
    description: 'Trading-Performance (Tag/Woche/Monat)',
    handler: async () => {
      const s = await tradingFetch('/status');
      if (!s) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      return {
        text: [
          '📊 *Trading Performance*',
          '',
          `Tages-P&L: ${pnlSign(s.dailyPnl)} $`,
          `Unrealisiert: ${pnlSign(s.unrealizedPnl)} $`,
          `Realisiert: ${pnlSign(s.realizedPnl)} $`,
          `Net Liquidation: ${fmtTradingNum(s.netLiquidation)} $`,
          `Cash: ${fmtTradingNum(s.cashBalance)} $`,
        ].join('\n'),
      };
    },
  });

  // ── Universe Commands ────────────────────────────────────────────────────────

  api.registerCommand({
    name: 'tradeuniverse',
    description: 'Aktives Trading-Universum anzeigen',
    handler: async () => {
      const data = await tradingFetch('/universe');
      if (!data) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      if (!data.symbols || data.symbols.length === 0) {
        return { text: '🌐 Universum ist leer. Noch kein Scan durchgeführt.\n\nManual: /tradescan' };
      }
      const byIndex: Record<string, number> = {};
      for (const s of data.symbols) {
        byIndex[s.index] = (byIndex[s.index] || 0) + 1;
      }
      const indexLines = Object.entries(byIndex).map(([idx, cnt]: [string, number]) => `  ${idx}: ${cnt}`);
      const topSymbols = data.symbols.slice(0, 10).map((s: any) => s.symbol).join(', ');
      return {
        text: [
          '🌐 *Aktives Universum*',
          '',
          `Gesamt: ${data.symbols.length} Symbole`,
          ...indexLines,
          '',
          `Top: ${topSymbols}`,
          `Letzter Build: ${data.lastBuild ? data.lastBuild.slice(0, 19).replace('T', ' ') : '—'}`,
        ].join('\n'),
      };
    },
  });

  api.registerCommand({
    name: 'tradeindex',
    acceptsArgs: true,
    description: 'Index aktivieren/deaktivieren: /tradeindex on DAX40',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 2 || !['on', 'off'].includes(parts[0])) {
        return { text: '❌ Verwendung: /tradeindex on|off <DAX40|MDAX|SP500|NASDAQ100>' };
      }
      const enabled = parts[0] === 'on';
      const index = parts[1].toUpperCase();
      const result = await tradingFetch('/universe/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indices: { [index]: { enabled } } }),
      });
      if (!result) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      const status = result.indices?.[index]?.enabled ? '✅ aktiviert' : '❌ deaktiviert';
      return { text: `${index}: ${status}` };
    },
  });

  api.registerCommand({
    name: 'tradescan',
    description: 'Manuellen Universe-Scan auslösen',
    handler: async () => {
      const result = await tradingFetch('/universe/scan', { method: 'POST' });
      if (!result) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      if (result.status === 'running') {
        return { text: '📡 Scan läuft bereits. Status prüfen mit /tradescanstatus' };
      }
      return { text: '📡 Scan gestartet. Ergebnis in ~2 Min. Prüfen mit /tradescanstatus' };
    },
  });

  api.registerCommand({
    name: 'tradescanstatus',
    description: 'Status des letzten Universe-Scans',
    handler: async () => {
      const result = await tradingFetch('/universe/scan/status');
      if (!result) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      const statusLabel = result.status === 'running' ? '⏳ Läuft...' : result.status === 'done' ? '✅ Fertig' : result.status === 'error' ? '❌ Fehler' : '💤 Idle';
      return {
        text: [
          '📡 *Scan-Status*',
          '',
          `Status: ${statusLabel}`,
          `Universum: ${result.universe} Symbole`,
          `Momentum: ${result.momentum}`,
          `Mean-Reversion: ${result.meanReversion}`,
          `Zeit: ${result.timestamp?.slice(0, 19).replace('T', ' ') || '—'}`,
        ].join('\n'),
      };
    },
  });

  api.registerCommand({
    name: 'tradetop',
    description: 'Top Trading-Kandidaten anzeigen',
    handler: async () => {
      const results = await tradingFetch('/universe/top?limit=10');
      if (!results) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      if (!results.length) return { text: 'Keine aktuellen Scan-Kandidaten (letzte 2h).' };
      const lines = results.map((r: any) =>
        `${r.symbol} | ${r.signal} | Stärke: ${Number(r.strength).toFixed(1)} | ${r.timestamp?.slice(11, 19) || ''}`
      );
      return { text: ['🏆 *Top-Kandidaten*', '', ...lines].join('\n') };
    },
  });

  api.registerCommand({
    name: 'tradedebug',
    description: 'Scanner-Debug: zeigt wieviele Symbole jede Bedingung erfüllen',
    handler: async () => {
      const stats = await tradingFetch('/debug/scan');
      if (!stats) return { text: '⚠️ Trading-Service nicht erreichbar.' };
      if (stats.error) return { text: `⚠️ ${stats.error}` };

      const m = stats.momentum;
      const mr = stats.meanReversion;
      const ts = stats.timestamp?.slice(0, 19).replace('T', ' ') || '—';

      return {
        text: [
          '🔬 *Scanner Debug*',
          `Analysiert: ${stats.totalAnalyzed} Symbole | ${ts}`,
          '',
          '*Momentum (2 von 3 nötig):*',
          `EMA bullish: ${m.emaBullish} | Cross: ${m.emaCross}`,
          `RSI 50-70: ${m.rsiInZone}`,
          `Vol >120%: ${m.volumeAbove120}`,
          `→ Pass: ${m.passed}`,
          '',
          '*Mean-Reversion (RSI + 1 weitere):*',
          `RSI <35: ${mr.rsiBelow35} | <30: ${mr.rsiBelow30}`,
          `< BB lower: ${mr.belowBBLower} | unteres Drittel: ${mr.inLowerThird}`,
          `Vol >120%: ${mr.volumeAbove120}`,
          `→ Pass: ${mr.passed}`,
        ].join('\n'),
      };
    },
  });

  // ── Briefing-Zeit konfigurieren ────────────────────────────────────────────

  api.registerCommand({
    name: 'briefingtime',
    acceptsArgs: true,
    description: 'Briefing-Uhrzeit setzen: /briefingtime HH:MM  (Europe/Berlin, Standard: 07:00)',
    handler: (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(raw)) return { text: '❌ Verwendung: /briefingtime 07:30' };
      const [h, m] = raw.split(':').map(Number);
      if (h < 0 || h > 23 || m < 0 || m > 59) return { text: '❌ Ungültige Uhrzeit.' };
      const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const s = loadSettings();
      s.briefingTime = time;
      saveSettings(s);
      return {
        text:
          `⏰ Tägliches Briefing auf ${time} Uhr (Europe/Berlin) gesetzt.\n` +
          `Chat-ID: ${s.telegramChatId || '(noch nicht erfasst — sende irgendeine Nachricht)'}`,
      };
    },
  });

  // ── healthreportday → src/modules/health/commands.ts ──────────────────────

  // ── Assets: Immobilienverwaltung → src/modules/assets/commands.ts ────────
  registerAssetsCommands(api);

  // ── Mail-Scanner: Buchungsbestätigungen → Trip-Segmente ────────────────
  // formatBookingMessage → src/modules/travel/enrichment.ts

  /**
   * Scans unread mails for booking confirmations.
   * Returns number of bookings found.
   */
  async function scanMailsForBookings(reportChatId?: string): Promise<{ scanned: number; found: number; details: string[] }> {
    const details: string[] = [];
    let scanned = 0;
    let found = 0;

    // Collect unread mails from enabled accounts
    const allMails: UnifiedMsg[] = [];

    if (m365Enabled) {
      try {
        const msgs = await m365Unread(20);
        allMails.push(...msgs);
      } catch (e: any) {
        api.logger.warn(`[executive-agent] mail-scanner m365 Fehler: ${e.message}`);
      }
    }

    if (yahooEnabled) {
      try {
        const msgs = await yahooUnread(20);
        allMails.push(...msgs);
      } catch (e: any) {
        api.logger.warn(`[executive-agent] mail-scanner yahoo Fehler: ${e.message}`);
      }
    }

    for (const mail of allMails) {
      if (isProcessed(mail.source, mail.id)) continue;

      scanned++;

      try {
        // Fetch body
        let bodyText = '';
        if (mail.source === 'm365') {
          bodyText = await m365FetchBody(mail.id);
        } else {
          bodyText = await yahooFetchBody(mail.id);
        }

        // Analyze with Haiku
        const booking = await analyzeMailForBooking(mail.subject, mail.from, bodyText);

        // Mark as processed regardless of result
        markProcessed(mail.source, mail.id);

        if (booking) {
          found++;
          const msg = formatBookingMessage(booking);
          details.push(msg);

          // Send Telegram notification with inline keyboard
          if (reportChatId) {
            const bookingKey = `booking_${crypto.randomBytes(6).toString('hex')}`;
            pendingBookings.set(bookingKey, {
              booking,
              source: mail.source,
              mailId: mail.id,
              expiresAt: Date.now() + 30 * 60_000, // 30 min expiry
            });

            const keyboard = [
              [
                { text: '🆕 Neue Reise', callback_data: `${bookingKey}::new` },
                { text: '📋 Zu bestehender Reise', callback_data: `${bookingKey}::existing` },
              ],
              [
                { text: '❌ Ignorieren', callback_data: `${bookingKey}::ignore` },
              ],
            ];

            await sendTelegramWithKeyboard(
              reportChatId,
              `${msg}\n\nZu Reise hinzufügen?`,
              keyboard,
            );
          }
        }
      } catch (e: any) {
        api.logger.warn(`[executive-agent] mail-scanner Fehler bei ${mail.source}:${mail.id}: ${e.message}`);
        // Mark as processed to avoid retrying broken mails forever
        markProcessed(mail.source, mail.id);
      }
    }

    return { scanned, found, details };
  }

  api.registerCommand({
    name: 'scanmail',
    description: 'Manueller Mail-Scan auf Buchungsbestätigungen',
    handler: async (ctx: any) => {
      if (!m365Enabled && !yahooEnabled) {
        return { text: '❌ Kein Mail-Account aktiviert (m365/yahoo).' };
      }

      const chatId = String(ctx?.chatId || ctx?.threadId || ctx?.conversationId || ctx?.senderId || '');

      try {
        const { scanned, found, details } = await scanMailsForBookings(chatId);

        if (found === 0) {
          return { text: `✅ ${scanned} neue Mails gescannt — keine Buchungen erkannt.` };
        }

        // When chatId is available, notifications are sent via keyboard messages.
        // Return summary only.
        return { text: `📬 ${scanned} Mails gescannt, ${found} Buchung(en) erkannt.` };
      } catch (e: any) {
        return { text: `❌ Mail-Scan Fehler: ${e.message}` };
      }
    },
  });

  // ── Dokumenten-Verknüpfung (Link-Store) ──────────────────────────────────

  // Pending SP link selection state (per chat)
  const pendingLinkSelections = new Map<string, {
    entityType: string;
    entityId: string;
    results: SpSearchResult[];
    label: string;
    expiresAt: number;
  }>();

  api.registerCommand({
    name: 'link',
    acceptsArgs: true,
    description: 'Verknüpfte Dokumente anzeigen: /link <entityType> <entityId>',
    handler: async (ctx: any) => {
      const parts = String(ctx.args || '').trim().split(/\s+/);
      if (parts.length < 2) return { text: '❌ Verwendung: /link <entityType> <entityId>' };
      const [entityType, entityId] = parts;
      const links = getLinksForEntity(entityType, entityId);
      if (!links.length) return { text: `📎 Keine Dokumente verknüpft mit ${entityType} ${entityId}.` };
      return { text: `📎 Verknüpfte Dokumente (${entityType} ${entityId}):\n\n${formatLinksForTelegram(links)}` };
    },
  });

  api.registerCommand({
    name: 'linkadd',
    acceptsArgs: true,
    description: 'Dokument verknüpfen: /linkadd <entityType> <entityId> sp <suchbegriff> | /linkadd <entityType> <entityId> local <label>',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 4) return { text: '❌ Verwendung:\n/linkadd <entityType> <entityId> sp <suchbegriff>\n/linkadd <entityType> <entityId> local <label>' };

      const [entityType, entityId, docType, ...rest] = parts;

      if (docType === 'sp') {
        const query = rest.join(' ');
        if (!query) return { text: '❌ Suchbegriff fehlt.' };
        const results = searchSharePointForLinking(query);
        if (!results.length) return { text: `❌ Keine Treffer für "${query}" im SharePoint-Index.\nTipp: /spsync falls der Index veraltet ist.` };

        const chatId = String(ctx.chatId || ctx.threadId || ctx.conversationId || ctx.senderId || '');
        pendingLinkSelections.set(chatId, {
          entityType,
          entityId,
          results,
          label: query,
          expiresAt: Date.now() + 5 * 60_000, // 5 min expiry
        });

        const lines = results.map((r, i) => `${i + 1}) ${r.name}\n   ${r.siteName} › ${r.path}`);
        return { text: `📂 Gefunden (${results.length}):\n\n${lines.join('\n\n')}\n\nAntwort mit Nummer zum Verknüpfen:` };
      }

      if (docType === 'local') {
        const label = rest.join(' ') || 'Dokument';
        // The next file sent by user will be linked — for now create a placeholder
        return { text: `📎 Sende jetzt die Datei. Label: "${label}"\n(Lokaler Upload wird beim nächsten Dateiempfang verknüpft)` };
      }

      return { text: '❌ Typ muss "sp" oder "local" sein.' };
    },
  });

  api.registerCommand({
    name: 'linkdel',
    acceptsArgs: true,
    description: 'Verknüpfung entfernen: /linkdel <linkId>',
    handler: async (ctx: any) => {
      const linkId = String(ctx.args || '').trim();
      if (!linkId) return { text: '❌ Verwendung: /linkdel <linkId>' };
      const removed = removeLink(linkId);
      if (!removed) return { text: `❌ Verknüpfung "${linkId}" nicht gefunden.` };
      return { text: `🗑 Verknüpfung ${linkId} entfernt.` };
    },
  });

  // /fleetlink → registered by registerFleetCommands() above

  // Shortcut: /triplink <id> = /link trip <id>
  api.registerCommand({
    name: 'triplink',
    acceptsArgs: true,
    description: 'Reise-Dokumente anzeigen: /triplink <id>',
    handler: async (ctx: any) => {
      const id = String(ctx.args || '').trim();
      if (!id) return { text: '❌ Verwendung: /triplink <id>' };
      const links = getLinksForEntity('trip', id);
      if (!links.length) return { text: `📎 Keine Dokumente verknüpft mit Reise ${id}.` };
      return { text: `📎 Reise-Dokumente (${id}):\n\n${formatLinksForTelegram(links)}` };
    },
  });

  // ── Browser Automation ──────────────────────────────────────────────────────

  api.registerCommand({
    name: 'browse',
    acceptsArgs: true,
    description: 'Webseite besuchen und zusammenfassen: /browse <url>',
    handler: async (ctx: any) => {
      const rawUrl = String(ctx.args || '').trim();
      if (!rawUrl) return { text: '❌ Verwendung: /browse <url>' };
      try {
        const result = await openPage(rawUrl);
        if (!result.content.trim()) {
          return { text: `🌐 *${result.title}*\n${result.url}\n\nKein extrahierbarer Text gefunden.` };
        }
        const apiKey = readAnthropicKey();
        if (apiKey) {
          try {
            const res = await fetchWithTimeout(
              'https://api.anthropic.com/v1/messages',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': apiKey,
                  'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                  model: 'claude-sonnet-4-20250514',
                  max_tokens: 1024,
                  messages: [{
                    role: 'user',
                    content: `Fasse den folgenden Webseiteninhalt zusammen. Kompakt auf Deutsch, maximal 500 Wörter, als Aufzählung wo sinnvoll.\n\nTitel: ${result.title}\nURL: ${result.url}\n\nInhalt:\n${result.content}`,
                  }],
                }),
              },
              60000,
            );
            if (res.ok) {
              const data: any = await res.json();
              const summary = data?.content?.[0]?.text || 'Keine Zusammenfassung erhalten.';
              return { text: `🌐 *${result.title}*\n${result.url}\n\n${summary}` };
            }
          } catch (e: any) {
            api.logger.error(`[executive-agent] /browse Claude summary failed: ${e.message}`);
          }
        }
        // Fallback: raw text truncated
        const truncated = result.content.length > 2000 ? result.content.slice(0, 2000) + '\n…(abgeschnitten)' : result.content;
        return { text: `🌐 *${result.title}*\n${result.url}\n\n${truncated}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'screenshot',
    acceptsArgs: true,
    description: 'Screenshot einer Webseite: /screenshot <url>',
    handler: async (ctx: any) => {
      const rawUrl = String(ctx.args || '').trim();
      if (!rawUrl) return { text: '❌ Verwendung: /screenshot <url>' };
      try {
        const filePath = await screenshot(rawUrl);
        const chatId = String(ctx.chatId || ctx.threadId || ctx.conversationId || ctx.senderId || '');
        if (chatId) {
          await sendTelegramPhoto(chatId, filePath, `📸 ${rawUrl}`);
          return { text: '' };
        }
        return { text: `📸 Screenshot gespeichert: ${filePath}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  // Handle numeric replies for pending SP link selections
  api.on('message_received', (event: any) => {
    try {
      const chatId = String(event?.metadata?.senderId || '');
      if (!chatId) return;
      const pending = pendingLinkSelections.get(chatId);
      if (!pending || Date.now() > pending.expiresAt) {
        if (pending) pendingLinkSelections.delete(chatId);
        return;
      }

      const text = String(event?.content || '').trim();
      const num = parseInt(text, 10);
      if (isNaN(num) || num < 1 || num > pending.results.length) return;

      const selected = pending.results[num - 1];
      const link = addSharePointLink(pending.entityType, pending.entityId, selected, pending.label);
      pendingLinkSelections.delete(chatId);

      // Send confirmation via telegram
      const s = loadSettings();
      if (s.telegramChatId) {
        sendTelegram(s.telegramChatId, `📎 ${selected.name} verknüpft mit ${pending.entityType} ${pending.entityId}\nLabel: ${link.label} | ID: ${link.id}`).catch(() => {});
      }
    } catch {}
  });

  // ── Chat-ID aus eingehenden Nachrichten erfassen ───────────────────────────

  api.on('message_received', (event: any) => {
    try {
      // Prefer real chat id; fallback to sender id.
      const id = String(
        event?.metadata?.senderId || ''
      ).trim();
      if (!id) return;
      const s = loadSettings();
      if (s.telegramChatId !== id) {
        s.telegramChatId = id;
        saveSettings(s);
        api.logger.info(`[executive-agent] telegramChatId gespeichert: ${id}`);
      }
    } catch {}
  });

  // ── Standort via Telegram Location Message speichern ──────────────────────

  api.on('message_received', async (event: any) => {
    try {
      // The gateway formats location messages as text in event.content:
      //   Live:  "🛰 Live location: LAT, LON ±Xm"
      //   Pin:   "📍 LAT, LON ±Xm"
      //   Place: "📍 Name — Address (LAT, LON ±Xm)"
      const content: string = event?.content ?? '';
      if (!content) return;

      // Only process location messages (start with 📍 or 🛰)
      if (!content.startsWith('📍') && !content.startsWith('🛰')) return;

      // Extract coordinates: match "LAT, LON" pattern (decimal numbers)
      const coordMatch = content.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
      if (!coordMatch) return;

      const lat = Number(coordMatch[1]);
      const lon = Number(coordMatch[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      // Reverse-geocoding via Nominatim
      let label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      try {
        const geoRes = await fetchWithTimeout(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=de`,
          { method: 'GET', headers: { 'User-Agent': 'openclaw-executive-agent/1.0' } },
          10000,
        );
        if (geoRes.ok) {
          const geo: any = await geoRes.json();
          label = geo?.address?.city
            || geo?.address?.town
            || geo?.address?.village
            || geo?.address?.municipality
            || geo?.display_name?.split(',')[0]
            || label;
        }
      } catch { /* geocoding optional, keep coordinate label */ }

      const s = loadSettings();
      s.location = { lat, lon, label, updatedAt: new Date().toISOString() };
      saveSettings(s);
      api.logger.info(`[executive-agent] Standort gespeichert: ${label} (${lat}, ${lon})`);

      const chatId = s.telegramChatId;
      if (chatId) {
        sendTelegram(chatId, `📍 Standort gespeichert: ${label}`).catch(() => {});
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] Location-Handler Fehler: ${e?.message}`);
    }
  });

  // ── Booking Callback Handler (Telegram Inline Buttons) ─────────────────────

  // addBookingAsSegment → src/modules/travel/commands.ts

  async function handleBookingCallback(
    callbackQueryId: string,
    chatId: string,
    data: string,
  ): Promise<void> {
    // data format: "booking_<hex>::<action>"
    const sepIdx = data.indexOf('::');
    if (sepIdx === -1) return;

    const bookingKey = data.slice(0, sepIdx);
    const action = data.slice(sepIdx + 2);

    const pending = pendingBookings.get(bookingKey);
    if (!pending || Date.now() > pending.expiresAt) {
      pendingBookings.delete(bookingKey);
      await answerCallbackQuery(callbackQueryId, 'Buchung abgelaufen.');
      return;
    }

    const { booking } = pending;
    const emoji = BOOKING_EMOJI[booking.type] || '📧';

    if (action === 'ignore') {
      pendingBookings.delete(bookingKey);
      await answerCallbackQuery(callbackQueryId, 'Ignoriert');
      await sendTelegram(chatId, `${emoji} ${booking.title} — ignoriert.`);
      return;
    }

    if (action === 'new') {
      pendingBookings.delete(bookingKey);
      await answerCallbackQuery(callbackQueryId, 'Neue Reise wird erstellt...');

      try {
        const tripName = booking.destination || booking.title;
        const startDate = booking.startDate.slice(0, 10); // YYYY-MM-DD
        const endDate = booking.endDate ? booking.endDate.slice(0, 10) : startDate;
        const trip = createTrip(tripName, startDate, endDate, booking.destination);
        await addBookingAsSegment(trip.id, booking);
        await sendTelegram(chatId,
          `✅ Reise *${trip.name}* erstellt (${trip.id})\n${emoji} ${booking.title} als Segment hinzugefügt.`
        );
      } catch (e: any) {
        await sendTelegram(chatId, `❌ Fehler beim Erstellen der Reise: ${e.message}`);
      }
      return;
    }

    if (action === 'existing') {
      await answerCallbackQuery(callbackQueryId, 'Reisen werden geladen...');

      const trips = listTrips();
      if (!trips.length) {
        pendingBookings.delete(bookingKey);
        await sendTelegram(chatId, '❌ Keine bestehenden Reisen gefunden. Nutze "Neue Reise" stattdessen.');
        return;
      }

      // Store pending selection and present numbered list
      pendingTripSelections.set(chatId, {
        bookingKey,
        trips: trips.map(t => ({ id: t.id, name: t.name })),
        expiresAt: Date.now() + 5 * 60_000,
      });

      const lines = trips.map((t, i) => `${i + 1}) ${t.name} (${t.start_date} — ${t.end_date})`);
      await sendTelegram(chatId,
        `📋 Bestehende Reisen:\n\n${lines.join('\n')}\n\nAntwort mit Nummer zum Zuordnen:`
      );
      return;
    }

    // Handle trip selection by number (from callback with trip index)
    if (action.startsWith('trip_')) {
      const tripIdx = parseInt(action.slice(5), 10);
      const trips = listTrips();
      if (isNaN(tripIdx) || tripIdx < 0 || tripIdx >= trips.length) {
        await answerCallbackQuery(callbackQueryId, 'Ungültige Auswahl');
        return;
      }

      pendingBookings.delete(bookingKey);
      await answerCallbackQuery(callbackQueryId, 'Wird hinzugefügt...');

      const trip = trips[tripIdx];
      await addBookingAsSegment(trip.id, booking);
      await sendTelegram(chatId,
        `✅ ${emoji} ${booking.title} zu Reise *${trip.name}* hinzugefügt.`
      );
      return;
    }
  }

  // Hook to handle numeric replies for trip selection (text message after inline button)
  api.on('message_received', async (event: any) => {
    try {
      const chatId = String(event?.metadata?.senderId || '');
      if (!chatId) return;

      const pending = pendingTripSelections.get(chatId);
      if (!pending || Date.now() > pending.expiresAt) {
        if (pending) pendingTripSelections.delete(chatId);
        return;
      }

      const text = String(event?.content || '').trim();
      const num = parseInt(text, 10);
      if (isNaN(num) || num < 1 || num > pending.trips.length) return;

      const selectedTrip = pending.trips[num - 1];
      const bookingEntry = pendingBookings.get(pending.bookingKey);
      pendingTripSelections.delete(chatId);

      if (!bookingEntry) {
        sendTelegram(chatId, '❌ Buchung nicht mehr verfügbar (abgelaufen).').catch(() => {});
        return;
      }

      const { booking } = bookingEntry;
      pendingBookings.delete(pending.bookingKey);

      const emoji = BOOKING_EMOJI[booking.type] || '📧';
      await addBookingAsSegment(selectedTrip.id, booking);
      sendTelegram(chatId,
        `✅ ${emoji} ${booking.title} zu Reise *${selectedTrip.name}* hinzugefügt.`
      ).catch(() => {});
    } catch {}
  });

  // Hook to handle callback_query from Telegram (if framework routes them)
  api.on('message_received', async (event: any) => {
    try {
      const cbq = event?.raw?.callback_query;
      if (!cbq) return;

      const callbackQueryId = String(cbq.id || '');
      const chatId = String(cbq.message?.chat?.id || '');
      const data = String(cbq.data || '');

      if (data.startsWith('segdel_')) {
        const handled = await handleSegmentDeletionCallback(callbackQueryId, chatId, data);
        if (handled) return;
      }

      // Instagram callbacks (icraft_, iscan_, isub_) handled by registerInstagramCommands

      if (!data.startsWith('booking_')) return;
      if (!chatId || !callbackQueryId) return;

      await handleBookingCallback(callbackQueryId, chatId, data);
    } catch (e: any) {
      api.logger.error(`[executive-agent] callback Fehler: ${e?.message}`);
    }
  });

  // ── Mail-Scanner Hintergrund-Task (alle 30 Minuten) ───────────────────────

  setInterval(async () => {
    try {
      if (!m365Enabled && !yahooEnabled) return;
      const s = loadSettings();
      if (!s.telegramChatId) return;

      const { found } = await scanMailsForBookings(s.telegramChatId);
      if (found > 0) {
        api.logger.info(`[executive-agent] Mail-Scanner: ${found} Buchung(en) erkannt`);
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] Mail-Scanner Fehler: ${e.message}`);
    }
  }, 30 * 60_000);

  // ── SharePoint-Polling (alle 30 Minuten) ────────────────────────────────────

  setInterval(async () => {
    try {
      if (!m365Enabled || !tenantId || !clientId || !m365Secret) return;
      const s = loadSettings();
      if (!s.telegramChatId) return;

      const changes = await pollForChanges(tenantId, clientId, m365Secret);
      if (!changes.length) return;

      const lines = changes.slice(0, 10).map(c =>
        `${c.changeType === 'created' ? '🆕' : '✏️'} ${c.fileName}\n   ${c.webUrl}`
      );
      const msg = `📂 **SharePoint-Änderungen** (${changes.length}):\n\n${lines.join('\n\n')}`;
      await sendTelegram(s.telegramChatId, msg);
      api.logger.info(`[executive-agent] SharePoint-Poll: ${changes.length} Änderungen gesendet`);
    } catch (e: any) {
      api.logger.error(`[executive-agent] SharePoint-Poll Fehler: ${e.message}`);
    }
  }, 30 * 60_000);

  // ── Tägliches Briefing (Scheduler, prüft jede Minute) ─────────────────────

  let lastBriefingDate = '';
  let pendingBriefingRetry: { text: string; chatId: string; attempts: number } | null = null;

  setInterval(async () => {
    try {
      const s = loadSettings();
      if (!s.telegramChatId) return;

      // ── Briefing-Retry: zuvor fehlgeschlagene Zustellung nochmal versuchen ──
      if (pendingBriefingRetry && pendingBriefingRetry.attempts < 5) {
        const retry = pendingBriefingRetry;
        const backoffMs = Math.min(1000 * Math.pow(2, retry.attempts), 60000);
        retry.attempts++;
        api.logger.info(`[executive-agent] Briefing-Retry Versuch ${retry.attempts} (Backoff ${backoffMs}ms)`);
        await sleep(backoffMs);
        const sent = await sendTelegram(retry.chatId, retry.text);
        if (sent) {
          api.logger.info(`[executive-agent] Briefing-Retry erfolgreich (Versuch ${retry.attempts})`);
          pendingBriefingRetry = null;
        }
        return; // Don't run normal briefing logic during retry
      } else if (pendingBriefingRetry && pendingBriefingRetry.attempts >= 5) {
        api.logger.error(`[executive-agent] Briefing-Retry aufgegeben nach 5 Versuchen`);
        pendingBriefingRetry = null;
      }

      // Aktuelle Berliner Zeit als HH:MM
      const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
      const hh = String(inBerlin.getHours()).padStart(2, '0');
      const mm = String(inBerlin.getMinutes()).padStart(2, '0');
      const nowHHMM = `${hh}:${mm}`;
      const today   = berlinDate(0);

      if (nowHHMM === s.briefingTime && lastBriefingDate !== today) {
        // Withings-Sync parallel zum Briefing starten (darf fehlschlagen)
        const BRIEFING_TIMEOUT_MS = 45000;
        const briefingWork = async () => {
          // Withings-Sync ZUERST abwarten, damit aktuelle Schlafdaten vorhanden sind
          await syncWithingsForBriefing().catch((syncErr: any) => {
            api.logger.warn(`[executive-agent] Briefing Withings-Sync Fehler (ignoriert): ${syncErr.message}`);
          });
          return await generateBriefingText();
        };
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('briefing_timeout')), BRIEFING_TIMEOUT_MS)
        );
        const text = await Promise.race([briefingWork(), timeoutPromise]);
        const sent = await sendTelegram(s.telegramChatId, text);
        if (sent) {
          lastBriefingDate = today;
          api.logger.info(`[executive-agent] Tägliches Briefing gesendet (${today} ${nowHHMM})`);
        } else {
          // Zustellung fehlgeschlagen → Retry-Queue
          pendingBriefingRetry = { text, chatId: s.telegramChatId, attempts: 0 };
          lastBriefingDate = today; // Prevent re-generating, retry the existing text
          api.logger.warn(`[executive-agent] Briefing generiert aber Zustellung fehlgeschlagen — Retry geplant`);
        }

        // Token Guardian: tägliche Prüfung + proaktiver Refresh
        try {
          if (metaAppId && metaAppSecret) {
            const health = await checkAndRefreshInstagramToken(metaAppId, metaAppSecret);
            api.logger.info(`[executive-agent] Token Guardian (daily): ${health.status}, ${health.days_remaining} Tage`);
            const esc = evaluateTokenAlert(health, !!health.last_refresh);
            if (esc) {
              const msg = formatEscalation(esc);
              if (msg) await sendTelegram(s.telegramChatId, msg);
            }
          }
        } catch (e: any) {
          api.logger.warn(`[executive-agent] Token Guardian Fehler: ${e.message}`);
        }
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] Briefing-Scheduler Fehler: ${e.message}`);
    }
  }, 60_000);

  // ── Daily Health Check (08:00 Berlin) ─────────────────────────────────────

  let lastDailyHealthDate = '';

  setInterval(async () => {
    try {
      const s = loadSettings();
      if (!s.telegramChatId) return;

      const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
      const hh = String(inBerlin.getHours()).padStart(2, '0');
      const mm = String(inBerlin.getMinutes()).padStart(2, '0');
      const nowHHMM = `${hh}:${mm}`;
      const today = berlinDate(0);

      if (nowHHMM === '08:00' && lastDailyHealthDate !== today) {
        lastDailyHealthDate = today;
        const report = await runDailyHealthCheck();
        api.logger.info(`[executive-agent] Daily Health Check: ${report.status.toUpperCase()}`);

        if (report.status === 'green') {
          await sendTelegram(s.telegramChatId, '🟢 Daily Health Check — alle Systeme OK');
        } else {
          await sendTelegram(s.telegramChatId, formatHealthReport(report, 'Daily Health Check'));
        }
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] Daily Health Check Fehler: ${e.message}`);
    }
  }, 60_000);

  // ── Wöchentlicher Health-Report → src/modules/health/commands.ts (Timer) ──

  // ── Plugin HTTP routes on gateway port 18789 ─────────────────────────────
  // Register /health, /ready, /version, /location via api.registerHttpRoute()
  // so they run on the gateway's main port. The gateway checks plugin routes
  // BEFORE the Control UI SPA fallback, so JSON endpoints coexist with HTML.
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';

  api.registerHttpRoute({
    path: '/health',
    handler: (_req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'executive-agent', uptime: process.uptime() }));
    },
  });

  api.registerHttpRoute({
    path: '/ready',
    handler: (_req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'executive-agent' }));
    },
  });

  api.registerHttpRoute({
    path: '/version',
    handler: (_req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'executive-agent', node: process.version, uptime: process.uptime() }));
    },
  });

  // ── System Status (aggregated data for Dashboard Status Widget) ───────────
  api.registerHttpRoute({
    path: '/api/system-status',
    handler: async (_req: any, res: any) => {
      try {
        // 1. Service health from DB + live checks for Postgres and IB Gateway
        const serviceRows = await dbQuery<{
          service: string; status: string; last_change: Date | null;
        }>('SELECT service, status, last_change FROM service_health').then(r => r.rows).catch(() => []);

        const services = serviceRows.map(r => ({
          name: r.service,
          status: r.status,
          uptime_seconds: r.status === 'up' && r.last_change
            ? Math.round((Date.now() - new Date(r.last_change).getTime()) / 1000) : 0,
        }));

        // Live-check Postgres
        let pgOk = false;
        try { await dbQuery('SELECT 1'); pgOk = true; } catch {}
        const pgEntry = services.find(s => s.name === 'Postgres');
        if (!pgEntry) services.push({ name: 'Postgres', status: pgOk ? 'up' : 'down', uptime_seconds: pgOk ? Math.round(process.uptime()) : 0 });

        // Live-check IB Gateway (port 7497)
        let ibOk = false;
        try {
          const r = await fetch('http://127.0.0.1:18793/health', { signal: AbortSignal.timeout(3000) });
          if (r.ok) {
            const data = await r.json();
            ibOk = data.ibkr?.connected === true;
          }
        } catch {}
        const ibEntry = services.find(s => s.name === 'IB Gateway');
        if (!ibEntry) services.push({ name: 'IB Gateway', status: ibOk ? 'up' : 'down', uptime_seconds: 0 });

        // 2. Token expiry
        const tokens: { name: string; days_remaining: number }[] = [];
        const artifactsBase = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal');
        try {
          const it = JSON.parse(fs.readFileSync(path.join(artifactsBase, 'instagram/tokens.json'), 'utf-8'));
          if (it.expires_at) tokens.push({ name: 'Meta', days_remaining: Math.floor((it.expires_at - Date.now()) / 86_400_000) });
        } catch {}
        try {
          const wt = JSON.parse(fs.readFileSync(path.join(artifactsBase, 'health/withings-tokens.json'), 'utf-8'));
          if (wt.expires_at) tokens.push({ name: 'Withings', days_remaining: Math.floor((wt.expires_at - Date.now()) / 86_400_000) });
        } catch {}

        // 3. Workflows pending
        let workflowsPending = 0;
        let workflowTypes: string[] = [];
        try {
          const wf = await dbQuery<{ count: string; types: string[] }>(
            `SELECT count(*)::text, array_agg(DISTINCT type) as types FROM workflows WHERE status IN ('pending','running','awaiting_approval')`
          );
          if (wf.rows[0]) {
            workflowsPending = parseInt(wf.rows[0].count, 10);
            workflowTypes = (wf.rows[0].types || []).filter(Boolean);
          }
        } catch {}

        // 4. Last backup (from systemd timer)
        let lastBackup: string | null = null;
        try {
          const timerOut = execSync(
            "systemctl --user show openclaw-backup-daily.service --property=ExecMainStartTimestamp --value",
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          if (timerOut) lastBackup = new Date(timerOut).toISOString();
        } catch {}
        // Fallback: check borg list (slow, only if no systemd data)
        if (!lastBackup) {
          try {
            const borgOut = execSync(
              'BORG_PASSPHRASE=$(grep BORG_PASSPHRASE ~/.config/openclaw/env | cut -d= -f2) BORG_RSH="ssh -p 23" borg list ssh://u591557@u591557.your-storagebox.de:23/./openclaw/daily --last 1 --format "{time}" 2>/dev/null',
              { encoding: 'utf-8', timeout: 15000, shell: '/bin/bash' }
            ).trim();
            if (borgOut) lastBackup = new Date(borgOut).toISOString();
          } catch {}
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          services,
          tokens,
          workflows: { pending: workflowsPending, types: workflowTypes },
          backup: { last: lastBackup },
          timestamp: new Date().toISOString(),
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  });

  api.registerHttpRoute({
    path: '/location',
    handler: async (req: any, res: any) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        });
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
        return;
      }

      // Auth check
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (!gatewayToken || token !== gatewayToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      // Parse JSON body
      let body = '';
      try {
        await new Promise<void>((resolve, reject) => {
          req.on('data', (chunk: any) => { body += chunk; });
          req.on('end', resolve);
          req.on('error', reject);
          setTimeout(() => reject(new Error('timeout')), 10000);
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }

      const lat = parseFloat(String(parsed.lat));
      const lon = parseFloat(String(parsed.lon));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'lat/lon required' }));
        return;
      }

      // Label: prefer city from request body, fallback to Nominatim reverse-geocoding
      const rawCity = parsed.city != null ? String(parsed.city).trim() : '';
      let label = rawCity && !/^\d+(\.\d+)?$/.test(rawCity) ? rawCity : '';
      if (!label) {
        label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        try {
          const geoRes = await fetchWithTimeout(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=de`,
            { method: 'GET', headers: { 'User-Agent': 'openclaw-executive-agent/1.0' } },
            10000,
          );
          if (geoRes.ok) {
            const geo: any = await geoRes.json();
            label = geo?.address?.city
              || geo?.address?.town
              || geo?.address?.village
              || geo?.address?.municipality
              || geo?.display_name?.split(',')[0]
              || label;
          }
        } catch { /* geocoding optional, keep coordinate label */ }
      }

      const s = loadSettings();
      s.location = { lat, lon, label, updatedAt: new Date().toISOString() };
      saveSettings(s);

      const locHistoryDir = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal/location');
      if (!fs.existsSync(locHistoryDir)) fs.mkdirSync(locHistoryDir, { recursive: true });
      fs.appendFileSync(
        path.join(locHistoryDir, 'history.jsonl'),
        JSON.stringify({ lat, lon, label, altitude: parsed.altitude ?? null, timestamp: new Date().toISOString() }) + '\n',
        'utf-8',
      );

      api.logger.info(`[executive-agent] Location-API: Standort gespeichert: ${label} (${lat}, ${lon})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, label }));
    },
  });

  api.logger.info('[executive-agent] HTTP routes registered on gateway port 18789 (/health, /ready, /version, /location)');

  // ── Public Location HTTP Endpoint (POST /location, 0.0.0.0:18790) ────────
  const publicLocationPort = 18790;

  const publicLocationServer = http.createServer(async (req: any, res: any) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      res.end();
      return;
    }

    if (req.method !== 'POST' || (req.url && !req.url.startsWith('/location'))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    // Auth check
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!gatewayToken || token !== gatewayToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }

    // Parse JSON body
    let body = '';
    try {
      await new Promise<void>((resolve, reject) => {
        req.on('data', (chunk: any) => { body += chunk; });
        req.on('end', resolve);
        req.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 10000);
      });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Bad request' }));
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }

    const lat = parseFloat(String(parsed.lat));
    const lon = parseFloat(String(parsed.lon));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'lat/lon required' }));
      return;
    }

    // Label: prefer city from request body, fallback to Nominatim reverse-geocoding
    const rawCity = parsed.city != null ? String(parsed.city).trim() : '';
    let label = rawCity && !/^\d+(\.\d+)?$/.test(rawCity) ? rawCity : '';
    if (!label) {
      label = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      try {
        const geoRes = await fetchWithTimeout(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=de`,
          { method: 'GET', headers: { 'User-Agent': 'openclaw-executive-agent/1.0' } },
          10000,
        );
        if (geoRes.ok) {
          const geo: any = await geoRes.json();
          label = geo?.address?.city
            || geo?.address?.town
            || geo?.address?.village
            || geo?.address?.municipality
            || geo?.display_name?.split(',')[0]
            || label;
        }
      } catch { /* geocoding optional, keep coordinate label */ }
    }

    const s = loadSettings();
    s.location = { lat, lon, label, updatedAt: new Date().toISOString() };
    saveSettings(s);

    const locHistoryDir = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal/location');
    if (!fs.existsSync(locHistoryDir)) fs.mkdirSync(locHistoryDir, { recursive: true });
    fs.appendFileSync(
      path.join(locHistoryDir, 'history.jsonl'),
      JSON.stringify({ lat, lon, label, altitude: parsed.altitude ?? null, timestamp: new Date().toISOString() }) + '\n',
      'utf-8',
    );

    api.logger.info(`[executive-agent] Public Location-API: Standort gespeichert: ${label} (${lat}, ${lon})`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, label }));
  });

  publicLocationServer.on('error', (e: any) => {
    api.logger.error(`[executive-agent] Public Location-Server Fehler: ${e.message}`);
  });

  publicLocationServer.listen(publicLocationPort, '127.0.0.1', () => {
    api.logger.info(`[executive-agent] Location-API gestartet auf 127.0.0.1:${publicLocationPort} (via nginx/HTTPS)`);
  });

  // ── Browser Cleanup ──────────────────────────────────────────────────────
  process.on("beforeExit", () => { closeBrowser().catch(() => {}); });
  process.on("SIGTERM", () => { closeBrowser().catch(() => {}); });

  // ── Inject Instagram token adapter into system-health (K1 fix) ──────────
  initSystemHealth({
    loadTokens: loadInstaTokens,
    tokenDaysRemaining,
    ensureFreshToken: ensureInstaToken,
  });

  api.logger.info("[executive-agent] loaded v33 (craft engine)");

  // ── Startup Self-Test (async, non-blocking) ────────────────────────────
  (async () => {
    try {
      const report = await runStartupChecks();
      const summary = report.checks.map(c => `${c.status}: ${c.name}`).join(', ');
      api.logger.info(`[executive-agent] Startup Self-Test: ${report.status.toUpperCase()} — ${summary}`);

      if (report.status === 'red') {
        const s = loadSettings();
        if (s.telegramChatId) {
          await sendTelegram(s.telegramChatId, formatHealthReport(report));
        }
      }

      // Token Guardian at startup
      if (metaAppId && metaAppSecret) {
        const health = await checkAndRefreshInstagramToken(metaAppId, metaAppSecret);
        api.logger.info(`[executive-agent] Token Guardian: ${health.status}, ${health.days_remaining} Tage verbleibend`);
        const esc = evaluateTokenAlert(health, !!health.last_refresh);
        if (esc) {
          const msg = formatEscalation(esc);
          if (msg) {
            const s = loadSettings();
            if (s.telegramChatId) await sendTelegram(s.telegramChatId, msg);
          }
        }
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] Startup Self-Test Fehler: ${e.message}`);
    }

    // ── Health Monitor ────────────────────────────────────────────────────
    try {
      const migrationsDir = path.join(__dirname, 'src/modules/executive/migrations');
      const applied = await runMigrations(migrationsDir, 'executive');
      api.logger.info(`[health-monitor] Applied ${applied} migration(s)`);

      const monitor = new HealthMonitor({
        sendTelegram,
        getChatId: () => loadSettings().telegramChatId,
        logger: api.logger,
      });
      await monitor.start();
    } catch (e: any) {
      api.logger.error(`[health-monitor] Failed to start: ${e.message}`);
    }
  })();
}
