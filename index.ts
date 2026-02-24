import fs from "node:fs";
import SunCalc from "suncalc";
import { createTrip, getTrip, listTrips, addSegment, removeSegment, updateSegment, generatePacklist, updateTrip } from "./travel-store.js";
import {
  listProperties, getProperty, updateProperty, addUnit, updateUnit, removeUnit,
  setDistributionKey, listLeases, getLeaseByUnit, setLease, deleteLease,
  getOperatingCosts, setOperatingCosts, calculateNk, seedInitialData,
  formatPropertyList, formatPropertyDetail, formatRentOverview, formatNkResult,
  COST_CATEGORIES,
} from "./assets-store.js";
import type { CostCategory } from "./assets-store.js";
import { appendEntry, appendEntryWithTimestamp, readEntries, lastEntry, summarize, formatSummary, getWeightTrend, getSleepTrend, checkHealthAlerts, hasEntryForDate } from "./health-store.js";
import type { HealthAlert } from "./health-store.js";
import {
  buildAuthUrl, exchangeCode, ensureFreshToken, saveTokens, isAuthorized,
  fetchMeasures, fetchSleep as fetchWithingsSleep, fetchActivity, fetchWorkouts,
} from "./withings-store.js";
import { listSites, listDrives, searchDocuments, getRecentFiles, pollForChanges, fullSync, searchLocalIndex, getIndexAge } from "./sharepoint-store.js";
import {
  getAllVehicles, getVehicle, createVehicle, updateVehicle, deleteVehicle,
  addServiceEntry, setInsurance, setTuevDate, addDocument, removeDocument,
  checkDeadlines, formatVehicleList, formatVehicleDetail,
  changeVehicleId, migrateHexIds,
} from "./fleet-store.js";
import {
  getLinksForEntity, addSharePointLink, addLocalLink, removeLink,
  searchSharePointForLinking, formatLinksForTelegram,
} from "./link-store.js";
import type { SpSearchResult } from "./link-store.js";
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

/* ---------------- Mail-Parsing: Buchungserkennung ---------------- */

type BookingType = 'FLIGHT' | 'HOTEL' | 'TRAIN' | 'CAR' | 'EVENT';

interface ParsedBooking {
  type: BookingType;
  title: string;
  destination: string;
  startDate: string;       // ISO8601
  endDate: string | null;
  confirmationNumber: string | null;
  provider: string;
}

interface ProcessedMails {
  version: 1;
  ids: string[];  // "m365::<msgId>" or "yahoo::<uid>"
}

const BOOKING_TO_SEGMENT: Record<BookingType, 'flight' | 'hotel' | 'activity' | 'transfer'> = {
  FLIGHT: 'flight',
  HOTEL: 'hotel',
  TRAIN: 'transfer',
  CAR: 'transfer',
  EVENT: 'activity',
};

const BOOKING_EMOJI: Record<BookingType, string> = {
  FLIGHT: '✈️',
  HOTEL: '🏨',
  TRAIN: '🚆',
  CAR: '🚗',
  EVENT: '🎫',
};

const SEGMENT_EMOJI: Record<string, string> = {
  flight: '✈️', hotel: '🏨', transfer: '🚆', activity: '🎫', note: '📝',
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
  method: "GET" | "POST" | "DELETE" | "PATCH",
  url: string,
  body?: any
): Promise<any> {
  const maxRetries = 3;

  // Helper to get a fresh token (optionally force refresh)
  const getToken = async (forceRefresh: boolean) => {
    if (forceRefresh) graphTokenCache.delete(cacheKey(tenantId, clientId));
    return graphToken(tenantId, clientId, clientSecret);
  };

  let token: string;
  try {
    token = await getToken(false);
  } catch {
    // Token fetch failed (network error) → one retry after 2s
    await sleep(2000);
    token = await getToken(false);
  }
  let didRefreshOn401 = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let fetchBody: any = undefined;

    if (method === "POST" || method === "PATCH") {
      headers["Content-Type"] = "application/json";
      fetchBody = JSON.stringify(body ?? {});
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method, headers, body: fetchBody }, 20000);
    } catch (e: any) {
      // Network error (TypeError: fetch failed, DNS, connection reset, etc.) → retry
      if (attempt < maxRetries) {
        await sleep(Math.min(2000 * Math.pow(2, attempt), 10000));
        continue;
      }
      throw new Error(`graph_${method.toLowerCase()}_network_error: ${e.message}`);
    }

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

async function graphDelete(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  url: string
): Promise<any> {
  return graphRequest(tenantId, clientId, clientSecret, "DELETE", url);
}

/* ---------------- Anthropic Trip Enrichment ---------------- */

function readAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const envPath = path.join(process.env.HOME || '/root', '.config/openclaw/env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === 'ANTHROPIC_API_KEY' && val) return val;
    }
  } catch {}
  return '';
}

interface TripEnrichment {
  destination: string;
  country_code: string;
  lat: number;
  lon: number;
  climate: string;
  activities: string[];
  currency: string;
  visa_de: string;
  distance_km: number;
  travel_mode: string;
  door_to_door_estimate: string;
  exchange_rate_eur: string;
}

interface WeatherDay {
  date: string;
  tmax: number;
  tmin: number;
  precip: number;
}

interface WeatherBriefing {
  currentTemp: number;
  currentDesc: string;
  todayMin: number;
  todayMax: number;
  todayRainHour: number | null;  // first hour with rain, or null
  tomorrowMin: number;
  tomorrowMax: number;
  tomorrowDesc: string;
}

const WMO_CODES: Record<number, string> = {
  0: 'sonnig ☀️', 1: 'überwiegend sonnig ☀️', 2: 'leicht bewölkt ⛅', 3: 'bewölkt ☁️',
  45: 'Nebel 🌫️', 48: 'Reifnebel 🌫️',
  51: 'leichter Niesel 🌦️', 53: 'Niesel 🌦️', 55: 'starker Niesel 🌧️',
  56: 'gefrierender Niesel 🌧️', 57: 'starker gef. Niesel 🌧️',
  61: 'leichter Regen 🌧️', 63: 'Regen 🌧️', 65: 'starker Regen 🌧️',
  66: 'gefrierender Regen 🌧️', 67: 'starker gef. Regen 🌧️',
  71: 'leichter Schneefall 🌨️', 73: 'Schneefall 🌨️', 75: 'starker Schneefall 🌨️',
  77: 'Schneegriesel 🌨️',
  80: 'Regenschauer 🌦️', 81: 'starke Schauer 🌧️', 82: 'Sturzregen 🌧️',
  85: 'Schneeschauer 🌨️', 86: 'starke Schneeschauer 🌨️',
  95: 'Gewitter ⛈️', 96: 'Gewitter mit Hagel ⛈️', 99: 'starkes Hagelgewitter ⛈️',
};

function wmoToText(code: number): string {
  return WMO_CODES[code] ?? `Code ${code}`;
}

async function fetchWeatherBriefing(lat: number, lon: number): Promise<WeatherBriefing> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code` +
    `&hourly=precipitation&forecast_hours=24` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
    `&timezone=Europe%2FBerlin&forecast_days=2`;

  const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
  if (!res.ok) throw new Error(`Open-Meteo Fehler: ${res.status}`);

  const data: any = await res.json();

  const currentTemp = Math.round(data.current?.temperature_2m ?? 0);
  const currentDesc = wmoToText(data.current?.weather_code ?? 0);

  const d = data.daily;
  const todayMin  = Math.round(d?.temperature_2m_min?.[0] ?? 0);
  const todayMax  = Math.round(d?.temperature_2m_max?.[0] ?? 0);
  const tomorrowMin  = Math.round(d?.temperature_2m_min?.[1] ?? 0);
  const tomorrowMax  = Math.round(d?.temperature_2m_max?.[1] ?? 0);
  const tomorrowDesc = wmoToText(d?.weather_code?.[1] ?? 0);

  // Find first hour with precipitation > 0
  let todayRainHour: number | null = null;
  const hourlyPrecip: number[] = data.hourly?.precipitation ?? [];
  const hourlyTimes: string[] = data.hourly?.time ?? [];
  for (let i = 0; i < hourlyPrecip.length; i++) {
    if (hourlyPrecip[i] > 0) {
      const h = new Date(hourlyTimes[i]).getHours();
      todayRainHour = h;
      break;
    }
  }

  return { currentTemp, currentDesc, todayMin, todayMax, todayRainHour, tomorrowMin, tomorrowMax, tomorrowDesc };
}

async function fetchWeatherForecast(lat: number, lon: number): Promise<WeatherDay[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
    `&timezone=auto&forecast_days=7`;

  const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
  if (!res.ok) throw new Error(`Open-Meteo Fehler: ${res.status}`);

  const data: any = await res.json();
  const d = data?.daily;
  if (!d?.time?.length) return [];

  return (d.time as string[]).map((date: string, i: number) => ({
    date,
    tmax:   Math.round(d.temperature_2m_max[i] ?? 0),
    tmin:   Math.round(d.temperature_2m_min[i] ?? 0),
    precip: Math.round((d.precipitation_sum[i] ?? 0) * 10) / 10,
  }));
}

async function enrichTripWithOpenAI(name: string): Promise<TripEnrichment> {
  const apiKey = readAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt (in ~/.config/openclaw/env eintragen)');

  const prompt =
    `Du hilfst bei der Reiseplanung. Der Nutzer plant eine Reise nach "${name}".\n` +
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    30000
  );

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Anthropic API Fehler: ${res.status} — ${err.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const content: string = data?.content?.[0]?.text || '';

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Anthropic: kein JSON in Antwort — ${content.slice(0, 200)}`);

  let parsed: any;
  try { parsed = JSON.parse(jsonMatch[0]); } catch (e: any) {
    throw new Error(`Anthropic: JSON parse fehlgeschlagen — ${e.message}`);
  }

  return {
    destination:           String(parsed.destination || name),
    country_code:          String(parsed.country_code || '').toUpperCase(),
    lat:                   Number(parsed.lat) || 0,
    lon:                   Number(parsed.lon) || 0,
    climate:               String(parsed.climate || 'temperate'),
    activities:            Array.isArray(parsed.activities) ? parsed.activities.map(String) : ['leisure'],
    currency:              String(parsed.currency || ''),
    visa_de:               String(parsed.visa_de || ''),
    distance_km:           Number(parsed.distance_km) || 0,
    travel_mode:           String(parsed.travel_mode || ''),
    door_to_door_estimate: String(parsed.door_to_door_estimate || ''),
    exchange_rate_eur:     String(parsed.exchange_rate_eur || ''),
  };
}

