import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

function nowIso() { return new Date().toISOString(); }
function makeId(prefix: string) { return `${prefix}_${crypto.randomBytes(6).toString("hex")}`; }

/* ---------------- Graph helpers (M365) ---------------- */

// Simple in-memory token cache (per tenant+client)
type GraphTokenCacheEntry = {
  accessToken: string;
  // epoch ms when we consider token expired (includes safety buffer)
  expiresAtMs: number;
};

const graphTokenCache = new Map<string, GraphTokenCacheEntry>();

function cacheKey(tenantId: string, clientId: string) {
  return `${tenantId}::${clientId}`;
}

function nowMs() {
  return Date.now();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterMs(res: Response): number | null {
  const ra = res.headers.get("retry-after");
  if (!ra) return null;
  // retry-after can be seconds or HTTP date; we handle seconds robustly
  const secs = Number(ra);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  return null;
}

async function fetchWithTimeout(url: string, init: any, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (e: any) {
    // normalize abort to a readable error
    if (e?.name === "AbortError") {
      throw new Error(`fetch_timeout_after_${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}


async function graphToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const key = cacheKey(tenantId, clientId);
  const cached = graphTokenCache.get(key);
  if (cached && cached.expiresAtMs > nowMs()) {
    return cached.accessToken;
  }

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("scope", "https://graph.microsoft.com/.default");
  form.set("client_secret", clientSecret);
  form.set("grant_type", "client_credentials");

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  }, 20000);

  const text = await res.text().catch(() => "");
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    throw new Error(
      `token_error: status=${res.status} body=${parsed ? JSON.stringify(parsed) : text || "(empty)"}`
    );
  }


  const json: any = parsed ?? {};
  const accessToken: string = json.access_token;
  const expiresInSec: number | undefined = json.expires_in;

  // Safety buffer: refresh 60s before expiry (min 5s)
  const safetyMs = 60_000;
  const ttlMs =
    typeof expiresInSec === "number" && Number.isFinite(expiresInSec) && expiresInSec > 0
      ? Math.max(expiresInSec * 1000 - safetyMs, 5_000)
      : 45 * 60_000; // fallback 45 minutes if expires_in missing

  graphTokenCache.set(key, {
    accessToken,
    expiresAtMs: nowMs() + ttlMs,
  });

  return accessToken;
}

// Generic request with retry handling (429/503/504) + one-time 401 refresh
async function graphRequest(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  method: "GET" | "POST",
  url: string,
  body?: any
): Promise<any> {
  const maxRetries = 3;

  // Helper to get a fresh token (optionally force refresh)
  const getToken = async (forceRefresh: boolean) => {
    if (forceRefresh) graphTokenCache.delete(cacheKey(tenantId, clientId));
    return graphToken(tenantId, clientId, clientSecret);
  };

  let token = await getToken(false);
  let didRefreshOn401 = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let fetchBody: any = undefined;

    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      fetchBody = JSON.stringify(body ?? {});
    }

    const res = await fetchWithTimeout(url, { method, headers, body: fetchBody }, 20000);

    // 401: token expired/revoked → refresh once and retry immediately
    if (res.status === 401 && !didRefreshOn401) {
      didRefreshOn401 = true;
      token = await getToken(true);
      continue;
    }

    // Retry on throttling / transient gateway issues
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < maxRetries) {
      const retryAfterMs = parseRetryAfterMs(res);
      const backoffMs = retryAfterMs ?? Math.min(1000 * Math.pow(2, attempt), 8000);
      await sleep(backoffMs);
      continue;
    }

    // Parse response
    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");

    if (!res.ok) {
      const errText = isJson ? JSON.stringify(await res.json().catch(() => ({}))) : await res.text().catch(() => "");
      throw new Error(`graph_${method.toLowerCase()}_error: status=${res.status} body=${errText}`);
    }

    if (res.status === 204) return null; // no content
    if (isJson) return await res.json().catch(() => null);

    const text = await res.text().catch(() => "");
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text || null;
    }
  }

  throw new Error(`graph_${method.toLowerCase()}_error: exceeded_retries`);
}

async function graphGet(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  url: string
): Promise<any> {
  return graphRequest(tenantId, clientId, clientSecret, "GET", url);
}

async function graphPost(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  url: string,
  body: any
): Promise<any> {
  return graphRequest(tenantId, clientId, clientSecret, "POST", url, body);
}

/* ---------------- Plugin ---------------- */

export default function (api: any) {
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

  async function yahooUnread(limit: number): Promise<UnifiedMsg[]> {
    ensureYahooConfigured();

    const client = new ImapFlow({
      host: yahooImapHost,
      port: yahooImapPort,
      secure: true,
      auth: { user: yahooUser, pass: yahooPass },
    });

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

    await client.logout();
    return out;
  }


  async function yahooRecent(limit: number, hours?: number): Promise<UnifiedMsg[]> {
    ensureYahooConfigured();

    const client = new ImapFlow({
      host: yahooImapHost,
      port: yahooImapPort,
      secure: true,
      auth: { user: yahooUser, pass: yahooPass },
    });

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

    await client.logout();
    return out;
  }

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


  api.logger.info("[executive-agent] loaded v10 (unified inbox unread)");

}