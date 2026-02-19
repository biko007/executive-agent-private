import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
function nowIso() { return new Date().toISOString(); }
function makeId(prefix) { return `${prefix}_${crypto.randomBytes(6).toString("hex")}`; }
const graphTokenCache = new Map();
function cacheKey(tenantId, clientId) {
    return `${tenantId}::${clientId}`;
}
function nowMs() {
    return Date.now();
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function parseRetryAfterMs(res) {
    const ra = res.headers.get("retry-after");
    if (!ra)
        return null;
    // retry-after can be seconds or HTTP date; we handle seconds robustly
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0)
        return Math.min(secs * 1000, 30_000);
    return null;
}
async function graphToken(tenantId, clientId, clientSecret) {
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
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
    });
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    }
    catch { }
    if (!res.ok) {
        throw new Error(`token_error: status=${res.status} body=${parsed ? JSON.stringify(parsed) : text || "(empty)"}`);
    }
    const json = parsed ?? {};
    const accessToken = json.access_token;
    const expiresInSec = json.expires_in;
    // Safety buffer: refresh 60s before expiry (min 5s)
    const safetyMs = 60_000;
    const ttlMs = typeof expiresInSec === "number" && Number.isFinite(expiresInSec) && expiresInSec > 0
        ? Math.max(expiresInSec * 1000 - safetyMs, 5_000)
        : 45 * 60_000; // fallback 45 minutes if expires_in missing
    graphTokenCache.set(key, {
        accessToken,
        expiresAtMs: nowMs() + ttlMs,
    });
    return accessToken;
}
// Generic request with retry handling (429/503/504) + one-time 401 refresh
async function graphRequest(tenantId, clientId, clientSecret, method, url, body) {
    const maxRetries = 3;
    // Helper to get a fresh token (optionally force refresh)
    const getToken = async (forceRefresh) => {
        if (forceRefresh)
            graphTokenCache.delete(cacheKey(tenantId, clientId));
        return graphToken(tenantId, clientId, clientSecret);
    };
    let token = await getToken(false);
    let didRefreshOn401 = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const headers = { Authorization: `Bearer ${token}` };
        let fetchBody = undefined;
        if (method === "POST") {
            headers["Content-Type"] = "application/json";
            fetchBody = JSON.stringify(body ?? {});
        }
        const res = await fetch(url, { method, headers, body: fetchBody });
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
        if (res.status === 204)
            return null; // no content
        if (isJson)
            return await res.json().catch(() => null);
        const text = await res.text().catch(() => "");
        try {
            return text ? JSON.parse(text) : null;
        }
        catch {
            return text || null;
        }
    }
    throw new Error(`graph_${method.toLowerCase()}_error: exceeded_retries`);
}
async function graphGet(tenantId, clientId, clientSecret, url) {
    return graphRequest(tenantId, clientId, clientSecret, "GET", url);
}
async function graphPost(tenantId, clientId, clientSecret, url, body) {
    return graphRequest(tenantId, clientId, clientSecret, "POST", url, body);
}
/* ---------------- Plugin ---------------- */
export default function (api) {
    const workspace = api?.config?.agents?.defaults?.workspace || "/home/biko/.openclaw/workspace";
    const draftsDir = path.join(workspace, "artifacts", "mail-drafts");
    fs.mkdirSync(draftsDir, { recursive: true });
    // pluginConfig maps to: plugins.entries.executive-agent.config
    const pcfg = api.pluginConfig || {};
    const mailCfg = pcfg.mail || {};
    const m365 = mailCfg.m365 || {};
    const yahoo = mailCfg.yahoo || {};
    const signatures = mailCfg.signatures || {};
    const sendPolicy = mailCfg.sendPolicy || {};
    const requireApproval = sendPolicy.requireApproval !== false; // default true
    // ---- M365 config
    // ---- M365 config
    const m365Enabled = !!m365.enabled;
    const tenantId = process.env.M365_TENANT_ID || m365.tenantId || "";
    const clientId = process.env.M365_CLIENT_ID || m365.clientId || "";
    const m365User = process.env.M365_USER || m365.email || "";
    const m365Secret = process.env.M365_CLIENT_SECRET || "";
    // ---- Yahoo config
    const yahooEnabled = !!yahoo.enabled;
    const yahooUser = yahoo.email || "";
    const yahooPass = process.env.YAHOO_APP_PASSWORD || "";
    const yahooImapHost = yahoo.imapHost || "";
    const yahooImapPort = yahoo.imapPort || 993;
    const yahooSmtpHost = yahoo.smtpHost || "";
    const yahooSmtpPort = yahoo.smtpPort || 587;
    const yahooSmtpSecure = (yahooSmtpPort === 465);
    // ---- Signatures (normalize literal "\n" to real newlines)
    const sigM365 = String(signatures.m365 || "Mit freundlichem Gruß\n\nKI-Agent Hans Dampf\nim Auftrag von\nJürgen Bickel").replace(/\\n/g, "\n");
    const sigYahoo = String(signatures.yahoo || "Mit freundlichem Gruß\n\nKI-Agent Hans Dampf\nim Auftrag von\nJürgen Bickel").replace(/\\n/g, "\n");
    const draftPath = (id) => path.join(draftsDir, `${id}.json`);
    function saveDraft(d) { fs.writeFileSync(draftPath(d.id), JSON.stringify(d, null, 2), "utf-8"); }
    function loadDraft(id) {
        const p = draftPath(id);
        if (!fs.existsSync(p))
            return null;
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    function ensureM365Configured() {
        if (!m365Enabled)
            throw new Error("m365_disabled");
        if (!tenantId || !clientId || !m365User)
            throw new Error("m365_not_configured");
        if (!m365Secret)
            throw new Error("m365_secret_missing");
    }
    function ensureYahooConfigured() {
        if (!yahooEnabled)
            throw new Error("yahoo_disabled");
        if (!yahooUser || !yahooImapHost || !yahooSmtpHost)
            throw new Error("yahoo_not_configured");
        if (!yahooPass)
            throw new Error("yahoo_secret_missing (YAHOO_APP_PASSWORD)");
    }
    /* ---------------- Unified: unread fetchers ---------------- */
    async function m365Unread(limit) {
        ensureM365Configured();
        const token = await graphToken(tenantId, clientId, m365Secret);
        // unread only, newest first
        const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
            `/mailFolders/Inbox/messages?$top=${limit}` +
            `&$select=receivedDateTime,from,subject,id,isRead` +
            `&$filter=isRead eq false` +
            `&$orderby=receivedDateTime desc`;
        const data = await graphGet(token, url);
        const vals = data.value || [];
        return vals.map((m) => ({
            source: "m365",
            id: String(m.id),
            dateIso: String(m.receivedDateTime || nowIso()),
            from: m?.from?.emailAddress?.address || "?",
            subject: m?.subject || "(no subject)",
        }));
    }
    async function yahooUnread(limit) {
        ensureYahooConfigured();
        const client = new ImapFlow({
            host: yahooImapHost,
            port: yahooImapPort,
            secure: true,
            auth: { user: yahooUser, pass: yahooPass },
        });
        await client.connect();
        await client.mailboxOpen("INBOX");
        const out = [];
        for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true, internalDate: true })) {
            out.push({
                source: "yahoo",
                id: String(msg.uid),
                dateIso: msg.internalDate ? new Date(msg.internalDate).toISOString() : nowIso(),
                from: msg.envelope?.from?.[0]?.address || "?",
                subject: msg.envelope?.subject || "(no subject)",
            });
            if (out.length >= limit)
                break;
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
    async function yahooSend(d) {
        ensureYahooConfigured();
        const transporter = yahooTransport();
        await transporter.sendMail({
            from: yahooUser,
            to: d.to.join(", "),
            subject: d.subject,
            text: d.bodyText,
        });
    }
    async function createMeetingWithConflictCheck(force, tenantId, clientId, m365Secret, m365User, graphGetFn, graphPostFn, input) {
        // parse (mit Default-Dauer) – hier Ihren bestehenden Parser verwenden
        const parts = input.trim().split(/\s+/);
        let dateStr;
        let timeStr;
        let durationMin;
        let title;
        if (parts.length >= 4 && !isNaN(Number(parts[2]))) {
            dateStr = parts[0];
            timeStr = parts[1];
            durationMin = Number(parts[2]);
            title = parts.slice(3).join(" ");
        }
        else if (parts.length >= 3) {
            dateStr = parts[0];
            timeStr = parts[1];
            durationMin = 60;
            title = parts.slice(2).join(" ");
        }
        else {
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
        if (isNaN(start.getTime()) || isNaN(end.getTime()))
            return { text: "Invalid date/time." };
        // ---- conflict check via calendarView
        const calUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
            `/calendarView?startDateTime=${encodeURIComponent(start.toISOString())}` +
            `&endDateTime=${encodeURIComponent(end.toISOString())}` +
            `&$select=subject,start,end`;
        const cal = await graphGetFn(tenantId, clientId, m365Secret, calUrl);
        // robust conflict scan: query a wider window and check overlaps ourselves
        const scanStart = new Date(se.start.getTime() - 12 * 60 * 60 * 1000).toISOString();
        const scanEnd = new Date(se.end.getTime() + 12 * 60 * 60 * 1000).toISOString();
        const candidates = await listConflicts(scanStart, scanEnd);
        const startMs = se.start.getTime();
        const endMs = se.end.getTime();
        // overlap if: eventStart < end && eventEnd > start
        const conflicts = candidates.filter((ev) => {
            const s = new Date(ev?.start?.dateTime).getTime();
            const e = new Date(ev?.end?.dateTime).getTime();
            if (!Number.isFinite(s) || !Number.isFinite(e))
                return false;
            return s < endMs && e > startMs;
        });
        if (conflicts.length && !force) {
            const tz = "Europe/Berlin";
            const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
            const bucket = new Map();
            for (const ev of conflicts) {
                const s = new Date(ev.start.dateTime);
                const e = new Date(ev.end.dateTime);
                const key = `${fmtTime.format(s)}–${fmtTime.format(e)}`;
                const arr = bucket.get(key) || [];
                arr.push(ev.subject || "(ohne Titel)");
                bucket.set(key, arr);
            }
            const lines = [];
            for (const [range, subs] of Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
                lines.push(`• ${range}`);
                for (const subj of subs)
                    lines.push(`  - ${subj}`);
            }
            return {
                text: "⚠️ Zeitraum ist belegt. Termin NICHT erstellt.\n\n" +
                    lines.join("\n") +
                    "\n\nErzwingen mit:\n" +
                    `/meetf ${dateStr} ${timeStr} ${durationMin} ${title}`,
            };
        }
        // ---- create event
        const payload = {
            subject: title,
            start: { dateTime: start.toISOString(), timeZone: "Europe/Berlin" },
            end: { dateTime: end.toISOString(), timeZone: "Europe/Berlin" },
            isOnlineMeeting: true,
            onlineMeetingProvider: "teamsForBusiness",
        };
        const createUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}/events`;
        const created = await graphPostFn(tenantId, clientId, m365Secret, createUrl, payload);
        return {
            text: `📅 Termin erstellt${conflicts.length ? " (trotz Konflikt)" : ""}:\n\n` +
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
                text: "📬 Mail-Status (Executive-Agent)\n\n" +
                    `• M365: ${m365Ok ? "✅" : "❌"}  (${m365User || "(unset)"})\n` +
                    `• Yahoo: ${yOk ? "✅" : "❌"}  (${yahooUser || "(unset)"})\n` +
                    `• Send-Policy: ${requireApproval ? "requireApproval=true ✅" : "requireApproval=false ⚠️"}\n\n` +
                    "Hinweis: prüft nur plugins.entries.executive-agent.config + ENV Secrets (nicht daily-briefing/skills)."
            };
        },
    });
    // Unified inbox: unread + chronological
    api.registerCommand({
        name: "inbox",
        description: "Unified unread inbox (M365 + Yahoo). Usage: /inbox [n]",
        acceptsArgs: true,
        requireAuth: true,
        handler: async (ctx) => {
            try {
                const n = Math.max(1, Math.min(20, Number(String(ctx.args || "10").trim() || "10")));
                const perSource = Math.max(5, n); // fetch a bit more per source for better merge
                const [mMsgs, yMsgs] = await Promise.all([
                    m365Enabled ? m365Unread(perSource) : Promise.resolve([]),
                    yahooEnabled ? yahooUnread(perSource) : Promise.resolve([]),
                ]);
                const combined = [...mMsgs, ...yMsgs]
                    .sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1))
                    .slice(0, n);
                if (!combined.length) {
                    return { text: "📥 Unified Inbox: keine ungelesenen Mails." };
                }
                const lines = combined.map(m => {
                    const src = m.source === "m365" ? "[M365]" : "[YAHOO]";
                    return `${src} ${m.id}\n  ${m.dateIso} | ${m.from}\n  ${m.subject}`;
                });
                return { text: `📥 Unified Inbox (unread, top ${n})\n\n${lines.join("\n\n")}` };
            }
            catch (e) {
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
        handler: async (ctx) => {
            try {
                const n = Math.max(1, Math.min(20, Number(String(ctx.args || "5").trim() || "5")));
                const msgs = await yahooUnread(n);
                if (!msgs.length)
                    return { text: "📥 Yahoo: keine ungelesenen Mails." };
                return { text: "📥 Yahoo (unread)\n\n" + msgs.map(m => `${m.id}\n  ${m.dateIso} | ${m.from}\n  ${m.subject}`).join("\n\n") };
            }
            catch (e) {
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
            }
            catch (e) {
                return { text: `❌ Yahoo SMTP verify FAILED: ${e.message}` };
            }
        },
    });
    // Draft ops (avoid collision with OpenClaw /approve)
    api.registerCommand({
        name: "draftshow",
        description: "Show draft. Usage: /draftshow <draftId>",
        acceptsArgs: true,
        requireAuth: true,
        handler: (ctx) => {
            const id = String(ctx.args || "").trim();
            if (!id)
                return { text: "Usage: /draftshow <draftId>" };
            const d = loadDraft(id);
            if (!d)
                return { text: `Draft not found: ${id}` };
            return { text: `🧾 ${d.id} (${d.status}) [${d.account}]\nTo: ${d.to.join(", ")}\nSubject: ${d.subject}\n\n${d.bodyText}` };
        },
    });
    api.registerCommand({
        name: "draftapprove",
        description: "Approve draft (plugin). Usage: /draftapprove <draftId>",
        acceptsArgs: true,
        requireAuth: true,
        handler: (ctx) => {
            const id = String(ctx.args || "").trim();
            if (!id)
                return { text: "Usage: /draftapprove <draftId>" };
            const d = loadDraft(id);
            if (!d)
                return { text: `Draft not found: ${id}` };
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
        handler: async (ctx) => {
            try {
                const id = String(ctx.args || "").trim();
                if (!id)
                    return { text: "Usage: /draftsend <draftId>" };
                const d = loadDraft(id);
                if (!d)
                    return { text: `Draft not found: ${id}` };
                if (requireApproval && d.status !== "approved")
                    return { text: `❌ Draft not approved. Run /draftapprove ${id}` };
                if (d.status === "sent")
                    return { text: `ℹ️ Draft already sent: ${id}` };
                if (d.account === "yahoo") {
                    await yahooSend(d);
                }
                else {
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
            }
            catch (e) {
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
        handler: (ctx) => {
            try {
                ensureYahooConfigured();
                const to = String(ctx.args || "").trim();
                if (!to.includes("@"))
                    return { text: "Usage: /ytest <email>" };
                const d = {
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
            }
            catch (e) {
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
                let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
                    `/calendarView?startDateTime=${encodeURIComponent(startIso)}` +
                    `&endDateTime=${encodeURIComponent(endIso)}` +
                    `&$select=subject,start,end,isAllDay,location,organizer,onlineMeeting` +
                    `&$orderby=start/dateTime`;
                const events = [];
                for (let i = 0; i < 10; i++) {
                    const json = await graphGet(tenantId, clientId, m365Secret, url);
                    if (json?.value?.length)
                        events.push(...json.value);
                    const next = json?.["@odata.nextLink"];
                    if (!next)
                        break;
                    url = next;
                }
                if (!events.length)
                    return { text: "📅 Calendar: keine Termine in den nächsten 7 Tagen." };
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
                const dayKey = (d) => new Intl.DateTimeFormat("en-CA", {
                    timeZone: tz,
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                }).format(d);
                // Group by day
                const groups = new Map();
                for (const ev of events) {
                    const sdt = ev?.start?.dateTime;
                    if (!sdt)
                        continue;
                    const s = new Date(sdt);
                    if (isNaN(s.getTime()))
                        continue;
                    const k = dayKey(s);
                    if (!groups.has(k))
                        groups.set(k, []);
                    groups.get(k).push(ev);
                }
                const days = Array.from(groups.keys()).sort();
                const out = [];
                for (const k of days) {
                    const dayEvents = groups.get(k);
                    dayEvents.sort((a, b) => String(a?.start?.dateTime).localeCompare(String(b?.start?.dateTime)));
                    const dayDate = new Date(dayEvents[0].start.dateTime);
                    out.push(`🗓️ ${fmtDate.format(dayDate)}`);
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
            }
            catch (e) {
                return { text: `❌ /calendar failed: ${e.message}` };
            }
        },
    });
    /* ---------------- Calendar Create + Conflict ---------------- */
    async function listConflicts(startIso, endIso) {
        let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
            `/calendarView?startDateTime=${encodeURIComponent(startIso)}` +
            `&endDateTime=${encodeURIComponent(endIso)}` +
            `&$select=subject,start,end`;
        const conflicts = [];
        for (let i = 0; i < 10; i++) {
            const json = await graphGet(tenantId, clientId, m365Secret, url);
            if (Array.isArray(json?.value))
                conflicts.push(...json.value);
            const next = json?.["@odata.nextLink"];
            if (!next)
                break;
            url = next;
        }
        return conflicts;
    }
    function parseMeetArgs(inputRaw) {
        const input = String(inputRaw || "").trim();
        const parts = input.split(/\s+/);
        if (parts.length < 3)
            return null;
        let dateStr;
        let timeStr;
        let durationMin;
        let title;
        // /meet DD.MM HH:MM duration Title...
        if (parts.length >= 4 && !isNaN(Number(parts[2]))) {
            dateStr = parts[0];
            timeStr = parts[1];
            durationMin = Number(parts[2]);
            title = parts.slice(3).join(" ");
        }
        else {
            // /meet DD.MM HH:MM Title...  -> default duration
            dateStr = parts[0];
            timeStr = parts[1];
            durationMin = 60; // default
            title = parts.slice(2).join(" ");
        }
        if (!title)
            return null;
        return { dateStr, timeStr, durationMin, title };
    }
    function buildStartEnd(dateStr, timeStr, durationMin) {
        const [day, month] = (dateStr || "").split(".");
        const [hour, minute] = (timeStr || "").split(":");
        if (!day || !month || !hour || !minute)
            return null;
        const year = new Date().getFullYear();
        const start = new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute), 0);
        if (isNaN(start.getTime()))
            return null;
        const end = new Date(start.getTime() + durationMin * 60000);
        return { start, end };
    }
    async function handleMeet(ctx, force) {
        ensureM365Configured();
        const parsed = parseMeetArgs(ctx.args);
        if (!parsed) {
            return { text: "Usage: /meet DD.MM HH:MM [durationMin] Title\nForce: /meetf DD.MM HH:MM [durationMin] Title" };
        }
        const { dateStr, timeStr, durationMin, title } = parsed;
        const se = buildStartEnd(dateStr, timeStr, durationMin);
        if (!se)
            return { text: "Invalid date/time. Example: /meet 27.02 14:00 60 Strategic Call" };
        const startIso = se.start.toISOString();
        const endIso = se.end.toISOString();
        // Conflict check
        const conflicts = await listConflicts(startIso, endIso);
        if (conflicts.length && !force) {
            const tz = "Europe/Berlin";
            const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
            // group identical time ranges together
            const bucket = new Map();
            for (const ev of conflicts) {
                const s = new Date(ev.start.dateTime);
                const e = new Date(ev.end.dateTime);
                const key = `${fmtTime.format(s)}–${fmtTime.format(e)}`;
                const arr = bucket.get(key) || [];
                arr.push(ev.subject || "(ohne Titel)");
                bucket.set(key, arr);
            }
            const lines = [];
            for (const [range, subs] of Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
                lines.push(`• ${range}`);
                for (const subj of subs)
                    lines.push(`  - ${subj}`);
            }
            return {
                text: "⚠️ Zeitraum ist belegt. Termin NICHT erstellt.\n\n" +
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
            text: `📅 Termin erstellt${conflicts.length ? " (trotz Konflikt)" : ""}:\n\n` +
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
        handler: async (ctx) => {
            try {
                return await handleMeet(ctx, false);
            }
            catch (e) {
                return { text: `❌ /meet failed: ${e.message}` };
            }
        },
    });
    api.registerCommand({
        name: "meetf",
        description: "Force create meeting (ignores conflicts). Usage: /meetf DD.MM HH:MM [durationMin] Title",
        acceptsArgs: true,
        requireAuth: true,
        handler: async (ctx) => {
            try {
                return await handleMeet(ctx, true);
            }
            catch (e) {
                return { text: `❌ /meetf failed: ${e.message}` };
            }
        },
    });
    api.registerCommand({
        name: "free",
        description: "Check availability. Usage: /free DD.MM HH:MM-HH:MM",
        acceptsArgs: true,
        requireAuth: true,
        handler: async (ctx) => {
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
                    .map((ev) => ({
                    s: new Date(ev.start.dateTime).getTime(),
                    e: new Date(ev.end.dateTime).getTime(),
                    subject: ev.subject || "(ohne Titel)",
                }))
                    .filter(x => Number.isFinite(x.s) && Number.isFinite(x.e))
                    .sort((a, b) => a.s - b.s);
                // Merge to compute free slots
                const free = [];
                let cursor = start.getTime();
                // For display
                const tz = "Europe/Berlin";
                const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
                for (const b of busyIntervals) {
                    const bs = Math.max(b.s, start.getTime());
                    const be = Math.min(b.e, end.getTime());
                    if (be <= cursor)
                        continue;
                    if (bs > cursor)
                        free.push({ s: cursor, e: bs });
                    cursor = Math.max(cursor, be);
                }
                if (cursor < end.getTime())
                    free.push({ s: cursor, e: end.getTime() });
                const freeLines = free.length
                    ? free.map(x => `• ${fmtTime.format(new Date(x.s))}–${fmtTime.format(new Date(x.e))}`).join("\n")
                    : "• (kein freies Zeitfenster)";
                // Group busy by identical time range
                const bucket = new Map();
                for (const ev of events) {
                    const s = new Date(ev.start.dateTime);
                    const e = new Date(ev.end.dateTime);
                    const key = `${fmtTime.format(s)}–${fmtTime.format(e)}`;
                    const arr = bucket.get(key) || [];
                    arr.push(ev.subject || "(ohne Titel)");
                    bucket.set(key, arr);
                }
                const busyLines = [];
                for (const [range2, subs] of Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
                    busyLines.push(`• ${range2}`);
                    for (const subj of subs)
                        busyLines.push(`  - ${subj}`);
                }
                return {
                    text: `🟢 Frei am ${dateStr} zwischen ${startStr}-${endStr}:\n\n` +
                        `${freeLines}\n\n` +
                        `🔒 Belegt:\n\n` +
                        busyLines.join("\n"),
                };
            }
            catch (e) {
                return { text: `❌ /free failed: ${e.message}` };
            }
        },
    });
    api.logger.info("[executive-agent] loaded v10 (unified inbox unread)");
}