/* ---------------- /trip: Free-text → Haiku date parser ---------------- */

interface TripParseResult {
  destination: string;
  start: string; // YYYY-MM-DD (Europe/Berlin)
  end: string;   // YYYY-MM-DD (Europe/Berlin)
}

async function parseTripFreeText(
  text: string
): Promise<TripParseResult | { unclear: true; question: string }> {
  const apiKey = readAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');

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
  const nextMonMs     = todayUtc.getTime() + daysToNextMon * msDay;
  const nextNextMonMs = nextMonMs + 7 * msDay;
  const monNext     = new Date(nextMonMs).toISOString().slice(0, 10);
  const monNextNext = new Date(nextNextMonMs).toISOString().slice(0, 10);

  const prompt =
    `Heute ist der ${todayBerlin} (Wochentag: ${['So','Mo','Di','Mi','Do','Fr','Sa'][todayUtc.getUTCDay()]}, Zeitzone Europe/Berlin).\n\n` +
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    20000
  );

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Anthropic API Fehler: ${res.status} — ${err.slice(0, 200)}`);
  }

  const data: any = await res.json();
  const content: string = data?.content?.[0]?.text || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Haiku: kein JSON in Antwort — ${content.slice(0, 200)}`);

  let parsed: any;
  try { parsed = JSON.parse(jsonMatch[0]); } catch (e: any) {
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

const SETTINGS_FILE = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/health/settings.json'
);

interface LocationSetting {
  lat: number;
  lon: number;
  label: string;
  updatedAt?: string; // ISO timestamp
}

interface Settings {
  briefingTime: string;    // "HH:MM" Europe/Berlin
  telegramChatId?: string; // captured from first incoming message
  healthReportDay?: number; // 0=So, 1=Mo, ..., 6=Sa (default: 1=Mo)
  location?: LocationSetting;
}

function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { briefingTime: '07:00', ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
    }
  } catch {}
  return { briefingTime: '07:00' };
}

function saveSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

/** Returns YYYY-MM-DD in Europe/Berlin, with optional day offset */
function berlinDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

const DEFAULT_LOCATION: LocationSetting = { lat: 47.9838, lon: 8.8234, label: "Tuttlingen" };

function getLocationSettings(): LocationSetting {
  try {
    const s = loadSettings();
    if (s.location && s.location.lat != null && s.location.lon != null) {
      return s.location;
    }
  } catch {}
  return DEFAULT_LOCATION;
}

