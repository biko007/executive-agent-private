import fs from "node:fs";
import { createTrip, getTrip, listTrips, addSegment, generatePacklist, updateTrip } from "./travel-store.js";
import { appendEntry, appendEntryWithTimestamp, readEntries, lastEntry, summarize, formatSummary } from "./health-store.js";
import { buildAuthUrl, exchangeCode, ensureFreshToken, saveTokens, isAuthorized, fetchMeasures, fetchSleep as fetchWithingsSleep, fetchActivity, fetchWorkouts, } from "./withings-store.js";
import { listSites, listDrives, searchDocuments, getRecentFiles, pollForChanges, fullSync } from "./sharepoint-store.js";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
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
async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...(init || {}), signal: controller.signal });
    }
    catch (e) {
        // normalize abort to a readable error
        if (e?.name === "AbortError") {
            throw new Error(`fetch_timeout_after_${timeoutMs}ms`);
        }
        throw e;
    }
    finally {
        clearTimeout(t);
    }
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
    const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
    }, 20000);
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
/* ---------------- Anthropic Trip Enrichment ---------------- */
function readAnthropicKey() {
    if (process.env.ANTHROPIC_API_KEY)
        return process.env.ANTHROPIC_API_KEY;
    try {
        const envPath = path.join(process.env.HOME || '/root', '.config/openclaw/env');
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            if (line.startsWith('#') || !line.includes('='))
                continue;
            const eq = line.indexOf('=');
            const key = line.slice(0, eq).trim();
            const val = line.slice(eq + 1).trim();
            if (key === 'ANTHROPIC_API_KEY' && val)
                return val;
        }
    }
    catch { }
    return '';
}
async function fetchWeatherForecast(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
        `&timezone=auto&forecast_days=7`;
    const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
    if (!res.ok)
        throw new Error(`Open-Meteo Fehler: ${res.status}`);
    const data = await res.json();
    const d = data?.daily;
    if (!d?.time?.length)
        return [];
    return d.time.map((date, i) => ({
        date,
        tmax: Math.round(d.temperature_2m_max[i] ?? 0),
        tmin: Math.round(d.temperature_2m_min[i] ?? 0),
        precip: Math.round((d.precipitation_sum[i] ?? 0) * 10) / 10,
    }));
}
async function enrichTripWithOpenAI(name) {
    const apiKey = readAnthropicKey();
    if (!apiKey)
        throw new Error('ANTHROPIC_API_KEY nicht gesetzt (in ~/.config/openclaw/env eintragen)');
    const prompt = `Du hilfst bei der Reiseplanung. Der Nutzer plant eine Reise nach "${name}".\n` +
        `Antworte NUR mit einem JSON-Objekt (kein Markdown, kein Text davor/danach):\n` +
        `{\n` +
        `  "destination": "<Hauptstadt oder bekannteste Stadt des Ziels>",\n` +
        `  "country": "<Land auf Deutsch>",\n` +
        `  "country_code": "<ISO-3166-1-Alpha-2-Ländercode, z.B. JP>",\n` +
        `  "lat": <Breitengrad der Destination als Dezimalzahl, z.B. 35.6895>,\n` +
        `  "lon": <Längengrad der Destination als Dezimalzahl, z.B. 139.6917>,\n` +
        `  "climate": "<eines von: tropical|temperate|cold|desert|mixed>",\n` +
        `  "activities": ["<eines oder mehrere von: business|leisure|outdoor|beach|city>"],\n` +
        `  "currency": "<Währungsname und Symbol, z.B. Japanischer Yen (¥)>",\n` +
        `  "visa_de": "<Visapflicht für deutschen Pass, z.B. 'kein Visum erforderlich (bis 90 Tage)'>",\n` +
        `  "distance_km": <Luftlinie in km von Tuttlingen (48.0641°N, 8.8236°E) als ganze Zahl>,\n` +
        `  "travel_mode": "<Empfohlenes Hauptverkehrsmittel, z.B. Flugzeug, Zug, Auto>",\n` +
        `  "door_to_door_estimate": "<Haustür-zu-Haustür Zeitschätzung ab Tuttlingen, z.B. 'ca. 14-16 Stunden (Flug FRA + Transfers)'>",\n` +
        `  "exchange_rate_eur": "<Wechselkurs: wie viel Landeswährung bekommt man für 1 EUR, z.B. '1 EUR ≈ 160 JPY' oder '1 EUR ≈ 1,08 USD'>"\n` +
        `}`;
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
        }),
    }, 30000);
    if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`Anthropic API Fehler: ${res.status} — ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.content?.[0]?.text || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
        throw new Error(`Anthropic: kein JSON in Antwort — ${content.slice(0, 200)}`);
    let parsed;
    try {
        parsed = JSON.parse(jsonMatch[0]);
    }
    catch (e) {
        throw new Error(`Anthropic: JSON parse fehlgeschlagen — ${e.message}`);
    }
    return {
        destination: String(parsed.destination || name),
        country_code: String(parsed.country_code || '').toUpperCase(),
        lat: Number(parsed.lat) || 0,
        lon: Number(parsed.lon) || 0,
        climate: String(parsed.climate || 'temperate'),
        activities: Array.isArray(parsed.activities) ? parsed.activities.map(String) : ['leisure'],
        currency: String(parsed.currency || ''),
        visa_de: String(parsed.visa_de || ''),
        distance_km: Number(parsed.distance_km) || 0,
        travel_mode: String(parsed.travel_mode || ''),
        door_to_door_estimate: String(parsed.door_to_door_estimate || ''),
        exchange_rate_eur: String(parsed.exchange_rate_eur || ''),
    };
}
async function parseTripFreeText(text) {
    const apiKey = readAnthropicKey();
    if (!apiKey)
        throw new Error('ANTHROPIC_API_KEY nicht gesetzt');
    const todayBerlin = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Berlin',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    // Compute concrete Monday anchors so Haiku has no ambiguity
    const [ty, tm, td] = todayBerlin.split('-').map(Number);
    const todayUtc = new Date(Date.UTC(ty, tm - 1, td));
    const isoDow = todayUtc.getUTCDay() === 0 ? 7 : todayUtc.getUTCDay(); // Mon=1…Sun=7
    const daysToNextMon = 8 - isoDow; // always 2..8
    const msDay = 86_400_000;
    const nextMonMs = todayUtc.getTime() + daysToNextMon * msDay;
    const nextNextMonMs = nextMonMs + 7 * msDay;
    const monNext = new Date(nextMonMs).toISOString().slice(0, 10);
    const monNextNext = new Date(nextNextMonMs).toISOString().slice(0, 10);
    const prompt = `Heute ist der ${todayBerlin} (Wochentag: ${['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][todayUtc.getUTCDay()]}, Zeitzone Europe/Berlin).\n\n` +
        `WICHTIG — Deutsche Wochenreferenzen (verbindlich):\n` +
        `  "nächste Woche"      = Montag ${monNext} bis Sonntag (7 Tage ab ${monNext})\n` +
        `  "übernächste Woche"  = Montag ${monNextNext} bis Sonntag — das ist ZWEI Wochen ab heute, NICHT eine\n` +
        `  "übermorgen"         = ${new Date(todayUtc.getTime() + 2 * msDay).toISOString().slice(0, 10)}\n` +
        `  "Anfang <Monat>"     = 1. des Monats\n` +
        `  "Mitte <Monat>"      = 15. des Monats\n` +
        `  "Ende <Monat>"       = letzter Tag des Monats\n` +
        `  "nächsten <Wochentag>"     = der kommende <Wochentag> in der Woche ab ${monNext}\n` +
        `  "übernächsten <Wochentag>" = der <Wochentag> in der Woche ab ${monNextNext}\n\n` +
        `Der Nutzer beschreibt eine Reise in freiem Text:\n` +
        `"${text}"\n\n` +
        `Extrahiere Reiseziel, Startdatum und Enddatum. Wende die obigen Regeln exakt an.\n` +
        `Antworte NUR mit einem JSON-Objekt (kein Markdown, kein Text davor/danach).\n\n` +
        `Wenn alle drei Felder eindeutig erkennbar sind:\n` +
        `{ "destination": "<Reiseziel>", "start": "<YYYY-MM-DD>", "end": "<YYYY-MM-DD>" }\n\n` +
        `Wenn etwas unklar oder fehlend ist:\n` +
        `{ "unclear": true, "question": "<kurze Rückfrage auf Deutsch>" }`;
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }],
        }),
    }, 20000);
    if (!res.ok) {
        const err = await res.text().catch(() => '');
        throw new Error(`Anthropic API Fehler: ${res.status} — ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.content?.[0]?.text || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
        throw new Error(`Haiku: kein JSON in Antwort — ${content.slice(0, 200)}`);
    let parsed;
    try {
        parsed = JSON.parse(jsonMatch[0]);
    }
    catch (e) {
        throw new Error(`Haiku: JSON parse fehlgeschlagen — ${e.message}`);
    }
    if (parsed.unclear) {
        return { unclear: true, question: String(parsed.question || 'Bitte Reiseziel und Daten angeben.') };
    }
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!parsed.destination || !dateRe.test(parsed.start) || !dateRe.test(parsed.end)) {
        return { unclear: true, question: 'Ich konnte Ziel oder Datum nicht eindeutig erkennen. Bitte nochmal mit Reiseziel und konkreten Daten.' };
    }
    return {
        destination: String(parsed.destination),
        start: String(parsed.start),
        end: String(parsed.end),
    };
}
/* ---------------- Settings + Helpers ---------------- */
const SETTINGS_FILE = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal/health/settings.json');
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return { briefingTime: '07:00', ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
        }
    }
    catch { }
    return { briefingTime: '07:00' };
}
function saveSettings(s) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}
/** Returns YYYY-MM-DD in Europe/Berlin, with optional day offset */
function berlinDate(offsetDays = 0) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Berlin',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(Date.now() + offsetDays * 86_400_000));
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
    function listDrafts(status, limit = 5) {
        if (!fs.existsSync(draftsDir))
            return [];
        const files = fs.readdirSync(draftsDir).filter(f => f.endsWith(".json"));
        const out = [];
        for (const f of files) {
            try {
                const raw = fs.readFileSync(path.join(draftsDir, f), "utf-8");
                const d = JSON.parse(raw);
                if (!d?.id || !d?.status)
                    continue;
                if (status && d.status !== status)
                    continue;
                out.push(d);
            }
            catch {
                // ignore broken draft file
            }
        }
        out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        return out.slice(0, Math.max(1, Math.min(20, limit)));
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
        const data = await graphGet(tenantId, clientId, m365Secret, url);
        const vals = data.value || [];
        return vals.map((m) => ({
            source: "m365",
            id: String(m.id),
            dateIso: String(m.receivedDateTime || nowIso()),
            from: m?.from?.emailAddress?.address || "?",
            subject: m?.subject || "(no subject)",
        }));
    }
    async function m365Recent(limit, hours) {
        ensureM365Configured();
        // newest first, optional time filter
        const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
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
    async function yahooRecent(limit, hours) {
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
        const uids = Array.isArray(searchRes) ? searchRes : [];
        uids.sort((a, b) => b - a);
        const pick = uids.slice(0, limit);
        const out = [];
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
        const scanStart = new Date(start.getTime() - 12 * 60 * 60 * 1000).toISOString();
        const scanEnd = new Date(end.getTime() + 12 * 60 * 60 * 1000).toISOString();
        const candidates = await listConflicts(scanStart, scanEnd);
        const startMs = start.getTime();
        const endMs = end.getTime();
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
            const parts = [];
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
                }
                else {
                    for (const m of combined) {
                        const src = m.source === "m365" ? "[M365]" : "[YAHOO]";
                        const dt = m.dateIso.replace("T", " ").replace("Z", "Z");
                        parts.push(`• ${src} ${dt} — ${m.from} — ${m.subject}`);
                    }
                }
                parts.push("");
            }
            catch (e) {
                parts.push("📥 Unread Inbox");
                parts.push("• ❌ Fehler beim Laden");
                parts.push("");
            }
            // (B) Next events (top 3, next 7 days)
            try {
                if (!m365Enabled)
                    throw new Error("m365_disabled");
                ensureM365Configured();
                const start = new Date();
                const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
                    `/calendarView?startDateTime=${encodeURIComponent(start.toISOString())}` +
                    `&endDateTime=${encodeURIComponent(end.toISOString())}` +
                    `&$select=subject,start,end,location` +
                    `&$orderby=start/dateTime`;
                const events = [];
                for (let i = 0; i < 10 && events.length < 3; i++) {
                    const json = await graphGet(tenantId, clientId, m365Secret, url);
                    if (Array.isArray(json?.value))
                        events.push(...json.value);
                    const next = json?.["@odata.nextLink"];
                    if (!next)
                        break;
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
                }
                else {
                    for (const ev of top) {
                        const subj = ev?.subject || "(ohne Titel)";
                        const sdt = ev?.start?.dateTime ? new Date(ev.start.dateTime) : null;
                        const edt = ev?.end?.dateTime ? new Date(ev.end.dateTime) : null;
                        const when = sdt && edt
                            ? `${fmtDate.format(sdt)} ${fmtTime.format(sdt)}–${fmtTime.format(edt)}`
                            : "(time?)";
                        const loc = ev?.location?.displayName ? ` | ${ev.location.displayName}` : "";
                        parts.push(`• ${when} — ${subj}${loc}`);
                    }
                }
                parts.push("");
            }
            catch (e) {
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
                }
                else {
                    for (const d of ds) {
                        parts.push(`• ${d.id} [${d.account}] — To: ${(d.to || []).join(", ")} — ${d.subject}`);
                    }
                }
                parts.push("");
            }
            catch (e) {
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
        handler: async (ctx) => {
            try {
                const raw = String(ctx.args || "").trim();
                const tokens = raw ? raw.split(/\s+/) : [];
                let mode = "unread";
                let hours = undefined;
                let n = 10;
                if (tokens[0]?.toLowerCase() === "last") {
                    mode = "last";
                    const t1 = tokens[1];
                    const t2 = tokens[2];
                    if (t1 && /h$/i.test(t1)) {
                        const h = Number(t1.replace(/h$/i, ""));
                        if (Number.isFinite(h) && h > 0)
                            hours = h;
                        if (t2)
                            n = Number(t2);
                    }
                    else if (t1) {
                        n = Number(t1);
                    }
                }
                else if (tokens[0]) {
                    n = Number(tokens[0]);
                }
                n = Math.max(1, Math.min(20, Number.isFinite(n) ? Number(n) : 10));
                const perSource = Math.max(10, n); // fetch a bit more per source for better merge
                const [mMsgs, yMsgs] = mode === "last"
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
                        text: mode === "last"
                            ? "📥 Unified Inbox: keine Mails im gewählten Zeitraum."
                            : "📥 Unified Inbox: keine ungelesenen Mails."
                    };
                }
                const lines = combined.map(m => {
                    const src = m.source === "m365" ? "[M365]" : "[YAHOO]";
                    const dt = m.dateIso.replace("T", " ").replace("Z", "Z");
                    return `${src} ${dt} | ${m.from}\n${m.subject}\n(id: ${m.id})`;
                });
                const title = mode === "last"
                    ? `📥 Unified Inbox (last${hours ? " " + hours + "h" : ""}, top ${n})`
                    : `📥 Unified Inbox (unread, top ${n})`;
                return { text: `${title}\n\n${lines.join("\n\n")}` };
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
    function parseKvArgs(inputRaw) {
        const s = String(inputRaw || "").trim();
        const out = {};
        if (!s)
            return out;
        // Tokenize: key=value where value may be "..." or '...'
        const re = /(\w+)=("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+)/g;
        let m;
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
        handler: (ctx) => {
            try {
                const kv = parseKvArgs(ctx.args || "");
                const account = (kv.account || "").toLowerCase();
                if (account !== "yahoo" && account !== "m365")
                    return { text: 'Usage: /draftcreate account=yahoo|m365 to=... subject=... body=...' };
                if (account === "yahoo")
                    ensureYahooConfigured();
                if (account === "m365")
                    ensureM365Configured();
                const toRaw = kv.to || "";
                const to = toRaw.split(/[;,]/).map(x => x.trim()).filter(Boolean);
                if (!to.length || !to.every(x => x.includes("@")))
                    return { text: "❌ Invalid to=. Use: to=a@b.com[,c@d.com]" };
                const subject = kv.subject || "";
                const body = kv.body || "";
                if (!subject)
                    return { text: '❌ Missing subject=. Example: subject=Hello' };
                if (!body)
                    return { text: '❌ Missing body=. Example: body=Line1\\n\\nLine2' };
                const d = {
                    id: makeId(account),
                    createdAt: nowIso(),
                    status: "draft",
                    account: account,
                    user: account === "yahoo" ? yahooUser : m365User,
                    to,
                    subject,
                    bodyText: body,
                };
                saveDraft(d);
                return {
                    text: `✅ Draft created: ${d.id} [${d.account}]
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
            }
            catch (e) {
                return { text: `❌ /draftcreate failed: ${e.message}` };
            }
        },
    });
    api.registerCommand({
        name: "draftedit",
        description: 'Edit draft fields. Usage: /draftedit <id> [to=...] [subject=...] [body=...]',
        acceptsArgs: true,
        requireAuth: true,
        handler: (ctx) => {
            try {
                const raw = String(ctx.args || "").trim();
                const m = raw.match(/^(\S+)\s*(.*)$/);
                if (!m)
                    return { text: 'Usage: /draftedit <id> subject=... | body=... | to=a@b.com[,c@d.com]' };
                const id = m[1];
                const rest = m[2] || "";
                const d = loadDraft(id);
                if (!d)
                    return { text: `Draft not found: ${id}` };
                if (d.status === "sent")
                    return { text: `❌ Draft already sent: ${id}` };
                const kv = parseKvArgs(rest);
                if (kv.to !== undefined) {
                    const to = String(kv.to || "").split(/[;,]/).map(x => x.trim()).filter(Boolean);
                    if (!to.length || !to.every(x => x.includes("@")))
                        return { text: "❌ Invalid to=. Use: to=a@b.com[,c@d.com]" };
                    d.to = to;
                }
                if (kv.subject !== undefined) {
                    const subject = String(kv.subject || "");
                    if (!subject)
                        return { text: "❌ subject= cannot be empty" };
                    d.subject = subject;
                }
                if (kv.body !== undefined) {
                    const body = String(kv.body || "");
                    if (!body)
                        return { text: "❌ body= cannot be empty" };
                    d.bodyText = body;
                }
                saveDraft(d);
                return { text: `✅ Draft updated: ${id} (${d.status})
/draftshow ${id}` };
            }
            catch (e) {
                return { text: `❌ /draftedit failed: ${e.message}` };
            }
        },
    });
    api.registerCommand({
        name: "draftlist",
        description: "List open drafts. Usage: /draftlist [n]",
        acceptsArgs: true,
        requireAuth: true,
        handler: (ctx) => {
            const nRaw = String(ctx.args || "").trim();
            const nNum = nRaw ? Number(nRaw) : 5;
            const n = Math.max(1, Math.min(20, Number.isFinite(nNum) ? nNum : 5));
            const ds = listDrafts("draft", n);
            if (!ds.length)
                return { text: "📝 Drafts: keine offenen Drafts." };
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
        if (!input)
            return null;
        const parts = input.split(/\s+/);
        if (parts.length < 2)
            return null;
        const tz = "Europe/Berlin";
        function fmtDDMM(d) {
            const dd = String(d.getDate()).padStart(2, "0");
            const mm = String(d.getMonth() + 1).padStart(2, "0");
            return `${dd}.${mm}`;
        }
        function nextWeekday(target) {
            const now = new Date();
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const cur = d.getDay(); // 0=Sun..6=Sat
            let delta = (target - cur + 7) % 7;
            if (delta === 0)
                delta = 7; // "next", not "today"
            d.setDate(d.getDate() + delta);
            return d;
        }
        function parseDuration(token) {
            if (!token)
                return null;
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
        }
        else if (dateTok === "heute") {
            dateStr = fmtDDMM(new Date());
        }
        else if (dateTok === "morgen") {
            const d = new Date();
            d.setDate(d.getDate() + 1);
            dateStr = fmtDDMM(d);
        }
        else {
            const map = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };
            if (map[dateTok] !== undefined) {
                dateStr = fmtDDMM(nextWeekday(map[dateTok]));
            }
            else {
                return null;
            }
        }
        if (!/^\d{1,2}:\d{2}$/.test(timeTok))
            return null;
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
        const { start, end } = se;
        const startIso = start.toISOString();
        const endIso = end.toISOString();
        // Conflict check
        // Conflict check (robust): scan wider window and compute overlaps locally
        const scanStartIso = new Date(start.getTime() - 12 * 60 * 60 * 1000).toISOString();
        const scanEndIso = new Date(end.getTime() + 12 * 60 * 60 * 1000).toISOString();
        const candidates = await listConflicts(scanStartIso, scanEndIso);
        const startMs = start.getTime();
        const endMs = end.getTime();
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
    // ── Travel Module ─────────────────────────────────────────────────────────
    api.registerCommand({
        name: "trips",
        description: "Alle Reisen anzeigen",
        handler: async () => {
            const trips = listTrips();
            if (!trips.length)
                return { text: "📭 Keine Reisen gespeichert. Mit /tripnew anlegen." };
            const lines = trips.map(t => `✈️ *${t.name}* (${t.id})\n   📅 ${t.start_date} → ${t.end_date}\n   📍 ${t.destination || "–"}  🌡 ${t.climate}  🎯 ${t.activities.join(", ")}\n   📦 ${t.segments.length} Segment(e)`);
            return { text: `🗺 Deine Reisen:\n\n${lines.join("\n\n")}` };
        },
    });
    api.registerCommand({
        name: "tripnew",
        acceptsArgs: true,
        description: "Neue Reise anlegen: /tripnew <name> <start> <end> — bei nur 3 Args: KI-Anreicherung via OpenAI",
        handler: async (ctx) => {
            const raw = (ctx.args || "").trim();
            const tokens = raw.split(/\s+/);
            // Finde den ersten Token im Format YYYY-MM-DD → alles davor ist der Name
            const datePattern = /^\d{4}-\d{2}-\d{2}$/;
            const firstDateIdx = tokens.findIndex((t) => datePattern.test(t));
            if (firstDateIdx < 1 || firstDateIdx + 1 >= tokens.length) {
                return { text: "❌ Verwendung: /tripnew New York 2026-03-03 2026-03-05\nOder manuell: /tripnew Tokyo 2026-03-10 2026-03-18 Japan temperate leisure,city" };
            }
            const name = tokens.slice(0, firstDateIdx).join(" ");
            const start_date = tokens[firstDateIdx];
            const end_date = tokens[firstDateIdx + 1];
            const rest = tokens.slice(firstDateIdx + 2); // optionale manuelle Params
            const isAutoMode = rest.length === 0;
            if (isAutoMode) {
                // ── KI-Anreicherung ──
                try {
                    const info = await enrichTripWithOpenAI(name);
                    // ── Wettervorschau (7 Tage) ──
                    let weatherLines = '(nicht verfügbar)';
                    if (info.lat && info.lon) {
                        try {
                            const forecast = await fetchWeatherForecast(info.lat, info.lon);
                            if (forecast.length) {
                                weatherLines = forecast
                                    .map(d => `  ${d.date}: ${d.tmin}–${d.tmax}°C, 🌧 ${d.precip} mm`)
                                    .join('\n');
                            }
                        }
                        catch (_) { /* Wetter optional */ }
                    }
                    const trip = createTrip(name, start_date, end_date, info.destination, info.climate, info.activities);
                    updateTrip(trip.id, {
                        country_code: info.country_code,
                        currency: info.currency,
                        visa_de: info.visa_de,
                        distance_km: info.distance_km,
                        travel_mode: info.travel_mode,
                        door_to_door_estimate: info.door_to_door_estimate,
                        exchange_rate_eur: info.exchange_rate_eur,
                    });
                    return {
                        text: `✅ Reise *${trip.name}* angelegt (KI-angereichert)!\n` +
                            `📅 ${trip.start_date} → ${trip.end_date}\n` +
                            `📍 ${info.destination} (${info.country_code})\n` +
                            `💶 Währung: ${info.currency}\n` +
                            `💱 Wechselkurs: ${info.exchange_rate_eur}\n` +
                            `🛂 Visum (DE-Pass): ${info.visa_de}\n` +
                            `📏 Luftlinie ab Tuttlingen: ${info.distance_km} km\n` +
                            `🚀 Verkehrsmittel: ${info.travel_mode}\n` +
                            `⏱ Haustür-zu-Haustür: ${info.door_to_door_estimate}\n` +
                            `🌡 Klima: ${info.climate}\n` +
                            `🎯 Aktivitäten: ${info.activities.join(", ")}\n` +
                            `☁️ Wetter (7-Tage-Vorschau):\n${weatherLines}\n` +
                            `🔑 ID: ${trip.id}`,
                    };
                }
                catch (e) {
                    return { text: `❌ KI-Anreicherung fehlgeschlagen: ${e.message}\nTipp: /tripnew ${name} ${start_date} ${end_date} <destination> <climate> <activities>` };
                }
            }
            // ── Manueller Modus ──
            const destination = rest[0] || "";
            const climate = rest[1] || "temperate";
            const activitiesRaw = rest[2] || "leisure";
            const activities = activitiesRaw.split(",").map((a) => a.trim());
            const trip = createTrip(name, start_date, end_date, destination, climate, activities);
            return { text: `✅ Reise *${trip.name}* angelegt!\n📅 ${trip.start_date} → ${trip.end_date}\n📍 ${trip.destination || "–"}\n🌡 Klima: ${trip.climate}\n🎯 Aktivitäten: ${trip.activities.join(", ")}\n🔑 ID: ${trip.id}` };
        },
    });
    // ── /trip: Free-text Reise anlegen via Haiku ──────────────────────────────
    api.registerCommand({
        name: "trip",
        acceptsArgs: true,
        description: "Reise per Freitext anlegen: /trip Ich fahre nächste Woche nach Barcelona bis zum 3. März",
        handler: async (ctx) => {
            const raw = (ctx.args || "").trim();
            if (!raw) {
                return { text: "Bitte beschreibe deine Reise, z. B.:\n/trip Ich fliege nächsten Montag nach Tokyo und komme am 15. März zurück" };
            }
            // Haiku parst Freitext → { destination, start, end } oder { unclear, question }
            let parsed;
            try {
                parsed = await parseTripFreeText(raw);
            }
            catch (e) {
                return { text: `❌ Haiku-Parsing fehlgeschlagen: ${e.message}` };
            }
            if ("unclear" in parsed) {
                return { text: `❓ ${parsed.question}` };
            }
            const { destination, start, end } = parsed;
            // KI-Anreicherung via enrichTripWithOpenAI (gleiche Logik wie /tripnew auto)
            try {
                const info = await enrichTripWithOpenAI(destination);
                let weatherLines = '(nicht verfügbar)';
                if (info.lat && info.lon) {
                    try {
                        const forecast = await fetchWeatherForecast(info.lat, info.lon);
                        if (forecast.length) {
                            weatherLines = forecast
                                .map(d => `  ${d.date}: ${d.tmin}–${d.tmax}°C, 🌧 ${d.precip} mm`)
                                .join('\n');
                        }
                    }
                    catch (_) { /* Wetter optional */ }
                }
                const trip = createTrip(destination, start, end, info.destination, info.climate, info.activities);
                updateTrip(trip.id, {
                    country_code: info.country_code,
                    currency: info.currency,
                    visa_de: info.visa_de,
                    distance_km: info.distance_km,
                    travel_mode: info.travel_mode,
                    door_to_door_estimate: info.door_to_door_estimate,
                    exchange_rate_eur: info.exchange_rate_eur,
                });
                return {
                    text: `✅ Reise *${trip.name}* angelegt (via Freitext + KI)!\n` +
                        `📅 ${trip.start_date} → ${trip.end_date}\n` +
                        `📍 ${info.destination} (${info.country_code})\n` +
                        `💶 Währung: ${info.currency}\n` +
                        `💱 Wechselkurs: ${info.exchange_rate_eur}\n` +
                        `🛂 Visum (DE-Pass): ${info.visa_de}\n` +
                        `📏 Luftlinie ab Tuttlingen: ${info.distance_km} km\n` +
                        `🚀 Verkehrsmittel: ${info.travel_mode}\n` +
                        `⏱ Haustür-zu-Haustür: ${info.door_to_door_estimate}\n` +
                        `🌡 Klima: ${info.climate}\n` +
                        `🎯 Aktivitäten: ${info.activities.join(", ")}\n` +
                        `☁️ Wetter (7-Tage-Vorschau):\n${weatherLines}\n` +
                        `🔑 ID: ${trip.id}`,
                };
            }
            catch (e) {
                return { text: `❌ KI-Anreicherung fehlgeschlagen: ${e.message}\nFallback: /tripnew ${destination} ${start} ${end}` };
            }
        },
    });
    api.registerCommand({
        name: "tripshow",
        acceptsArgs: true,
        description: "Reise anzeigen: /tripshow <id>",
        handler: async (ctx) => {
            const id = (ctx.args || "").trim();
            if (!id)
                return { text: "❌ Verwendung: /tripshow <trip-id>" };
            const trip = getTrip(id);
            if (!trip)
                return { text: `❌ Reise "${id}" nicht gefunden. /trips zeigt alle IDs.` };
            const segs = trip.segments.length
                ? trip.segments.map((s) => `  • [${s.type}] ${s.title} — ${s.datetime_local}${s.confirmation ? " ✔ " + s.confirmation : ""}`).join("\n")
                : "  (noch keine Segmente)";
            return { text: `✈️ *${trip.name}*\n📅 ${trip.start_date} → ${trip.end_date}\n📍 ${trip.destination || "–"}\n🌡 ${trip.climate} | 🎯 ${trip.activities.join(", ")}\n\n📋 Segmente:\n${segs}` };
        },
    });
    api.registerCommand({
        name: "tripadd",
        acceptsArgs: true,
        description: "Segment hinzufügen: /tripadd <trip-id> <type> <YYYY-MM-DDTHH:MM> <Timezone> <Titel> [Bestaetigung]",
        handler: async (ctx) => {
            const parts = (ctx.args || "").trim().split(/\s+/);
            if (parts.length < 5)
                return { text: "❌ Verwendung: /tripadd <trip-id> <type> <YYYY-MM-DDTHH:MM> <Timezone> <Titel> [Bestaetigung]\nBeispiel: /tripadd tokyo-2026-03 flight 2026-03-10T10:30 Europe/Berlin LH716-FRA-NRT ABC123" };
            const [tripId, type, datetime_local, timezone, ...rest] = parts;
            const confirmation = rest.length > 1 ? rest[rest.length - 1] : undefined;
            const title = confirmation ? rest.slice(0, -1).join(" ") : rest.join(" ");
            const dt = new Date(datetime_local);
            const datetime_utc = isNaN(dt.getTime()) ? datetime_local : dt.toISOString();
            const trip = addSegment(tripId, { type: type, datetime_local, datetime_utc, timezone, title, confirmation });
            if (!trip)
                return { text: `❌ Reise "${tripId}" nicht gefunden.` };
            return { text: `✅ Segment hinzugefügt zu *${trip.name}*:\n• [${type}] ${title}\n  📅 ${datetime_local} (${timezone})${confirmation ? "\n  ✔ Bestaetigung: " + confirmation : ""}` };
        },
    });
    api.registerCommand({
        name: "pack",
        acceptsArgs: true,
        description: "Packliste für eine Reise: /pack <trip-id>",
        handler: async (ctx) => {
            const id = (ctx.args || "").trim();
            if (!id)
                return { text: "❌ Verwendung: /pack <trip-id>" };
            const trip = getTrip(id);
            if (!trip)
                return { text: `❌ Reise "${id}" nicht gefunden. /trips zeigt alle IDs.` };
            return { text: generatePacklist(trip) };
        },
    });
    // ── Health Module ──────────────────────────────────────────────────────────
    api.registerCommand({
        name: "weight",
        acceptsArgs: true,
        description: "Letztes Gewicht anzeigen oder manuell loggen: /weight [kg]",
        handler: (ctx) => {
            const raw = String(ctx.args || "").trim();
            // Kein Argument → letzten Wert aus Health-Store anzeigen
            if (!raw) {
                const entries = readEntries().filter(e => e.type === "weight");
                if (!entries.length)
                    return { text: "⚖️ Noch kein Gewicht gespeichert.\nManuell: /weight 78.5\nOder: /healthsync" };
                const last = entries[entries.length - 1];
                return { text: `⚖️ Letztes Gewicht: ${last.value?.toFixed(1)} kg\n🕐 ${last.timestamp.slice(0, 16).replace("T", " ")}` };
            }
            // Mit Argument → manuell loggen
            const kg = parseFloat(raw.replace(",", "."));
            if (isNaN(kg) || kg < 20 || kg > 300)
                return { text: "❌ Verwendung: /weight 78.5" };
            const e = appendEntry({ type: "weight", value: kg, unit: "kg" });
            return { text: `⚖️ Gewicht gespeichert: ${kg.toFixed(1)} kg\n🕐 ${e.timestamp.slice(0, 16).replace("T", " ")}` };
        },
    });
    api.registerCommand({
        name: "sleep",
        acceptsArgs: true,
        description: "Schlaf loggen: /sleep <stunden> [qualität 1-5]",
        handler: (ctx) => {
            const parts = String(ctx.args || "").trim().split(/\s+/);
            const hours = parseFloat(parts[0]?.replace(",", ".") || "");
            if (isNaN(hours) || hours < 0 || hours > 24) {
                return { text: "❌ Verwendung: /sleep 7.5 [4]" };
            }
            const quality = parts[1] ? parseInt(parts[1]) : undefined;
            if (quality !== undefined && (isNaN(quality) || quality < 1 || quality > 5)) {
                return { text: "❌ Qualität muss zwischen 1 und 5 liegen." };
            }
            const e = appendEntry({ type: "sleep", value: hours, unit: "h", quality });
            const qStr = quality !== undefined ? `  |  Qualität: ${quality}/5` : "";
            return { text: `😴 Schlaf gespeichert: ${hours.toFixed(1)} h${qStr}\n🕐 ${e.timestamp.slice(0, 16).replace("T", " ")}` };
        },
    });
    api.registerCommand({
        name: "symptom",
        acceptsArgs: true,
        description: "Symptom loggen: /symptom <text>",
        handler: (ctx) => {
            const text = String(ctx.args || "").trim();
            if (!text)
                return { text: "❌ Verwendung: /symptom Kopfschmerzen seit heute Mittag" };
            const e = appendEntry({ type: "symptom", text });
            return { text: `🤒 Symptom gespeichert:\n„${text}"\n🕐 ${e.timestamp.slice(0, 16).replace("T", " ")}` };
        },
    });
    api.registerCommand({
        name: "healthlog",
        acceptsArgs: true,
        description: "Freitext-Gesundheitseintrag: /healthlog <text>",
        handler: (ctx) => {
            const text = String(ctx.args || "").trim();
            if (!text)
                return { text: "❌ Verwendung: /healthlog Heute Sport gemacht, fühle mich gut." };
            const e = appendEntry({ type: "log", text });
            return { text: `📝 Health-Log gespeichert:\n„${text}"\n🕐 ${e.timestamp.slice(0, 16).replace("T", " ")}` };
        },
    });
    api.registerCommand({
        name: "healthweek",
        description: "Health-Zusammenfassung letzte 7 Tage",
        handler: () => {
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const entries = readEntries(since);
            if (!entries.length)
                return { text: "📭 Keine Health-Einträge in den letzten 7 Tagen." };
            return { text: formatSummary(summarize(entries), "Woche") };
        },
    });
    api.registerCommand({
        name: "healthmonth",
        description: "Health-Zusammenfassung letzter Monat (30 Tage)",
        handler: () => {
            const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const entries = readEntries(since);
            if (!entries.length)
                return { text: "📭 Keine Health-Einträge in den letzten 30 Tagen." };
            return { text: formatSummary(summarize(entries), "Monat") };
        },
    });
    // ── Withings Module ────────────────────────────────────────────────────────
    const withingsClientId = process.env.WITHINGS_CLIENT_ID || '';
    const withingsClientSecret = process.env.WITHINGS_CLIENT_SECRET || '';
    const withingsRedirectUri = 'http://46.62.153.181:8080/withings/callback';
    const withingsCallbackPort = 8080;
    // Laufender Callback-Server (max. einer gleichzeitig)
    let withingsCallbackServer = null;
    api.registerCommand({
        name: 'withingsauth',
        description: 'Withings OAuth2 starten (temporärer Callback-Server): /withingsauth',
        handler: () => {
            if (!withingsClientId || !withingsClientSecret) {
                return { text: '❌ WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET nicht gesetzt.' };
            }
            // Vorherigen Server schließen falls noch aktiv
            if (withingsCallbackServer) {
                try {
                    withingsCallbackServer.close();
                }
                catch { }
                withingsCallbackServer = null;
            }
            const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
            const authUrl = buildAuthUrl(withingsClientId, withingsRedirectUri, state);
            // Temporären HTTP-Server starten
            const server = http.createServer(async (req, res) => {
                try {
                    const reqUrl = new URL(req.url || '/', `http://localhost:${withingsCallbackPort}`);
                    if (reqUrl.pathname !== '/withings/callback') {
                        res.writeHead(404);
                        res.end('Not found');
                        return;
                    }
                    const code = reqUrl.searchParams.get('code') || '';
                    const err = reqUrl.searchParams.get('error') || '';
                    if (err) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`<html><body><h2>❌ Withings Fehler: ${err}</h2></body></html>`);
                        server.close();
                        withingsCallbackServer = null;
                        return;
                    }
                    if (!code) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end('<html><body><h2>❌ Kein Code empfangen.</h2></body></html>');
                        return;
                    }
                    const tokens = await exchangeCode(withingsClientId, withingsClientSecret, code, withingsRedirectUri);
                    api.logger.info(`[withings] OAuth erfolgreich, userid=${tokens.userid}`);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<html><body style="font-family:sans-serif;padding:2em;text-align:center">
            <h2>✅ Withings erfolgreich verbunden!</h2>
            <p>User-ID: ${tokens.userid}</p>
            <p>Du kannst dieses Fenster schließen und in Telegram <strong>/healthsync</strong> ausführen.</p>
          </body></html>`);
                    server.close();
                    withingsCallbackServer = null;
                }
                catch (e) {
                    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<html><body><h2>❌ Fehler: ${e.message}</h2></body></html>`);
                    server.close();
                    withingsCallbackServer = null;
                }
            });
            server.on('error', (e) => {
                api.logger.error(`[withings] Callback-Server Fehler: ${e.message}`);
                withingsCallbackServer = null;
            });
            server.listen(withingsCallbackPort, '0.0.0.0', () => {
                api.logger.info(`[withings] Callback-Server gestartet auf Port ${withingsCallbackPort}`);
            });
            withingsCallbackServer = server;
            // Auto-Stop nach 60 Sekunden
            const timer = setTimeout(() => {
                if (withingsCallbackServer === server) {
                    server.close();
                    withingsCallbackServer = null;
                    api.logger.info('[withings] Callback-Server nach 60s automatisch gestoppt');
                }
            }, 60_000);
            server.on('close', () => clearTimeout(timer));
            const already = isAuthorized() ? ' (bereits verbunden — neu autorisieren)' : '';
            return {
                text: `🔐 Withings OAuth2${already}\n\n` +
                    `1. Öffne diesen Link im Browser:\n${authUrl}\n\n` +
                    `2. Bei Withings anmelden und Zugriff bestätigen.\n\n` +
                    `3. Der Browser wird automatisch zu diesem Server weitergeleitet.\n` +
                    `   ✅ Seite zeigt Erfolg → direkt /healthsync ausführen.\n\n` +
                    `⏱ Callback-Server läuft 60 Sekunden auf Port ${withingsCallbackPort}.`,
            };
        },
    });
    api.registerCommand({
        name: 'withingstoken',
        acceptsArgs: true,
        description: 'Withings OAuth-Code manuell einlösen: /withingstoken <code oder URL>',
        handler: async (ctx) => {
            try {
                const raw = String(ctx.args || '').trim();
                if (!raw)
                    return { text: '❌ Verwendung: /withingstoken <code>\nOder vollständige Redirect-URL einfügen.' };
                if (!withingsClientId || !withingsClientSecret) {
                    return { text: '❌ WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET nicht gesetzt.' };
                }
                // Akzeptiere vollen URL oder reinen Code
                let code = raw;
                try {
                    const parsed = new URL(raw);
                    const extracted = parsed.searchParams.get('code');
                    if (extracted)
                        code = extracted;
                }
                catch { /* kein URL → raw ist bereits der Code */ }
                code = code.replace(/['"]/g, '').trim();
                if (!code)
                    return { text: '❌ Kein Code gefunden in der Eingabe.' };
                const tokens = await exchangeCode(withingsClientId, withingsClientSecret, code, withingsRedirectUri);
                api.logger.info(`[withings] OAuth (manuell) erfolgreich, userid=${tokens.userid}`);
                return {
                    text: `✅ Withings erfolgreich verbunden!\n` +
                        `👤 User-ID: ${tokens.userid}\n\n` +
                        `Jetzt: /healthsync`,
                };
            }
            catch (e) {
                return { text: `❌ /withingstoken fehlgeschlagen: ${e.message}` };
            }
        },
    });
    api.registerCommand({
        name: 'healthsync',
        description: 'Withings-Daten importieren: /healthsync [tage]',
        acceptsArgs: true,
        handler: async (ctx) => {
            try {
                if (!withingsClientId || !withingsClientSecret) {
                    return { text: '❌ WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET nicht gesetzt.' };
                }
                const tokens = await ensureFreshToken(withingsClientId, withingsClientSecret);
                const daysArg = parseInt(String(ctx.args || '').trim()) || 30;
                const days = Math.max(1, Math.min(365, daysArg));
                const sinceMs = tokens.last_sync
                    ? tokens.last_sync - 24 * 60 * 60 * 1000 // 1 Tag Überlappung
                    : Date.now() - days * 24 * 60 * 60 * 1000;
                const parts = [`🔄 Withings Sync (seit ${new Date(sinceMs).toISOString().slice(0, 10)})...\n`];
                let totalNew = 0;
                // ── Measures (Gewicht, Körperfett, HR) ──
                try {
                    const measures = await fetchMeasures(tokens.access_token, sinceMs);
                    let mCount = 0;
                    for (const m of measures) {
                        if (m.weight_kg != null) {
                            appendEntryWithTimestamp(m.date, { type: 'weight', value: m.weight_kg, unit: 'kg', source: 'withings' });
                            mCount++;
                        }
                        if (m.fat_ratio_pct != null) {
                            appendEntryWithTimestamp(m.date, { type: 'body_fat', value: m.fat_ratio_pct, unit: '%', source: 'withings' });
                        }
                        if (m.hr_bpm != null) {
                            appendEntryWithTimestamp(m.date, { type: 'heartrate', hr_avg: m.hr_bpm, source: 'withings' });
                        }
                    }
                    parts.push(`⚖️ Messungen: ${measures.length} (${mCount} Gewicht)`);
                    totalNew += measures.length;
                }
                catch (e) {
                    parts.push(`⚖️ Messungen: ❌ ${e.message}`);
                }
                // ── Schlaf ──
                try {
                    const sleeps = await fetchWithingsSleep(tokens.access_token, sinceMs);
                    for (const s of sleeps) {
                        // Keep original sleep date (instead of "now") so briefing picks the right day.
                        const ts = new Date(`${s.date}T03:00:00.000Z`);
                        appendEntryWithTimestamp(ts, {
                            type: 'sleep', value: s.total_h, unit: 'h',
                            deep_sleep_h: s.deep_h, rem_sleep_h: s.rem_h, light_sleep_h: s.light_h,
                            quality: s.score, source: 'withings',
                        });
                    }
                    parts.push(`😴 Schlaf: ${sleeps.length} Nächte`);
                    totalNew += sleeps.length;
                }
                catch (e) {
                    parts.push(`😴 Schlaf: ❌ ${e.message}`);
                }
                // ── Aktivität (Schritte) ──
                try {
                    const activities = await fetchActivity(tokens.access_token, sinceMs);
                    for (const a of activities) {
                        if (a.steps > 0) {
                            appendEntry({
                                type: 'steps', steps: a.steps, distance_m: a.distance_m,
                                calories: a.calories, source: 'withings',
                            });
                        }
                        if (a.hr_avg) {
                            appendEntry({ type: 'heartrate', hr_avg: a.hr_avg, hr_min: a.hr_min, hr_max: a.hr_max, source: 'withings' });
                        }
                    }
                    const totalSteps = activities.reduce((s, a) => s + a.steps, 0);
                    parts.push(`👟 Aktivität: ${activities.length} Tage, ${totalSteps.toLocaleString('de')} Schritte gesamt`);
                    totalNew += activities.length;
                }
                catch (e) {
                    parts.push(`👟 Aktivität: ❌ ${e.message}`);
                }
                // ── Workouts ──
                try {
                    const workouts = await fetchWorkouts(tokens.access_token, sinceMs);
                    for (const w of workouts) {
                        appendEntry({
                            type: 'activity', activity_type: w.activity_type,
                            duration_min: w.duration_min, steps: w.steps,
                            distance_m: w.distance_m, calories: w.calories,
                            hr_avg: w.hr_avg, source: 'withings',
                        });
                    }
                    parts.push(`🏃 Workouts: ${workouts.length}`);
                    totalNew += workouts.length;
                }
                catch (e) {
                    parts.push(`🏃 Workouts: ❌ ${e.message}`);
                }
                // Update last_sync
                saveTokens({ ...tokens, last_sync: Date.now() });
                parts.push(`\n✅ ${totalNew} Einträge importiert.`);
                return { text: parts.join('\n') };
            }
            catch (e) {
                return { text: `❌ /healthsync fehlgeschlagen: ${e.message}` };
            }
        },
    });
    // ── Briefing ───────────────────────────────────────────────────────────────
    async function syncWithingsForBriefing() {
        if (!withingsClientId || !withingsClientSecret || !isAuthorized())
            return;
        try {
            const tokens = await ensureFreshToken(withingsClientId, withingsClientSecret);
            const sinceMs = Date.now() - 36 * 60 * 60 * 1000; // last 36h to catch morning updates
            const measures = await fetchMeasures(tokens.access_token, sinceMs).catch(() => []);
            for (const m of measures) {
                if (m.weight_kg != null)
                    appendEntryWithTimestamp(m.date, { type: 'weight', value: m.weight_kg, unit: 'kg', source: 'withings' });
                if (m.fat_ratio_pct != null)
                    appendEntryWithTimestamp(m.date, { type: 'body_fat', value: m.fat_ratio_pct, unit: '%', source: 'withings' });
                if (m.hr_bpm != null)
                    appendEntryWithTimestamp(m.date, { type: 'heartrate', hr_avg: m.hr_bpm, source: 'withings' });
            }
            const sleeps = await fetchWithingsSleep(tokens.access_token, sinceMs).catch(() => []);
            for (const s of sleeps) {
                const ts = new Date(`${s.date}T03:00:00.000Z`);
                appendEntryWithTimestamp(ts, {
                    type: 'sleep', value: s.total_h, unit: 'h',
                    deep_sleep_h: s.deep_h, rem_sleep_h: s.rem_h, light_sleep_h: s.light_h,
                    quality: s.score, source: 'withings',
                });
            }
            saveTokens({ ...tokens, last_sync: Date.now() });
        }
        catch (e) {
            api.logger.warn(`[executive-agent] Briefing-PreSync übersprungen: ${e.message}`);
        }
    }
    async function generateBriefingText() {
        const tz = 'Europe/Berlin';
        const now = new Date();
        const fmtDT = new Intl.DateTimeFormat('de-DE', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
        const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
        const parts = [`🧠 Briefing — ${fmtDT.format(now)}\n`];
        // ── (1) Wetter Tuttlingen ──
        try {
            const wRes = await fetchWithTimeout('https://api.open-meteo.com/v1/forecast' +
                '?latitude=48.0641&longitude=8.8236' +
                '&current=temperature_2m,apparent_temperature,precipitation,weathercode,windspeed_10m' +
                '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum' +
                '&timezone=Europe%2FBerlin&forecast_days=3', { method: 'GET' }, 10000);
            const wd = await wRes.json();
            const c = wd.current;
            const d = wd.daily;
            const wcode = {
                0: '☀️', 1: '🌤', 2: '⛅', 3: '☁️', 45: '🌫', 48: '🌫',
                51: '🌦', 53: '🌦', 55: '🌧', 61: '🌧', 63: '🌧', 65: '🌧',
                71: '🌨', 73: '🌨', 75: '❄️', 80: '🌦', 81: '🌧', 82: '⛈',
                95: '⛈', 96: '⛈', 99: '⛈',
            };
            const icon = wcode[c.weathercode] ?? '🌡';
            parts.push(`${icon} Wetter Tuttlingen: ${c.temperature_2m}°C (gefühlt ${c.apparent_temperature}°C), ` +
                `💨 ${c.windspeed_10m} km/h, 🌧 ${c.precipitation} mm\n` +
                `   Mo: ${d.temperature_2m_min[0]}–${d.temperature_2m_max[0]}°C ` +
                `Di: ${d.temperature_2m_min[1]}–${d.temperature_2m_max[1]}°C ` +
                `Mi: ${d.temperature_2m_min[2]}–${d.temperature_2m_max[2]}°C`);
        }
        catch {
            parts.push('🌡 Wetter: nicht verfügbar');
        }
        parts.push('');
        // ── (2) Kalender heute ──
        try {
            ensureM365Configured();
            const dayStart = new Date(now);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(now);
            dayEnd.setHours(23, 59, 59, 999);
            const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
                `/calendarView?startDateTime=${encodeURIComponent(dayStart.toISOString())}` +
                `&endDateTime=${encodeURIComponent(dayEnd.toISOString())}` +
                `&$select=subject,start,end,location&$orderby=start/dateTime`;
            const evData = await graphGet(tenantId, clientId, m365Secret, url);
            const evs = evData?.value || [];
            parts.push(`📅 Kalender heute (${evs.length} Termine)`);
            if (!evs.length) {
                parts.push('   • keine Termine');
            }
            else {
                for (const ev of evs) {
                    const s = new Date(ev.start.dateTime);
                    const e = new Date(ev.end.dateTime);
                    const loc = ev.location?.displayName ? ` | ${ev.location.displayName}` : '';
                    parts.push(`   • ${fmtTime.format(s)}–${fmtTime.format(e)} — ${ev.subject || '(kein Titel)'}${loc}`);
                }
            }
        }
        catch {
            parts.push('📅 Kalender: nicht verfügbar');
        }
        parts.push('');
        // ── (3) Gesundheit ──
        parts.push('🏥 Gesundheit (letzte Werte)');
        const todayBerlin = berlinDate(0);
        const yesterdayBerlin = berlinDate(-1);
        function dateHint(ts) {
            const d = ts.slice(0, 10);
            if (d === todayBerlin)
                return '';
            if (d === yesterdayBerlin)
                return ' (gestern)';
            return ` (${d})`;
        }
        const lastWeight = lastEntry('weight');
        const sleepEntries = readEntries().filter(e => e.type === 'sleep');
        const sleepByDay = new Map();
        for (const s of sleepEntries) {
            const day = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date(s.timestamp));
            const prev = sleepByDay.get(day);
            // Prefer the longest sleep entry per day to avoid showing a short nap.
            if (!prev || (Number(s.value || 0) > Number(prev.value || 0)))
                sleepByDay.set(day, s);
        }
        const lastSleep = Array.from(sleepByDay.values())
            .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
            .pop() || null;
        const lastSteps = lastEntry('steps');
        const lastHR = lastEntry('heartrate');
        if (lastWeight)
            parts.push(`   ⚖️ Gewicht: ${lastWeight.value?.toFixed(1)} kg${dateHint(lastWeight.timestamp)}`);
        else
            parts.push('   ⚖️ Gewicht: –');
        if (lastSleep) {
            const scoreStr = lastSleep.quality ? `  Score: ${lastSleep.quality}/100` : '';
            const deepStr = lastSleep.deep_sleep_h ? `  Tief: ${lastSleep.deep_sleep_h}h` : '';
            const remStr = lastSleep.rem_sleep_h ? `  REM: ${lastSleep.rem_sleep_h}h` : '';
            parts.push(`   😴 Schlaf: ${lastSleep.value?.toFixed(1)} h${scoreStr}${deepStr}${remStr}${dateHint(lastSleep.timestamp)}`);
        }
        else
            parts.push('   😴 Schlaf: –');
        if (lastSteps)
            parts.push(`   👟 Schritte: ${lastSteps.steps?.toLocaleString('de')}${dateHint(lastSteps.timestamp)}`);
        else
            parts.push('   👟 Schritte: –');
        if (lastHR)
            parts.push(`   ❤️ Herzfrequenz: ${lastHR.hr_avg} bpm${dateHint(lastHR.timestamp)}`);
        else
            parts.push('   ❤️ Herzfrequenz: –');
        parts.push('');
        // ── (4) Offene Drafts ──
        try {
            const ds = listDrafts('draft', 5);
            parts.push(`📝 Drafts (${ds.length} offen)`);
            if (!ds.length)
                parts.push('   • keine offenen Drafts');
            else
                for (const d of ds)
                    parts.push(`   • ${d.id} [${d.account}] — ${d.subject}`);
        }
        catch {
            parts.push('📝 Drafts: nicht verfügbar');
        }
        return parts.join('\n').trim();
    }
    api.registerCommand({
        name: 'briefing',
        description: 'Tages-Briefing: Wetter + Kalender + Gesundheit + Drafts',
        handler: async () => {
            try {
                await syncWithingsForBriefing();
                return { text: await generateBriefingText() };
            }
            catch (e) {
                return { text: `❌ /briefing fehlgeschlagen: ${e.message}` };
            }
        },
    });
    // ── SharePoint-Befehle ──────────────────────────────────────────────────────
    api.registerCommand({
        name: 'sharepoint',
        acceptsArgs: true,
        description: 'SharePoint: Ohne Arg → Sites auflisten. Mit Arg (siteId) → Drives auflisten.',
        handler: async (ctx) => {
            if (!m365Enabled || !tenantId || !clientId || !m365Secret) {
                return { text: '❌ M365-Konfiguration fehlt (tenant/client/secret).' };
            }
            const arg = String(ctx.args || '').trim();
            try {
                if (!arg) {
                    const sites = await listSites(tenantId, clientId, m365Secret);
                    if (!sites.length)
                        return { text: '📂 Keine SharePoint-Sites gefunden.' };
                    const lines = sites.map((s, i) => `${i + 1}. **${s.displayName}**\n   ID: \`${s.id}\`\n   ${s.webUrl}`);
                    return { text: `📂 **SharePoint-Sites** (${sites.length}):\n\n${lines.join('\n\n')}` };
                }
                else {
                    const drives = await listDrives(tenantId, clientId, m365Secret, arg);
                    if (!drives.length)
                        return { text: `📂 Keine Dokumentbibliotheken für Site gefunden.` };
                    const lines = drives.map((d, i) => `${i + 1}. **${d.name}** (${d.driveType})\n   ID: \`${d.id}\`\n   ${d.webUrl}`);
                    return { text: `📂 **Drives** (${drives.length}):\n\n${lines.join('\n\n')}` };
                }
            }
            catch (e) {
                return { text: `❌ /sharepoint Fehler: ${e.message}` };
            }
        },
    });
    api.registerCommand({
        name: 'spdocs',
        acceptsArgs: true,
        description: 'SharePoint-Volltextsuche: /spdocs <suchbegriff>',
        handler: async (ctx) => {
            if (!m365Enabled || !tenantId || !clientId || !m365Secret) {
                return { text: '❌ M365-Konfiguration fehlt.' };
            }
            const query = String(ctx.args || '').trim();
            if (!query)
                return { text: '❌ Verwendung: /spdocs <suchbegriff>' };
            try {
                const hits = await searchDocuments(tenantId, clientId, m365Secret, query);
                if (!hits.length)
                    return { text: `🔍 Keine Ergebnisse für „${query}".` };
                const top = hits.slice(0, 10);
                const lines = top.map((h, i) => {
                    const size = h.size ? ` · ${(h.size / 1024).toFixed(0)} KB` : '';
                    const date = h.lastModifiedDateTime ? ` · ${h.lastModifiedDateTime.slice(0, 10)}` : '';
                    const snippet = h.summary ? `\n   ${h.summary.slice(0, 120)}` : '';
                    return `${i + 1}. **${h.name}**${size}${date}\n   ${h.webUrl}${snippet}`;
                });
                return { text: `🔍 **Ergebnisse für „${query}"** (${hits.length}):\n\n${lines.join('\n\n')}` };
            }
            catch (e) {
                return { text: `❌ /spdocs Fehler: ${e.message}` };
            }
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
                if (!files.length)
                    return { text: '📂 Keine Änderungen in den letzten 24 Stunden.' };
                const top = files.slice(0, 15);
                const lines = top.map((f, i) => {
                    const date = f.lastModifiedDateTime ? f.lastModifiedDateTime.slice(0, 16).replace('T', ' ') : '';
                    const size = f.size ? ` · ${(f.size / 1024).toFixed(0)} KB` : '';
                    return `${i + 1}. **${f.name}**${size}\n   ${date}\n   ${f.webUrl}`;
                });
                return { text: `📂 **Kürzlich geändert** (${files.length}, max 15):\n\n${lines.join('\n\n')}` };
            }
            catch (e) {
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
            const send = async (msg) => {
                if (chatId) {
                    try {
                        await api.runtime.telegram.sendMessageTelegram(chatId, msg);
                    }
                    catch { }
                }
            };
            // fire-and-forget: sofort antworten, sync im Hintergrund
            (async () => {
                await send('🔄 SharePoint-Vollsync gestartet...');
                let lastReport = 0;
                try {
                    const result = await fullSync(tenantId, clientId, m365Secret, (count, siteName) => {
                        const now = Date.now();
                        if (now - lastReport > 10_000) { // max alle 10s
                            lastReport = now;
                            send(`🔄 Sync läuft... ${count} Dateien (aktuell: ${siteName})`);
                        }
                    });
                    const durSec = (result.durationMs / 1000).toFixed(1);
                    let summary = `✅ **SharePoint-Sync abgeschlossen**\n\n`;
                    summary += `📂 ${result.totalFiles} Dateien · ${result.totalSites} Sites · ${result.totalDrives} Drives\n`;
                    summary += `⏱ ${durSec}s`;
                    if (result.errors.length) {
                        summary += `\n\n⚠️ ${result.errors.length} Fehler:\n` + result.errors.slice(0, 5).map(e => `• ${e}`).join('\n');
                    }
                    await send(summary);
                    api.logger.info(`[executive-agent] spsync: ${result.totalFiles} files, ${result.totalSites} sites, ${durSec}s`);
                }
                catch (e) {
                    await send(`❌ SharePoint-Sync fehlgeschlagen: ${e.message}`);
                    api.logger.error(`[executive-agent] spsync error: ${e.message}`);
                }
            })();
            return { text: '🔄 SharePoint-Vollsync gestartet. Fortschritt kommt via Telegram.' };
        },
    });
    // ── Briefing-Zeit konfigurieren ────────────────────────────────────────────
    api.registerCommand({
        name: 'briefingtime',
        acceptsArgs: true,
        description: 'Briefing-Uhrzeit setzen: /briefingtime HH:MM  (Europe/Berlin, Standard: 07:00)',
        handler: (ctx) => {
            const raw = String(ctx.args || '').trim();
            if (!/^\d{1,2}:\d{2}$/.test(raw))
                return { text: '❌ Verwendung: /briefingtime 07:30' };
            const [h, m] = raw.split(':').map(Number);
            if (h < 0 || h > 23 || m < 0 || m > 59)
                return { text: '❌ Ungültige Uhrzeit.' };
            const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            const s = loadSettings();
            s.briefingTime = time;
            saveSettings(s);
            return {
                text: `⏰ Tägliches Briefing auf ${time} Uhr (Europe/Berlin) gesetzt.\n` +
                    `Chat-ID: ${s.telegramChatId || '(noch nicht erfasst — sende irgendeine Nachricht)'}`,
            };
        },
    });
    // ── Chat-ID aus eingehenden Nachrichten erfassen ───────────────────────────
    api.registerHook('message_received', (event) => {
        try {
            // Prefer real chat id; fallback to sender id.
            const id = String(event?.chatId ||
                event?.threadId ||
                event?.conversationId ||
                event?.senderId ||
                '').trim();
            if (!id)
                return;
            const s = loadSettings();
            if (s.telegramChatId !== id) {
                s.telegramChatId = id;
                saveSettings(s);
                api.logger.info(`[executive-agent] telegramChatId gespeichert: ${id}`);
            }
        }
        catch { }
    }, { name: 'capture-telegram-chat-id' });
    // ── SharePoint-Polling (alle 30 Minuten) ────────────────────────────────────
    setInterval(async () => {
        try {
            if (!m365Enabled || !tenantId || !clientId || !m365Secret)
                return;
            const s = loadSettings();
            if (!s.telegramChatId)
                return;
            const changes = await pollForChanges(tenantId, clientId, m365Secret);
            if (!changes.length)
                return;
            const lines = changes.slice(0, 10).map(c => `${c.changeType === 'created' ? '🆕' : '✏️'} ${c.fileName}\n   ${c.webUrl}`);
            const msg = `📂 **SharePoint-Änderungen** (${changes.length}):\n\n${lines.join('\n\n')}`;
            await api.runtime.telegram.sendMessageTelegram(s.telegramChatId, msg);
            api.logger.info(`[executive-agent] SharePoint-Poll: ${changes.length} Änderungen gesendet`);
        }
        catch (e) {
            api.logger.error(`[executive-agent] SharePoint-Poll Fehler: ${e.message}`);
        }
    }, 30 * 60_000);
    // ── Tägliches Briefing (Scheduler, prüft jede Minute) ─────────────────────
    let lastBriefingDate = '';
    setInterval(async () => {
        try {
            const s = loadSettings();
            if (!s.telegramChatId)
                return;
            // Aktuelle Berliner Zeit als HH:MM
            const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
            const hh = String(inBerlin.getHours()).padStart(2, '0');
            const mm = String(inBerlin.getMinutes()).padStart(2, '0');
            const nowHHMM = `${hh}:${mm}`;
            const today = berlinDate(0);
            if (nowHHMM === s.briefingTime && lastBriefingDate !== today) {
                lastBriefingDate = today;
                await syncWithingsForBriefing();
                const text = await generateBriefingText();
                await api.runtime.telegram.sendMessageTelegram(s.telegramChatId, text);
                api.logger.info(`[executive-agent] Tägliches Briefing gesendet (${today} ${nowHHMM})`);
            }
        }
        catch (e) {
            api.logger.error(`[executive-agent] Briefing-Scheduler Fehler: ${e.message}`);
        }
    }, 60_000);
    api.logger.info("[executive-agent] loaded v17 (spsync: Vollsync-Befehl)");
}