interface AstroData {
  sunrise: string;   // HH:MM
  sunset: string;    // HH:MM
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
    moonIcon,
    moonPhase,
    illumination: Math.round(moon.fraction * 100),
  };
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
   * Returns true if the message was sent successfully.
   */
  async function sendTelegram(chatId: string, text: string): Promise<boolean> {
    // Try plugin API first
    try {
      if (api.runtime?.channel?.telegram?.sendMessageTelegram) {
        await api.runtime.channel.telegram.sendMessageTelegram(chatId, text);
        return true;
      }
    } catch (err: any) {
      api.logger.warn(`[executive-agent] plugin telegram-send failed: ${err.message}, trying direct API...`);
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
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        api.logger.error(`[executive-agent] direct telegram-send HTTP ${res.status}: ${body}`);
        return false;
      }
      api.logger.info('[executive-agent] message sent via direct Telegram Bot API');
      return true;
    } catch (err: any) {
      api.logger.error(`[executive-agent] direct telegram-send failed: ${err.message}`);
      return false;
    }
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
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        api.logger.error(`[executive-agent] keyboard-send HTTP ${res.status}: ${body}`);
        return false;
      }
      return true;
    } catch (err: any) {
      api.logger.error(`[executive-agent] keyboard-send failed: ${err.message}`);
      return false;
    }
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

  /* --- Pending-Booking State --- */

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

  /* --- Pending Segment-Deletion State (Telegram Inline Keyboard) --- */
  const pendingSegmentDeletions = new Map<string, {
    tripId: string;
    segmentId: string;
    calendarEventId: string;
    expiresAt: number;
  }>();

  /* --- Calendar Sync for Trip Segments --- */

  async function createSegmentCalendarEvent(
    tripId: string,
    segmentId: string,
  ): Promise<{ eventId: string; webLink: string } | null> {
    if (!m365Enabled || !tenantId || !clientId || !m365Secret || !m365User) return null;
    const trip = getTrip(tripId);
    if (!trip) return null;
    const seg = trip.segments.find(s => s.id === segmentId);
    if (!seg) return null;

    const emoji = SEGMENT_EMOJI[seg.type] || '📋';
    const subject = `${trip.name} — ${emoji} ${seg.title}`;
    const isHotel = seg.type === 'hotel';
    const startDt = seg.datetime_local || trip.start_date + 'T12:00:00';
    const endDate = new Date(startDt);
    endDate.setHours(endDate.getHours() + (isHotel ? 24 : 1));
    const endDt = endDate.toISOString().replace('Z', '');

    const bodyParts = [
      seg.confirmation && `Bestätigung: ${seg.confirmation}`,
      seg.notes && `Notizen: ${seg.notes}`,
      `Trip: ${trip.name} (${trip.id})`,
    ].filter(Boolean);

    try {
      const calUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}/events`;
      const event = await graphPost(tenantId, clientId, m365Secret, calUrl, {
        subject,
        start: { dateTime: startDt, timeZone: seg.timezone || 'Europe/Berlin' },
        end: { dateTime: endDt, timeZone: seg.timezone || 'Europe/Berlin' },
        location: trip.destination ? { displayName: trip.destination } : undefined,
        body: bodyParts.length ? { contentType: 'Text', content: bodyParts.join('\n') } : undefined,
      });
      if (event?.id) {
        updateSegment(tripId, segmentId, {
          calendarEventId: event.id,
          calendarWebLink: event.webLink || '',
        });
        return { eventId: event.id, webLink: event.webLink || '' };
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] createSegmentCalendarEvent failed: ${e.message}`);
    }
    return null;
  }

  async function deleteSegmentCalendarEvent(calendarEventId: string): Promise<boolean> {
    if (!m365Enabled || !tenantId || !clientId || !m365Secret || !m365User) return false;
    try {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}/events/${encodeURIComponent(calendarEventId)}`;
      await graphDelete(tenantId, clientId, m365Secret, url);
      return true;
    } catch (e: any) {
      api.logger.error(`[executive-agent] deleteSegmentCalendarEvent failed: ${e.message}`);
      return false;
    }
  }

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

    const client = new ImapFlow({
      host: yahooImapHost,
      port: yahooImapPort,
      secure: true,
      auth: { user: yahooUser, pass: yahooPass },
    });

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
      try { await client.logout(); } catch {}
    }
  }

  /* ---------------- Haiku: Buchungsanalyse ---------------- */

  async function analyzeMailForBooking(subject: string, from: string, bodyText: string): Promise<ParsedBooking | null> {
    const apiKey = readAnthropicKey();
    if (!apiKey) return null;

    const prompt =
      `Analysiere die folgende E-Mail. Handelt es sich um eine Reise-Buchungsbestätigung ` +
      `(Flug, Hotel, Bahn, Mietwagen, Event/Veranstaltung)?\n\n` +
      `Falls JA, antworte NUR mit einem JSON-Objekt:\n` +
      `{\n` +
      `  "type": "FLIGHT" | "HOTEL" | "TRAIN" | "CAR" | "EVENT",\n` +
      `  "title": "<Kurzbezeichnung, z.B. 'LH1234 München → Frankfurt'>",\n` +
      `  "destination": "<Zielort>",\n` +
      `  "startDate": "<ISO8601 Datum/Zeit>",\n` +
      `  "endDate": "<ISO8601 Datum/Zeit oder null>",\n` +
      `  "confirmationNumber": "<Buchungsnummer oder null>",\n` +
      `  "provider": "<Anbieter, z.B. Lufthansa, Booking.com>"\n` +
      `}\n\n` +
      `Falls NEIN (Newsletter, Werbung, normale Korrespondenz), antworte NUR mit: null\n\n` +
      `--- E-Mail ---\n` +
      `Von: ${from}\n` +
      `Betreff: ${subject}\n\n` +
      `${bodyText.slice(0, 3000)}\n` +
      `--- Ende ---`;

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
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
          }),
        },
        30000,
      );

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        api.logger.warn(`[executive-agent] Haiku booking-analysis HTTP ${res.status}: ${err.slice(0, 200)}`);
        return null;
      }

      const data: any = await res.json();
      const content: string = data?.content?.[0]?.text || '';

      // "null" response means no booking
      if (content.trim() === 'null' || content.trim() === '`null`') return null;

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed: any = JSON.parse(jsonMatch[0]);

      const validTypes: BookingType[] = ['FLIGHT', 'HOTEL', 'TRAIN', 'CAR', 'EVENT'];
      const type = validTypes.includes(parsed.type) ? parsed.type as BookingType : null;
      if (!type) return null;

      return {
        type,
        title: String(parsed.title || subject),
        destination: String(parsed.destination || ''),
        startDate: String(parsed.startDate || ''),
        endDate: parsed.endDate ? String(parsed.endDate) : null,
        confirmationNumber: parsed.confirmationNumber ? String(parsed.confirmationNumber) : null,
        provider: String(parsed.provider || ''),
      };
    } catch (e: any) {
      api.logger.warn(`[executive-agent] analyzeMailForBooking Fehler: ${e.message}`);
      return null;
    }
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


  // ── Travel Module ─────────────────────────────────────────────────────────

  api.registerCommand({
    name: "trips",
    description: "Alle Reisen anzeigen",
    handler: async () => {
      const trips = listTrips();
      if (!trips.length) return { text: "📭 Keine Reisen gespeichert. Mit /tripnew anlegen." };
      const lines = trips.map(t =>
        `✈️ *${t.name}* (${t.id})\n   📅 ${t.start_date} → ${t.end_date}\n   📍 ${t.destination || "–"}  🌡 ${t.climate}  🎯 ${t.activities.join(", ")}\n   📦 ${t.segments.length} Segment(e)`
      );
      return { text: `🗺 Deine Reisen:\n\n${lines.join("\n\n")}` };
    },
  });

  api.registerCommand({
    name: "tripnew",
    acceptsArgs: true,
    description: "Neue Reise anlegen: /tripnew <name> <start> <end> — bei nur 3 Args: KI-Anreicherung via OpenAI",
    handler: async (ctx: any) => {
      const raw = (ctx.args || "").trim();
      const tokens = raw.split(/\s+/);

      // Finde den ersten Token im Format YYYY-MM-DD → alles davor ist der Name
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      const firstDateIdx = tokens.findIndex((t: string) => datePattern.test(t));
      if (firstDateIdx < 1 || firstDateIdx + 1 >= tokens.length) {
        return { text: "❌ Verwendung: /tripnew New York 2026-03-03 2026-03-05\nOder manuell: /tripnew Tokyo 2026-03-10 2026-03-18 Japan temperate leisure,city" };
      }

      const name       = tokens.slice(0, firstDateIdx).join(" ");
      const start_date = tokens[firstDateIdx];
      const end_date   = tokens[firstDateIdx + 1];
      const rest       = tokens.slice(firstDateIdx + 2); // optionale manuelle Params

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
            } catch (_) { /* Wetter optional */ }
          }

          const trip = createTrip(name, start_date, end_date, info.destination, info.climate as any, info.activities as any[]);
          updateTrip(trip.id, {
            country_code:          info.country_code,
            currency:              info.currency,
            visa_de:               info.visa_de,
            distance_km:           info.distance_km,
            travel_mode:           info.travel_mode,
            door_to_door_estimate: info.door_to_door_estimate,
            exchange_rate_eur:     info.exchange_rate_eur,
          } as any);

          return {
            text:
              `✅ Reise *${trip.name}* angelegt (KI-angereichert)!\n` +
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
        } catch (e: any) {
          return { text: `❌ KI-Anreicherung fehlgeschlagen: ${e.message}\nTipp: /tripnew ${name} ${start_date} ${end_date} <destination> <climate> <activities>` };
        }
      }

      // ── Manueller Modus ──
      const destination   = rest[0] || "";
      const climate       = rest[1] || "temperate";
      const activitiesRaw = rest[2] || "leisure";
      const activities = activitiesRaw.split(",").map((a: string) => a.trim()) as any[];
      const trip = createTrip(name, start_date, end_date, destination, climate as any, activities);
      return { text: `✅ Reise *${trip.name}* angelegt!\n📅 ${trip.start_date} → ${trip.end_date}\n📍 ${trip.destination || "–"}\n🌡 Klima: ${trip.climate}\n🎯 Aktivitäten: ${trip.activities.join(", ")}\n🔑 ID: ${trip.id}` };
    },
  });

  // ── /trip: Free-text Reise anlegen via Haiku ──────────────────────────────
  api.registerCommand({
    name: "trip",
    acceptsArgs: true,
    description: "Reise per Freitext anlegen: /trip Ich fahre nächste Woche nach Barcelona bis zum 3. März",
    handler: async (ctx: any) => {
      const raw = (ctx.args || "").trim();
      if (!raw) {
        return { text: "Bitte beschreibe deine Reise, z. B.:\n/trip Ich fliege nächsten Montag nach Tokyo und komme am 15. März zurück" };
      }

      // Haiku parst Freitext → { destination, start, end } oder { unclear, question }
      let parsed: TripParseResult | { unclear: true; question: string };
      try {
        parsed = await parseTripFreeText(raw);
      } catch (e: any) {
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
          } catch (_) { /* Wetter optional */ }
        }

        const trip = createTrip(destination, start, end, info.destination, info.climate as any, info.activities as any[]);
        updateTrip(trip.id, {
          country_code:          info.country_code,
          currency:              info.currency,
          visa_de:               info.visa_de,
          distance_km:           info.distance_km,
          travel_mode:           info.travel_mode,
          door_to_door_estimate: info.door_to_door_estimate,
          exchange_rate_eur:     info.exchange_rate_eur,
        } as any);

        return {
          text:
            `✅ Reise *${trip.name}* angelegt (via Freitext + KI)!\n` +
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
      } catch (e: any) {
        return { text: `❌ KI-Anreicherung fehlgeschlagen: ${e.message}\nFallback: /tripnew ${destination} ${start} ${end}` };
      }
    },
  });

  api.registerCommand({
    name: "tripshow",
    acceptsArgs: true,
    description: "Reise anzeigen: /tripshow <id>",
    handler: async (ctx: any) => {
      const id = (ctx.args || "").trim();
      if (!id) return { text: "❌ Verwendung: /tripshow <trip-id>" };
      const trip = getTrip(id);
      if (!trip) return { text: `❌ Reise "${id}" nicht gefunden. /trips zeigt alle IDs.` };
      const segs = trip.segments.length
        ? trip.segments.map((s: any) => `  • [${s.type}] ${s.title} — ${s.datetime_local}${s.confirmation ? " ✔ " + s.confirmation : ""}`).join("\n")
        : "  (noch keine Segmente)";
      let text = `✈️ *${trip.name}*\n📅 ${trip.start_date} → ${trip.end_date}\n📍 ${trip.destination || "–"}\n🌡 ${trip.climate} | 🎯 ${trip.activities.join(", ")}\n\n📋 Segmente:\n${segs}`;
      const links = getLinksForEntity("trip", id);
      if (links.length) {
        text += `\n\n📎 Verknüpfte Dokumente:\n${formatLinksForTelegram(links)}`;
      }
      return { text };
    },
  });

  api.registerCommand({
    name: "tripadd",
    acceptsArgs: true,
    description: "Segment hinzufügen: /tripadd <trip-id> <type> <YYYY-MM-DDTHH:MM> <Timezone> <Titel> [Bestaetigung]",
    handler: async (ctx: any) => {
      const parts = (ctx.args || "").trim().split(/\s+/);
      if (parts.length < 5) return { text: "❌ Verwendung: /tripadd <trip-id> <type> <YYYY-MM-DDTHH:MM> <Timezone> <Titel> [Bestaetigung]\nBeispiel: /tripadd tokyo-2026-03 flight 2026-03-10T10:30 Europe/Berlin LH716-FRA-NRT ABC123" };
      const [tripId, type, datetime_local, timezone, ...rest] = parts;
      const confirmation = rest.length > 1 ? rest[rest.length - 1] : undefined;
      const title = confirmation ? rest.slice(0, -1).join(" ") : rest.join(" ");
      const dt = new Date(datetime_local);
      const datetime_utc = isNaN(dt.getTime()) ? datetime_local : dt.toISOString();
      const trip = addSegment(tripId, { type: type as any, datetime_local, datetime_utc, timezone, title, confirmation });
      if (!trip) return { text: `❌ Reise "${tripId}" nicht gefunden.` };
      const newSeg = trip.segments[trip.segments.length - 1];
      let calInfo = '';
      if (newSeg) {
        const cal = await createSegmentCalendarEvent(tripId, newSeg.id);
        if (cal) calInfo = `\n  📅 Kalendereintrag erstellt`;
      }
      return { text: `✅ Segment hinzugefügt zu *${trip.name}*:\n• [${type}] ${title}\n  📅 ${datetime_local} (${timezone})${confirmation ? "\n  ✔ Bestaetigung: " + confirmation : ""}${calInfo}` };
    },
  });

  api.registerCommand({
    name: "tripdel",
    acceptsArgs: true,
    description: "Segment entfernen: /tripdel <trip-id> <segment-id>",
    handler: async (ctx: any) => {
      const parts = (ctx.args || "").trim().split(/\s+/);
      if (parts.length < 2) return { text: "❌ Verwendung: /tripdel <trip-id> <segment-id>" };
      const [tripId, segmentId] = parts;
      const result = removeSegment(tripId, segmentId);
      if (!result) return { text: `❌ Segment "${segmentId}" in Reise "${tripId}" nicht gefunden.` };
      const { trip, removed } = result;
      const emoji = SEGMENT_EMOJI[removed.type] || '📋';

      if (removed.calendarEventId) {
        const delKey = `segdel_${crypto.randomBytes(6).toString('hex')}`;
        pendingSegmentDeletions.set(delKey, {
          tripId,
          segmentId,
          calendarEventId: removed.calendarEventId,
          expiresAt: Date.now() + 30 * 60_000,
        });
        const chatId = ctx.chatId || ctx.threadId || ctx.conversationId || '';
        if (chatId) {
          await sendTelegramWithKeyboard(
            chatId,
            `✅ Segment entfernt: ${emoji} ${removed.title}\n\n📅 Kalendereintrag ebenfalls löschen?`,
            [[
              { text: '✅ Ja, löschen', callback_data: `${delKey}::yes` },
              { text: '❌ Nein, behalten', callback_data: `${delKey}::no` },
            ]],
          );
          return { text: '' };
        }
      }
      return { text: `✅ Segment entfernt aus *${trip.name}*:\n${emoji} ${removed.title}` };
    },
  });

  api.registerCommand({
    name: "tripsync",
    acceptsArgs: true,
    description: "Kalender-Sync für alle Segmente: /tripsync <trip-id>",
    handler: async (ctx: any) => {
      const tripId = (ctx.args || "").trim();
      if (!tripId) return { text: "❌ Verwendung: /tripsync <trip-id>" };
      const trip = getTrip(tripId);
      if (!trip) return { text: `❌ Reise "${tripId}" nicht gefunden.` };
      let created = 0, skipped = 0, failed = 0;
      for (const seg of trip.segments) {
        if (seg.calendarEventId) { skipped++; continue; }
        const cal = await createSegmentCalendarEvent(tripId, seg.id);
        if (cal) { created++; } else { failed++; }
      }
      return { text: `📅 Kalender-Sync für *${trip.name}*:\n✅ ${created} erstellt, ⏭ ${skipped} vorhanden, ❌ ${failed} fehlgeschlagen` };
    },
  });

  api.registerCommand({
    name: "pack",
    acceptsArgs: true,
    description: "Packliste für eine Reise: /pack <trip-id>",
    handler: async (ctx: any) => {
      const id = (ctx.args || "").trim();
      if (!id) return { text: "❌ Verwendung: /pack <trip-id>" };
      const trip = getTrip(id);
      if (!trip) return { text: `❌ Reise "${id}" nicht gefunden. /trips zeigt alle IDs.` };
      return { text: generatePacklist(trip) };
    },
  });

  // ── Health Module ──────────────────────────────────────────────────────────

  api.registerCommand({
    name: "weight",
    acceptsArgs: true,
    description: "Letztes Gewicht anzeigen oder manuell loggen: /weight [kg]",
    handler: (ctx: any) => {
      const raw = String(ctx.args || "").trim();

      // Kein Argument → letzten Wert aus Health-Store anzeigen
      if (!raw) {
        const entries = readEntries().filter(e => e.type === "weight");
        if (!entries.length) return { text: "⚖️ Noch kein Gewicht gespeichert.\nManuell: /weight 78.5\nOder: /healthsync" };
        const last = entries[entries.length - 1];
        return { text: `⚖️ Letztes Gewicht: ${last.value?.toFixed(1)} kg\n🕐 ${last.timestamp.slice(0, 16).replace("T", " ")}` };
      }

      // Mit Argument → manuell loggen
      const kg = parseFloat(raw.replace(",", "."));
      if (isNaN(kg) || kg < 20 || kg > 300) return { text: "❌ Verwendung: /weight 78.5" };
      const e = appendEntry({ type: "weight", value: kg, unit: "kg" });
      return { text: `⚖️ Gewicht gespeichert: ${kg.toFixed(1)} kg\n🕐 ${e.timestamp.slice(0, 16).replace("T", " ")}` };
    },
  });

  api.registerCommand({
    name: "sleep",
    acceptsArgs: true,
    description: "Schlaf loggen: /sleep <stunden> [qualität 1-5]",
    handler: (ctx: any) => {
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
    handler: (ctx: any) => {
      const text = String(ctx.args || "").trim();
      if (!text) return { text: "❌ Verwendung: /symptom Kopfschmerzen seit heute Mittag" };
      const e = appendEntry({ type: "symptom", text });
      return { text: `🤒 Symptom gespeichert:\n„${text}"\n🕐 ${e.timestamp.slice(0, 16).replace("T", " ")}` };
    },
  });

  api.registerCommand({
    name: "healthlog",
    acceptsArgs: true,
    description: "Freitext-Gesundheitseintrag: /healthlog <text>",
    handler: (ctx: any) => {
      const text = String(ctx.args || "").trim();
      if (!text) return { text: "❌ Verwendung: /healthlog Heute Sport gemacht, fühle mich gut." };
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
      if (!entries.length) return { text: "📭 Keine Health-Einträge in den letzten 7 Tagen." };
      return { text: formatSummary(summarize(entries), "Woche") };
    },
  });

  api.registerCommand({
    name: "healthmonth",
    description: "Health-Zusammenfassung letzter Monat (30 Tage)",
    handler: () => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const entries = readEntries(since);
      if (!entries.length) return { text: "📭 Keine Health-Einträge in den letzten 30 Tagen." };
      return { text: formatSummary(summarize(entries), "Monat") };
    },
  });

  api.registerCommand({
    name: 'healthtrend',
    acceptsArgs: true,
    description: 'Gewichts- und Schlaftrend: /healthtrend [7|30|90]  (Default: 30)',
    handler: (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      const days = ([7, 30, 90] as const).includes(Number(raw) as any) ? (Number(raw) as 7 | 30 | 90) : 30;

      const parts: string[] = [`📊 Health-Trend (${days} Tage)\n`];

      const wt = getWeightTrend(days);
      if (wt) {
        const arrow = wt.direction === 'up' ? '📈' : wt.direction === 'down' ? '📉' : '➡️';
        const sign = wt.change > 0 ? '+' : '';
        parts.push(`⚖️ Gewicht:`);
        parts.push(`   Aktuell: ${wt.current} kg  ${arrow} ${sign}${wt.change} kg`);
        parts.push(`   Min: ${wt.min} kg  |  Max: ${wt.max} kg  |  Ø ${wt.avg} kg`);
        parts.push(`   Datenpunkte: ${wt.dataPoints}`);
      } else {
        parts.push('⚖️ Gewicht: keine Daten');
      }

      parts.push('');

      const st = getSleepTrend(days);
      if (st) {
        parts.push('😴 Schlaf:');
        parts.push(`   Ø ${st.avgDuration} h  |  Min: ${st.minDuration} h  |  Max: ${st.maxDuration} h`);
        if (st.avgQuality) parts.push(`   Qualität: Ø ${st.avgQuality}%`);
        parts.push(`   Datenpunkte: ${st.dataPoints}`);
      } else {
        parts.push('😴 Schlaf: keine Daten');
      }

      return { text: parts.join('\n') };
    },
  });

  api.registerCommand({
    name: 'healthalerts',
    description: 'Aktive Health-Alerts anzeigen',
    handler: () => {
      const alerts = checkHealthAlerts();
      if (!alerts.length) return { text: '✅ Keine aktiven Health-Alerts.' };

      const icons: Record<string, string> = { critical: '🔴', warning: '⚠️', info: 'ℹ️' };
      const lines = alerts.map(a => `${icons[a.severity] || '•'} ${a.message}`);
      return { text: `🚨 Health-Alerts (${alerts.length}):\n\n${lines.join('\n')}` };
    },
  });

  // ── Withings Module ────────────────────────────────────────────────────────

  const withingsClientId     = process.env.WITHINGS_CLIENT_ID || '';
  const withingsClientSecret = process.env.WITHINGS_CLIENT_SECRET || '';
  const withingsRedirectUri  = 'http://46.62.153.181:8080/withings/callback';
  const withingsCallbackPort = 8080;

  // Laufender Callback-Server (max. einer gleichzeitig)
  let withingsCallbackServer: http.Server | null = null;

  api.registerCommand({
    name: 'withingsauth',
    description: 'Withings OAuth2 starten (temporärer Callback-Server): /withingsauth',
    handler: () => {
      if (!withingsClientId || !withingsClientSecret) {
        return { text: '❌ WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET nicht gesetzt.' };
      }

      // Vorherigen Server schließen falls noch aktiv
      if (withingsCallbackServer) {
        try { withingsCallbackServer.close(); } catch {}
        withingsCallbackServer = null;
      }

      const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      const authUrl = buildAuthUrl(withingsClientId, withingsRedirectUri, state);

      // Temporären HTTP-Server starten
      const server = http.createServer(async (req: any, res: any) => {
        try {
          const reqUrl = new URL(req.url || '/', `http://localhost:${withingsCallbackPort}`);
          if (reqUrl.pathname !== '/withings/callback') {
            res.writeHead(404); res.end('Not found'); return;
          }

          const code  = reqUrl.searchParams.get('code')  || '';
          const err   = reqUrl.searchParams.get('error') || '';

          if (err) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body><h2>❌ Withings Fehler: ${err}</h2></body></html>`);
            server.close(); withingsCallbackServer = null;
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

          server.close(); withingsCallbackServer = null;
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body><h2>❌ Fehler: ${e.message}</h2></body></html>`);
          server.close(); withingsCallbackServer = null;
        }
      });

      server.on('error', (e: any) => {
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
        text:
          `🔐 Withings OAuth2${already}\n\n` +
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
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        if (!raw) return { text: '❌ Verwendung: /withingstoken <code>\nOder vollständige Redirect-URL einfügen.' };
        if (!withingsClientId || !withingsClientSecret) {
          return { text: '❌ WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET nicht gesetzt.' };
        }

        // Akzeptiere vollen URL oder reinen Code
        let code = raw;
        try {
          const parsed = new URL(raw);
          const extracted = parsed.searchParams.get('code');
          if (extracted) code = extracted;
        } catch { /* kein URL → raw ist bereits der Code */ }
        code = code.replace(/['"]/g, '').trim();

        if (!code) return { text: '❌ Kein Code gefunden in der Eingabe.' };

        const tokens = await exchangeCode(withingsClientId, withingsClientSecret, code, withingsRedirectUri);
        api.logger.info(`[withings] OAuth (manuell) erfolgreich, userid=${tokens.userid}`);
        return {
          text:
            `✅ Withings erfolgreich verbunden!\n` +
            `👤 User-ID: ${tokens.userid}\n\n` +
            `Jetzt: /healthsync`,
        };
      } catch (e: any) {
        return { text: `❌ /withingstoken fehlgeschlagen: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'healthsync',
    description: 'Withings-Daten importieren: /healthsync [tage]',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      try {
        if (!withingsClientId || !withingsClientSecret) {
          return { text: '❌ WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET nicht gesetzt.' };
        }
        const tokens = await ensureFreshToken(withingsClientId, withingsClientSecret);
        const daysArg = parseInt(String(ctx.args || '').trim()) || 30;
        const days = Math.max(1, Math.min(365, daysArg));
        const sinceMs = tokens.last_sync
          ? tokens.last_sync - 24 * 60 * 60 * 1000  // 1 Tag Überlappung
          : Date.now() - days * 24 * 60 * 60 * 1000;

        const parts: string[] = [`🔄 Withings Sync (seit ${new Date(sinceMs).toISOString().slice(0, 10)})...\n`];
        let totalNew = 0;

        // ── Measures (Gewicht, Körperfett, HR) ──
        try {
          const measures = await fetchMeasures(tokens.access_token, sinceMs);
          let mNew = 0;
          for (const m of measures) {
            const dateStr = m.date.toISOString().slice(0, 10);
            if (m.weight_kg != null && !hasEntryForDate('weight', dateStr)) {
              appendEntryWithTimestamp(m.date, { type: 'weight', value: m.weight_kg, unit: 'kg', source: 'withings' });
              mNew++;
            }
            if (m.fat_ratio_pct != null && !hasEntryForDate('body_fat', dateStr)) {
              appendEntryWithTimestamp(m.date, { type: 'body_fat', value: m.fat_ratio_pct, unit: '%', source: 'withings' });
            }
            if (m.hr_bpm != null && !hasEntryForDate('heartrate', dateStr)) {
              appendEntryWithTimestamp(m.date, { type: 'heartrate', hr_avg: m.hr_bpm, source: 'withings' });
            }
          }
          parts.push(`⚖️ Messungen: ${measures.length} (${mNew} neu)`);
          totalNew += mNew;
        } catch (e: any) { parts.push(`⚖️ Messungen: ❌ ${e.message}`); }

        // ── Schlaf (aggregiert pro Nacht, dedup) ──
        try {
          const sleeps = await fetchWithingsSleep(tokens.access_token, sinceMs);
          let sleepNew = 0;
          for (const s of sleeps) {
            if (hasEntryForDate('sleep', s.date)) continue; // skip if already synced
            const ts = new Date(`${s.date}T03:00:00.000Z`);
            appendEntryWithTimestamp(ts, {
              type: 'sleep', value: s.total_h, unit: 'h',
              deep_sleep_h: s.deep_h, rem_sleep_h: s.rem_h, light_sleep_h: s.light_h,
              quality: s.score, source: 'withings',
            });
            sleepNew++;
          }
          parts.push(`😴 Schlaf: ${sleeps.length} Nächte (${sleepNew} neu)`);
          totalNew += sleepNew;
        } catch (e: any) { parts.push(`😴 Schlaf: ❌ ${e.message}`); }

        // ── Aktivität (Schritte) ──
        try {
          const activities = await fetchActivity(tokens.access_token, sinceMs);
          let actNew = 0;
          for (const a of activities) {
            const ts = new Date(`${a.date}T12:00:00.000Z`);
            if (a.steps > 0 && !hasEntryForDate('steps', a.date)) {
              appendEntryWithTimestamp(ts, {
                type: 'steps', steps: a.steps, distance_m: a.distance_m,
                calories: a.calories, source: 'withings',
              });
              actNew++;
            }
            if (a.hr_avg && !hasEntryForDate('heartrate', a.date)) {
              appendEntryWithTimestamp(ts, { type: 'heartrate', hr_avg: a.hr_avg, hr_min: a.hr_min, hr_max: a.hr_max, source: 'withings' });
            }
          }
          const totalSteps = activities.reduce((s, a) => s + a.steps, 0);
          parts.push(`👟 Aktivität: ${activities.length} Tage (${actNew} neu), ${totalSteps.toLocaleString('de')} Schritte gesamt`);
          totalNew += actNew;
        } catch (e: any) { parts.push(`👟 Aktivität: ❌ ${e.message}`); }

        // ── Workouts ──
        try {
          const workouts = await fetchWorkouts(tokens.access_token, sinceMs);
          let wNew = 0;
          for (const w of workouts) {
            if (hasEntryForDate('activity', w.date)) continue;
            const ts = new Date(`${w.date}T12:00:00.000Z`);
            appendEntryWithTimestamp(ts, {
              type: 'activity', activity_type: w.activity_type,
              duration_min: w.duration_min, steps: w.steps,
              distance_m: w.distance_m, calories: w.calories,
              hr_avg: w.hr_avg, source: 'withings',
            });
            wNew++;
          }
          parts.push(`🏃 Workouts: ${workouts.length} (${wNew} neu)`);
          totalNew += wNew;
        } catch (e: any) { parts.push(`🏃 Workouts: ❌ ${e.message}`); }

        // Update last_sync
        saveTokens({ ...tokens, last_sync: Date.now() });

        parts.push(`\n✅ ${totalNew} Einträge importiert.`);
        return { text: parts.join('\n') };
      } catch (e: any) {
        return { text: `❌ /healthsync fehlgeschlagen: ${e.message}` };
      }
    },
  });

  // ── Briefing ───────────────────────────────────────────────────────────────

  async function syncWithingsForBriefing(): Promise<void> {
    if (!withingsClientId || !withingsClientSecret || !isAuthorized()) return;
    try {
      const tokens = await ensureFreshToken(withingsClientId, withingsClientSecret);
      const sinceMs = Date.now() - 36 * 60 * 60 * 1000; // last 36h to catch morning updates

      const measures = await fetchMeasures(tokens.access_token, sinceMs).catch(() => [] as any[]);
      for (const m of measures) {
        const dateStr = m.date.toISOString().slice(0, 10);
        if (m.weight_kg != null && !hasEntryForDate('weight', dateStr))
          appendEntryWithTimestamp(m.date, { type: 'weight', value: m.weight_kg, unit: 'kg', source: 'withings' });
        if (m.fat_ratio_pct != null && !hasEntryForDate('body_fat', dateStr))
          appendEntryWithTimestamp(m.date, { type: 'body_fat', value: m.fat_ratio_pct, unit: '%', source: 'withings' });
        if (m.hr_bpm != null && !hasEntryForDate('heartrate', dateStr))
          appendEntryWithTimestamp(m.date, { type: 'heartrate', hr_avg: m.hr_bpm, source: 'withings' });
      }

      const sleeps = await fetchWithingsSleep(tokens.access_token, sinceMs).catch(() => [] as any[]);
      for (const s of sleeps) {
        if (hasEntryForDate('sleep', s.date)) continue;
        const ts = new Date(`${s.date}T03:00:00.000Z`);
        appendEntryWithTimestamp(ts, {
          type: 'sleep', value: s.total_h, unit: 'h',
          deep_sleep_h: s.deep_h, rem_sleep_h: s.rem_h, light_sleep_h: s.light_h,
          quality: s.score, source: 'withings',
        });
      }

      saveTokens({ ...tokens, last_sync: Date.now() });
    } catch (e: any) {
      api.logger.warn(`[executive-agent] Briefing-PreSync übersprungen: ${e.message}`);
    }
  }

  async function generateBriefingText(): Promise<string> {
    const tz  = 'Europe/Berlin';
    const now = new Date();
    const SEP = '━━━━━━━━━━━━━━━━━━━━';
    const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const fmtDateFull = new Intl.DateTimeFormat('de-DE', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const parts: string[] = [];

    // ── Header: Datum + Uhrzeit + Standort + Astronomie (immer) ──
    const loc = getLocationSettings();
    const astro = getAstroData(now, loc);
    parts.push(`📅 *${fmtDateFull.format(now)} — ${fmtTime.format(now)} Uhr*`);
    parts.push(`📍 ${loc.label}`);
    parts.push(`☀️ Aufgang ${astro.sunrise}  •  Untergang ${astro.sunset}`);
    parts.push(`${astro.moonIcon} ${astro.moonPhase} (${astro.illumination}%)`);

    // ── WETTER (immer) ──
    try {
      const w = await fetchWeatherBriefing(loc.lat, loc.lon);
      parts.push('');
      parts.push(SEP);
      parts.push(`🌤️ *WETTER — ${loc.label}*`);
      parts.push(SEP);
      parts.push(`- Jetzt:   ${w.currentTemp}°C, ${w.currentDesc}`);
      let todayLine = `- Heute:   ${w.todayMin}–${w.todayMax}°C`;
      if (w.todayRainHour !== null) todayLine += `, Regen ab ${String(w.todayRainHour).padStart(2, '0')}:00 🌧️`;
      parts.push(todayLine);
      parts.push(`- Morgen:  ${w.tomorrowMin}–${w.tomorrowMax}°C, ${w.tomorrowDesc}`);
    } catch { /* wetter optional */ }

    // ── INBOX ──
    try {
      const perSource = 10;
      const [mMsgs, yMsgs] = await Promise.all([
        m365Enabled ? m365Unread(perSource) : Promise.resolve([]),
        yahooEnabled ? yahooUnread(perSource) : Promise.resolve([]),
      ]);
      const m365Count = mMsgs.length;
      const yahooCount = yMsgs.length;
      if (m365Count > 0 || yahooCount > 0) {
        const combined = [...mMsgs, ...yMsgs].sort((a, b) => (a.dateIso < b.dateIso ? 1 : -1));
        const newest = combined[0];
        parts.push('');
        parts.push(SEP);
        parts.push('📬 *INBOX*');
        parts.push(SEP);
        if (m365Count > 0) parts.push(`- ${m365Count} ungelesene M365-Mail${m365Count > 1 ? 's' : ''}`);
        if (yahooCount > 0) parts.push(`- ${yahooCount} ungelesene Yahoo-Mail${yahooCount > 1 ? 's' : ''}`);
        if (newest) parts.push(`  → Neueste: "${newest.subject}" — ${newest.from}`);
      }
    } catch { /* inbox optional */ }

    // ── KALENDER (nächste 7 Tage, kompakt) ──
    try {
      ensureM365Configured();
      const rangeStart = new Date(now); rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(rangeStart); rangeEnd.setDate(rangeEnd.getDate() + 7); rangeEnd.setHours(23, 59, 59, 999);

      const calData = await graphGet(tenantId, clientId, m365Secret,
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(m365User)}` +
        `/calendarView?startDateTime=${encodeURIComponent(rangeStart.toISOString())}` +
        `&endDateTime=${encodeURIComponent(rangeEnd.toISOString())}` +
        `&$select=subject,start,end,location&$orderby=start/dateTime&$top=50`);
      const allEvs: any[] = calData?.value || [];

      if (allEvs.length > 0) {
        // Group events by day (Berlin time)
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
    } catch { /* calendar optional */ }

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
      if (lastSleep) {
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
        await syncWithingsForBriefing();
        return { text: await generateBriefingText() };
      } catch (e: any) {
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

  // ── Fuhrpark-Befehle ───────────────────────────────────────────────────────

  function parseDateDE(s: string): string | null {
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!m) return null;
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }

  api.registerCommand({
    name: 'fleet',
    description: 'Alle Fahrzeuge im Fuhrpark anzeigen',
    handler: async () => {
      try {
        // Auto-migrate old hex IDs to readable IDs
        const migrated = migrateHexIds();
        const vehicles = getAllVehicles();
        let text = formatVehicleList(vehicles);
        if (migrated.length > 0) {
          text += '\n\n🔄 IDs migriert:\n' + migrated.map(m => `  ${m.oldId} → ${m.newId}`).join('\n');
        }
        return { text };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'fleetadd',
    acceptsArgs: true,
    description: 'Fahrzeug hinzufügen: /fleetadd <car|bike> <Hersteller> <Modell...> <Baujahr>',
    handler: async (ctx: any) => {
      try {
        const args = String(ctx.args || '').trim().split(/\s+/);
        if (args.length < 4) return { text: '❌ Verwendung: /fleetadd <car|bike> <Hersteller> <Modell...> <Baujahr>' };
        const type = args[0].toLowerCase();
        if (type !== 'car' && type !== 'bike') return { text: '❌ Typ muss "car" oder "bike" sein.' };
        const make = args[1];
        const yearStr = args[args.length - 1];
        const year = parseInt(yearStr, 10);
        if (!/^\d{4}$/.test(yearStr) || year < 1900 || year > 2100) return { text: '❌ Ungültiges Baujahr (4-stellige Zahl erwartet).' };
        const model = args.slice(2, -1).join(' ');
        if (!model) return { text: '❌ Modell fehlt.' };
        const v = createVehicle(type, make, model, year);
        return { text: `✅ Fahrzeug angelegt:\n\n${formatVehicleDetail(v)}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'fleetshow',
    acceptsArgs: true,
    description: 'Fahrzeug-Details anzeigen: /fleetshow <id>',
    handler: async (ctx: any) => {
      try {
        const id = String(ctx.args || '').trim();
        if (!id) return { text: '❌ Verwendung: /fleetshow <id>' };
        const v = getVehicle(id);
        if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };
        let text = formatVehicleDetail(v);
        const links = getLinksForEntity("fleet", id);
        if (links.length) {
          text += `\n\n📎 Verknüpfte Dokumente:\n${formatLinksForTelegram(links)}`;
        }
        return { text };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'fleetedit',
    acceptsArgs: true,
    description: 'Fahrzeug bearbeiten: /fleetedit <id> <feld> <wert>  (name, plate, mileage, tuev, color, vin, id)',
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const parts = raw.split(/\s+/);
        if (parts.length < 3) return { text: '❌ Verwendung: /fleetedit <id> <feld> <wert>' };
        const [id, field, ...rest] = parts;
        const value = rest.join(' ');
        const v = getVehicle(id);
        if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };

        const updates: Record<string, any> = {};
        switch (field.toLowerCase()) {
          case 'name':     updates.name = value; break;
          case 'plate':    updates.plate = value; break;
          case 'mileage':  {
            const km = parseInt(value, 10);
            if (isNaN(km)) return { text: '❌ km-Stand muss eine Zahl sein.' };
            updates.mileage = km;
            break;
          }
          case 'tuev': {
            const iso = parseDateDE(value);
            if (!iso) return { text: '❌ Datum im Format DD.MM.YYYY erwartet.' };
            updates.tuevDate = iso;
            break;
          }
          case 'color':    updates.color = value; break;
          case 'vin':      updates.vin = value; break;
          case 'id': {
            const newId = value.toLowerCase().startsWith('v-') ? value.toLowerCase() : `v-${value.toLowerCase()}`;
            if (!/^v-[a-z0-9]+(-[a-z0-9]+)*$/.test(newId))
              return { text: '❌ ID darf nur Kleinbuchstaben, Zahlen und Bindestriche enthalten.' };
            const result = changeVehicleId(id, newId);
            if (!result) return { text: `❌ ID '${newId}' ist bereits vergeben oder ungültig.` };
            return { text: `✅ ID geändert: ${id} → ${newId}\n\n${formatVehicleDetail(result)}` };
          }
          default: return { text: `❌ Unbekanntes Feld: ${field}\nErlaubt: name, plate, mileage, tuev, color, vin, id` };
        }

        const updated = updateVehicle(id, updates);
        return { text: `✅ Aktualisiert:\n\n${formatVehicleDetail(updated!)}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'fleetdel',
    acceptsArgs: true,
    description: 'Fahrzeug löschen: /fleetdel <id>',
    handler: async (ctx: any) => {
      try {
        const id = String(ctx.args || '').trim();
        if (!id) return { text: '❌ Verwendung: /fleetdel <id>' };
        const v = getVehicle(id);
        if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };
        deleteVehicle(id);
        return { text: `🗑 Fahrzeug **${v.name}** (${v.id}) gelöscht.` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'fleetservice',
    acceptsArgs: true,
    description: 'Service-Eintrag: /fleetservice <id> <typ> [kosten] [notiz]',
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const parts = raw.split(/\s+/);
        if (parts.length < 2) return { text: '❌ Verwendung: /fleetservice <id> <typ> [kosten] [notiz]' };
        const [id, typ, ...rest] = parts;
        const v = getVehicle(id);
        if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };

        let cost: number | undefined;
        let noteParts: string[] = [];
        if (rest.length > 0) {
          const maybeCost = parseFloat(rest[0]);
          if (!isNaN(maybeCost)) {
            cost = maybeCost;
            noteParts = rest.slice(1);
          } else {
            noteParts = rest;
          }
        }

        const entry = {
          date: new Date().toISOString().slice(0, 10),
          type: typ,
          mileage: v.mileage,
          cost,
          notes: noteParts.length ? noteParts.join(' ') : undefined,
        };

        const updated = addServiceEntry(id, entry);
        return { text: `✅ Service-Eintrag hinzugefügt:\n🔧 ${typ}${cost != null ? ` | ${cost} €` : ''}${entry.notes ? ` — ${entry.notes}` : ''}\n\nFahrzeug: ${updated!.name}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'fleetinsurance',
    acceptsArgs: true,
    description: 'Versicherung setzen: /fleetinsurance <id> <anbieter> <typ> [kosten/jahr]',
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const parts = raw.split(/\s+/);
        if (parts.length < 3) return { text: '❌ Verwendung: /fleetinsurance <id> <anbieter> <typ> [kosten/jahr]' };
        const [id, provider, type, ...rest] = parts;
        const v = getVehicle(id);
        if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };

        let annualCost: number | undefined;
        if (rest.length > 0) {
          const c = parseFloat(rest[0]);
          if (!isNaN(c)) annualCost = c;
        }

        const insurance = { provider, type, annualCost };
        const updated = setInsurance(id, insurance);
        return { text: `✅ Versicherung gesetzt:\n🛡 ${provider} (${type})${annualCost != null ? ` | ${annualCost} €/Jahr` : ''}\n\nFahrzeug: ${updated!.name}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'fleettuev',
    acceptsArgs: true,
    description: 'TÜV-Datum setzen: /fleettuev <id> <DD.MM.YYYY>',
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const parts = raw.split(/\s+/);
        if (parts.length < 2) return { text: '❌ Verwendung: /fleettuev <id> <DD.MM.YYYY>' };
        const [id, dateStr] = parts;
        const iso = parseDateDE(dateStr);
        if (!iso) return { text: '❌ Datum im Format DD.MM.YYYY erwartet.' };
        const v = getVehicle(id);
        if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };
        const updated = setTuevDate(id, iso);
        return { text: `✅ TÜV-Datum gesetzt: ${dateStr}\n\nFahrzeug: ${updated!.name}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'fleetdocs',
    acceptsArgs: true,
    description: 'Dokumente eines Fahrzeugs anzeigen: /fleetdocs <id>',
    handler: async (ctx: any) => {
      try {
        const id = String(ctx.args || '').trim();
        if (!id) return { text: '❌ Verwendung: /fleetdocs <id>' };
        const v = getVehicle(id);
        if (!v) return { text: `❌ Fahrzeug nicht gefunden: ${id}` };
        if (!v.documents.length) return { text: `📎 Keine Dokumente für **${v.name}**.` };
        const lines = v.documents.map(d => `   • ${d.label} (${d.filename}) — ${d.uploadedAt.slice(0, 10)}`);
        return { text: `📎 Dokumente für **${v.name}** (${v.documents.length}):\n\n${lines.join('\n')}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
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

  api.registerCommand({
    name: 'healthreportday',
    acceptsArgs: true,
    description: 'Wochentag für Health-Report: /healthreportday <Mo|Di|Mi|Do|Fr|Sa|So>',
    handler: (ctx: any) => {
      const raw = String(ctx.args || '').trim().toLowerCase();
      const dayMap: Record<string, number> = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };
      const dayNum = dayMap[raw];
      if (dayNum === undefined) return { text: '❌ Verwendung: /healthreportday Mo  (Mo|Di|Mi|Do|Fr|Sa|So)' };
      const dayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
      const s = loadSettings();
      s.healthReportDay = dayNum;
      saveSettings(s);
      return { text: `📊 Wöchentlicher Health-Report auf ${dayNames[dayNum]} gesetzt.` };
    },
  });

  // ── Assets: Immobilienverwaltung ────────────────────────────────────────

  // Seed initial data on first load
  try { seedInitialData(); } catch {}

  api.registerCommand({
    name: 'properties',
    description: 'Alle Gebäude Übersicht',
    handler: async () => {
      try {
        const props = listProperties();
        return { text: formatPropertyList(props) };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'property',
    acceptsArgs: true,
    description: 'Gebäude-Details: /property <id>',
    handler: async (ctx: any) => {
      const id = String(ctx.args || '').trim();
      if (!id) return { text: '❌ Verwendung: /property <id>\nBeispiel: /property l19' };
      try {
        const p = getProperty(id);
        if (!p) return { text: `❌ Gebäude "${id}" nicht gefunden.` };
        return { text: formatPropertyDetail(p) };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'propertyrent',
    acceptsArgs: true,
    description: 'Mieteinnahmen Übersicht: /propertyrent <id>',
    handler: async (ctx: any) => {
      const id = String(ctx.args || '').trim();
      if (!id) return { text: '❌ Verwendung: /propertyrent <id>' };
      try {
        const p = getProperty(id);
        if (!p) return { text: `❌ Gebäude "${id}" nicht gefunden.` };
        return { text: formatRentOverview(p) };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'lease',
    acceptsArgs: true,
    description: 'Mietvertrag anzeigen: /lease <unit-id>',
    handler: async (ctx: any) => {
      const unitId = String(ctx.args || '').trim();
      if (!unitId) return { text: '❌ Verwendung: /lease <unit-id>\nBeispiel: /lease l19-w1' };
      try {
        const lease = getLeaseByUnit(unitId);
        if (!lease) return { text: `❌ Kein Mietvertrag für Einheit "${unitId}" gefunden.` };
        const lines = [
          `📄 Mietvertrag ${lease.id}`,
          `Einheit: ${lease.unitId} (${lease.propertyId})`,
          `Mieter: ${lease.tenant}`,
          `Beginn: ${lease.startDate}`,
          `Ende: ${lease.endDate || 'unbefristet'}`,
          `Kaltmiete: ${lease.rentNet.toLocaleString('de-DE')} €`,
          `NK-Vorauszahlung: ${lease.operatingCosts.toLocaleString('de-DE')} €`,
          `Kaution: ${lease.depositAmount.toLocaleString('de-DE')} €`,
        ];
        if (lease.linkedDocs.length) lines.push(`Dokumente: ${lease.linkedDocs.join(', ')}`);
        return { text: lines.join('\n') };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'leaseset',
    acceptsArgs: true,
    description: 'Mietvertrag anlegen/updaten: /leaseset <unit-id> mieter=Name miete=800 nk=200 kaution=2400 beginn=2025-01-01',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 2) return { text: '❌ Verwendung: /leaseset <unit-id> mieter=Name miete=800 nk=200 kaution=2400 beginn=2025-01-01' };

      const unitId = parts[0];
      const fields: Record<string, string> = {};
      for (const p of parts.slice(1)) {
        const eq = p.indexOf('=');
        if (eq > 0) fields[p.slice(0, eq).toLowerCase()] = p.slice(eq + 1);
      }

      // Find property for this unit
      const allProps = listProperties();
      const prop = allProps.find(p => p.units.some(u => u.id === unitId));
      if (!prop) return { text: `❌ Einheit "${unitId}" nicht gefunden.` };

      try {
        const existing = getLeaseByUnit(unitId);
        const lease = setLease(prop.id, unitId, {
          tenant: fields.mieter || existing?.tenant || '',
          startDate: fields.beginn || existing?.startDate || new Date().toISOString().slice(0, 10),
          endDate: fields.ende || existing?.endDate || null,
          rentNet: fields.miete != null ? Number(fields.miete) : (existing?.rentNet || 0),
          operatingCosts: fields.nk != null ? Number(fields.nk) : (existing?.operatingCosts || 0),
          depositAmount: fields.kaution != null ? Number(fields.kaution) : (existing?.depositAmount || 0),
          linkedDocs: existing?.linkedDocs || [],
        });
        return { text: `✅ Mietvertrag ${lease.id} gespeichert.\nMieter: ${lease.tenant} | Miete: ${lease.rentNet} € | NK: ${lease.operatingCosts} €` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'costs',
    acceptsArgs: true,
    description: 'Nebenkosten eingeben: /costs <property-id> <jahr> heizung=1200 wasser=800 ...',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 3) return { text: '❌ Verwendung: /costs <property-id> <jahr> heizung=1200 wasser=800 ...\nKategorien: heizung, wasser, abwasser, muell, hausmeister, versicherung, grundsteuer, allgemeinstrom, aufzug' };

      const propertyId = parts[0];
      const year = Number(parts[1]);
      if (!Number.isFinite(year)) return { text: '❌ Jahr muss eine Zahl sein.' };

      const prop = getProperty(propertyId);
      if (!prop) return { text: `❌ Gebäude "${propertyId}" nicht gefunden.` };

      const validKeys = COST_CATEGORIES.map(c => c.key);
      const costs: Partial<Record<CostCategory, number>> = {};
      const existing = getOperatingCosts(propertyId, year);

      // Start with existing costs
      if (existing) Object.assign(costs, existing.costs);

      for (const p of parts.slice(2)) {
        const eq = p.indexOf('=');
        if (eq <= 0) continue;
        const key = p.slice(0, eq).toLowerCase() as CostCategory;
        if (!validKeys.includes(key)) continue;
        costs[key] = Number(p.slice(eq + 1));
      }

      // Use first distribution key as default
      const dkId = existing?.distributionKeyId || prop.distributionKeys[0]?.id || '';
      if (!dkId) return { text: '❌ Kein Verteilungsschlüssel definiert. Bitte zuerst im Dashboard anlegen.' };

      try {
        const oc = setOperatingCosts(propertyId, year, costs, dkId);
        const total = Object.values(oc.costs).reduce((s, v) => s + (v || 0), 0);
        return { text: `✅ Nebenkosten ${propertyId}/${year} gespeichert.\nGesamt: ${total.toLocaleString('de-DE')} €` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'nebenkostenabrechnung',
    acceptsArgs: true,
    description: 'Abrechnung berechnen: /nebenkostenabrechnung <property-id> <jahr>',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      const parts = raw.split(/\s+/);
      if (parts.length < 2) return { text: '❌ Verwendung: /nebenkostenabrechnung <property-id> <jahr>' };

      const propertyId = parts[0];
      const year = Number(parts[1]);
      if (!Number.isFinite(year)) return { text: '❌ Jahr muss eine Zahl sein.' };

      try {
        const results = calculateNk(propertyId, year);
        if (!results.length) return { text: `❌ Keine abrechnungsrelevanten Einheiten für ${propertyId}/${year}.` };
        return { text: formatNkResult(propertyId, year, results) };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  // ── Mail-Scanner: Buchungsbestätigungen → Trip-Segmente ────────────────

  function formatBookingMessage(booking: ParsedBooking): string {
    const emoji = BOOKING_EMOJI[booking.type] || '📧';
    const lines = [`${emoji} *Buchungsbestätigung erkannt*`];
    lines.push(`${booking.provider} — ${booking.title}`);

    if (booking.startDate) {
      try {
        const start = new Date(booking.startDate);
        const fmtDate = new Intl.DateTimeFormat('de-DE', {
          weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
        }).format(start);
        let dateLine = fmtDate;
        if (booking.endDate) {
          const end = new Date(booking.endDate);
          const fmtEnd = new Intl.DateTimeFormat('de-DE', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
          }).format(end);
          dateLine += ` → ${fmtEnd}`;
        }
        lines.push(dateLine);
      } catch {
        lines.push(booking.startDate);
      }
    }

    if (booking.destination) lines.push(`Ziel: ${booking.destination}`);
    if (booking.confirmationNumber) lines.push(`Bestätigung: ${booking.confirmationNumber}`);

    return lines.join('\n');
  }

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

  // Shortcut: /fleetlink <id> = /link fleet <id>
  api.registerCommand({
    name: 'fleetlink',
    acceptsArgs: true,
    description: 'Fahrzeug-Dokumente anzeigen: /fleetlink <id>',
    handler: async (ctx: any) => {
      const id = String(ctx.args || '').trim();
      if (!id) return { text: '❌ Verwendung: /fleetlink <id>' };
      const links = getLinksForEntity('fleet', id);
      if (!links.length) return { text: `📎 Keine Dokumente verknüpft mit Fahrzeug ${id}.` };
      return { text: `📎 Fahrzeug-Dokumente (${id}):\n\n${formatLinksForTelegram(links)}` };
    },
  });

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

  // Handle numeric replies for pending SP link selections
  api.registerHook('message_received', (event: any) => {
    try {
      const chatId = String(event?.chatId || event?.threadId || event?.conversationId || event?.senderId || '');
      if (!chatId) return;
      const pending = pendingLinkSelections.get(chatId);
      if (!pending || Date.now() > pending.expiresAt) {
        if (pending) pendingLinkSelections.delete(chatId);
        return;
      }

      const text = String(event?.text || '').trim();
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
  }, { name: 'link-selection-handler' });

  // ── Chat-ID aus eingehenden Nachrichten erfassen ───────────────────────────

  api.registerHook('message_received', (event: any) => {
    try {
      // Prefer real chat id; fallback to sender id.
      const id = String(
        event?.chatId ||
        event?.threadId ||
        event?.conversationId ||
        event?.senderId ||
        ''
      ).trim();
      if (!id) return;
      const s = loadSettings();
      if (s.telegramChatId !== id) {
        s.telegramChatId = id;
        saveSettings(s);
        api.logger.info(`[executive-agent] telegramChatId gespeichert: ${id}`);
      }
    } catch {}
  }, { name: 'capture-telegram-chat-id' });

  // ── Standort via Telegram Location Message speichern ──────────────────────

  api.registerHook('message_received', async (event: any) => {
    try {
      const loc = event?.location || event?.raw?.message?.location;
      if (!loc || loc.latitude == null || loc.longitude == null) return;

      const lat = Number(loc.latitude);
      const lon = Number(loc.longitude);
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
  }, { name: 'capture-telegram-location' });

  // ── Booking Callback Handler (Telegram Inline Buttons) ─────────────────────

  async function addBookingAsSegment(tripId: string, booking: ParsedBooking): Promise<string | null> {
    const segmentType = BOOKING_TO_SEGMENT[booking.type];
    const seg = addSegment(tripId, {
      type: segmentType,
      datetime_local: booking.startDate,
      datetime_utc: booking.startDate, // best effort; mail data usually has local time
      timezone: 'Europe/Berlin',
      title: booking.title,
      confirmation: booking.confirmationNumber || undefined,
      notes: `Provider: ${booking.provider}${booking.destination ? ' | Ziel: ' + booking.destination : ''}`,
    });
    if (!seg) return null;
    const newSegId = seg.segments[seg.segments.length - 1].id;
    createSegmentCalendarEvent(tripId, newSegId).catch(e => {
      api.logger.error(`[executive-agent] calendar event for booking segment failed: ${e?.message}`);
    });
    return newSegId;
  }

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
  api.registerHook('message_received', async (event: any) => {
    try {
      const chatId = String(event?.chatId || event?.threadId || event?.conversationId || event?.senderId || '');
      if (!chatId) return;

      const pending = pendingTripSelections.get(chatId);
      if (!pending || Date.now() > pending.expiresAt) {
        if (pending) pendingTripSelections.delete(chatId);
        return;
      }

      const text = String(event?.text || '').trim();
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
  }, { name: 'booking-trip-selection-handler' });

  // Hook to handle callback_query from Telegram (if framework routes them)
  api.registerHook('message_received', async (event: any) => {
    try {
      const cbq = event?.raw?.callback_query;
      if (!cbq) return;

      const callbackQueryId = String(cbq.id || '');
      const chatId = String(cbq.message?.chat?.id || '');
      const data = String(cbq.data || '');

      if (data.startsWith('segdel_')) {
        const sepIdx = data.indexOf('::');
        if (sepIdx === -1) return;
        const delKey = data.slice(0, sepIdx);
        const action = data.slice(sepIdx + 2);
        const pending = pendingSegmentDeletions.get(delKey);
        if (!pending || Date.now() > pending.expiresAt) {
          pendingSegmentDeletions.delete(delKey);
          await answerCallbackQuery(callbackQueryId, 'Abgelaufen.');
          return;
        }
        pendingSegmentDeletions.delete(delKey);
        if (action === 'yes') {
          await answerCallbackQuery(callbackQueryId, 'Wird gelöscht...');
          const ok = await deleteSegmentCalendarEvent(pending.calendarEventId);
          await sendTelegram(chatId, ok
            ? '✅ Kalendereintrag gelöscht.'
            : '❌ Kalendereintrag konnte nicht gelöscht werden.');
        } else {
          await answerCallbackQuery(callbackQueryId, 'Beibehalten');
          await sendTelegram(chatId, '📅 Kalendereintrag beibehalten.');
        }
        return;
      }

      if (!data.startsWith('booking_')) return;
      if (!chatId || !callbackQueryId) return;

      await handleBookingCallback(callbackQueryId, chatId, data);
    } catch (e: any) {
      api.logger.error(`[executive-agent] callback Fehler: ${e?.message}`);
    }
  }, { name: 'booking-callback-handler' });

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

  setInterval(async () => {
    try {
      const s = loadSettings();
      if (!s.telegramChatId) return;

      // Aktuelle Berliner Zeit als HH:MM
      const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
      const hh = String(inBerlin.getHours()).padStart(2, '0');
      const mm = String(inBerlin.getMinutes()).padStart(2, '0');
      const nowHHMM = `${hh}:${mm}`;
      const today   = berlinDate(0);

      if (nowHHMM === s.briefingTime && lastBriefingDate !== today) {
        // Withings-Sync darf fehlschlagen ohne Briefing zu blockieren
        try { await syncWithingsForBriefing(); } catch (syncErr: any) {
          api.logger.warn(`[executive-agent] Briefing Withings-Sync Fehler (ignoriert): ${syncErr.message}`);
        }
        const text = await generateBriefingText();
        await sendTelegram(s.telegramChatId, text);
        // Erst NACH erfolgreichem Senden markieren, damit bei Fehler nächste Minute erneut versucht wird
        lastBriefingDate = today;
        api.logger.info(`[executive-agent] Tägliches Briefing gesendet (${today} ${nowHHMM})`);
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] Briefing-Scheduler Fehler: ${e.message}`);
    }
  }, 60_000);

  // ── Wöchentlicher Health-Report (Standard: Montag 07:00) ─────────────────

  function generateWeeklyHealthReport(): string {
    const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const kwDate = new Date(inBerlin);
    kwDate.setDate(kwDate.getDate() + 3 - ((kwDate.getDay() + 6) % 7));
    const week1 = new Date(kwDate.getFullYear(), 0, 4);
    const kw = 1 + Math.round(((kwDate.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getDay() + 6) % 7)) / 7);

    const parts: string[] = [`📊 Wöchentlicher Health-Report (KW ${kw})\n`];

    // Weight
    const wt7 = getWeightTrend(7);
    const wt30 = getWeightTrend(30);
    parts.push('⚖️ Gewicht:');
    if (wt7) {
      // "Wochenstart" = oldest value in the 7-day window
      const weekStart = wt7.current - wt7.change;
      const sign7 = wt7.change > 0 ? '+' : '';
      parts.push(`   Aktuell: ${wt7.current} kg  |  Wochenstart: ${weekStart.toFixed(1)} kg  |  Veränderung: ${sign7}${wt7.change} kg`);
    } else {
      parts.push('   Keine Daten diese Woche');
    }
    if (wt30) {
      const arrow30 = wt30.direction === 'up' ? '📈' : wt30.direction === 'down' ? '📉' : '➡️';
      const sign30 = wt30.change > 0 ? '+' : '';
      parts.push(`   30-Tage-Trend: ${arrow30} ${sign30}${wt30.change} kg`);
    }

    parts.push('');

    // Sleep
    const st7 = getSleepTrend(7);
    parts.push('😴 Schlaf:');
    if (st7) {
      parts.push(`   Durchschnitt: ${st7.avgDuration}h  |  Min: ${st7.minDuration}h  |  Max: ${st7.maxDuration}h`);
      if (st7.avgQuality) parts.push(`   Qualität: Durchschnitt ${st7.avgQuality}%`);
    } else {
      parts.push('   Keine Daten diese Woche');
    }

    parts.push('');

    // Alerts
    const alerts = checkHealthAlerts();
    if (alerts.length) {
      const alertIcons: Record<string, string> = { critical: '🔴', warning: '⚠️', info: 'ℹ️' };
      parts.push('🚨 Alerts:');
      for (const a of alerts) parts.push(`   ${alertIcons[a.severity] || '•'} ${a.message}`);
    } else {
      parts.push('✅ Alerts: keine aktiven Warnungen');
    }

    return parts.join('\n');
  }

  let lastWeeklyReportDate = '';

  setInterval(async () => {
    try {
      const s = loadSettings();
      if (!s.telegramChatId) return;

      const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
      const hh = String(inBerlin.getHours()).padStart(2, '0');
      const mm = String(inBerlin.getMinutes()).padStart(2, '0');
      const nowHHMM = `${hh}:${mm}`;
      const today = berlinDate(0);
      const reportDay = s.healthReportDay ?? 1; // Default: Montag

      if (inBerlin.getDay() === reportDay && nowHHMM === s.briefingTime && lastWeeklyReportDate !== today) {
        const text = generateWeeklyHealthReport();
        await sendTelegram(s.telegramChatId, text);
        lastWeeklyReportDate = today;
        api.logger.info(`[executive-agent] Wöchentlicher Health-Report gesendet (${today})`);
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] Weekly Health-Report Fehler: ${e.message}`);
    }
  }, 60_000);

  api.logger.info("[executive-agent] loaded v21 (mail-parsing: booking detection)");
}
