import fs from "node:fs";
import { execSync, spawn } from "node:child_process";
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
import { appendEntry, appendEntryWithTimestamp, readEntries, lastEntry, summarize, formatSummary, getWeightTrend, getSleepTrend, checkHealthAlerts, hasEntryForDate, upsertEntryForDate } from "./health-store.js";
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
import {
  getAllInvestments, getInvestment, createInvestment, updateInvestment, deleteInvestment,
  addValuation, getValuationHistory, calculateIRR,
  formatInvestmentList, formatInvestmentDetail,
} from "./pe-store.js";
import type { SpSearchResult } from "./link-store.js";
import {
  loadTokens as loadInstaTokens, saveTokens as saveInstaTokens,
  isAuthorized as instaAuthorized, ensureFreshToken as ensureInstaToken,
  tokenDaysRemaining, tokenExpiringSoon, markTokenFailed as markInstaTokenFailed,
  fetchInsights, fetchMedia, loadInsightsCache, loadMediaCache,
  saveDraft as saveInstaDraft, loadDraft as loadInstaDraft,
  listDrafts as listInstaDrafts, createDraft as createInstaDraft,
  loadCalendar, saveCalendar,
  loadStyleProfile, saveStyleProfile, validateStyleProfile, getStyleProfileSummary,
} from "./instagram-store.js";
import type { InstaDraft, ContentCalendarEntry, StyleProfile } from "./instagram-store.js";
import { openPage, extractText, screenshot, closeBrowser } from "./browser-agent.js";
import {
  saveSubmission, loadSubmission, analyzeImage, analyzeVideo,
  formatAnalysisSummary, getMediaDir, generateSubmissionId, generateDraftId,
  getTopPerformerContext, generateVariants,
} from "./instagram-content-engine.js";
import type { Submission, ContentVariant, VisionAnalysis } from "./instagram-content-engine.js";
import {
  runStartupChecks, formatHealthReport, checkAndRefreshInstagramToken,
  evaluateTokenAlert, safeTelegramSend, formatEscalation,
  preFlightInstagram, preFlightTrading, formatPreFlightFailure,
  runDailyHealthCheck,
} from "./system-health.js";
import type { HealthReport, Escalation } from "./system-health.js";
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

function readOpenAIKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const envPath = path.join(process.env.HOME || '/root', '.config/openclaw/env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === 'OPENAI_API_KEY' && val) return val;
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

interface WeatherDayData {
  min: number;
  max: number;
  desc: string;
  wind: number;       // km/h max
  precip: number;     // mm
  uv: number;
}

interface WeatherBriefing {
  currentTemp: number;
  currentDesc: string;
  todayRainHour: number | null;  // first hour with rain, or null
  days: [WeatherDayData, WeatherDayData, WeatherDayData]; // heute, morgen, übermorgen
  pressureHpa: number;     // current pressure_msl
  pressureTrend: '↑ steigend' | '↓ fallend' | '→ stabil';
  // legacy compat
  todayMin: number; todayMax: number;
  tomorrowMin: number; tomorrowMax: number; tomorrowDesc: string;
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
    `&current=temperature_2m,weather_code,pressure_msl` +
    `&hourly=precipitation,pressure_msl&forecast_hours=24&past_hours=3` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max,precipitation_sum,uv_index_max` +
    `&timezone=Europe%2FBerlin&forecast_days=3`;

  const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
  if (!res.ok) throw new Error(`Open-Meteo Fehler: ${res.status}`);

  const data: any = await res.json();

  const currentTemp = Math.round(data.current?.temperature_2m ?? 0);
  const currentDesc = wmoToText(data.current?.weather_code ?? 0);

  const d = data.daily;
  const days: [WeatherDayData, WeatherDayData, WeatherDayData] = [0, 1, 2].map(i => ({
    min: Math.round(d?.temperature_2m_min?.[i] ?? 0),
    max: Math.round(d?.temperature_2m_max?.[i] ?? 0),
    desc: wmoToText(d?.weather_code?.[i] ?? 0),
    wind: Math.round(d?.wind_speed_10m_max?.[i] ?? 0),
    precip: Math.round((d?.precipitation_sum?.[i] ?? 0) * 10) / 10,
    uv: Math.round(d?.uv_index_max?.[i] ?? 0),
  })) as [WeatherDayData, WeatherDayData, WeatherDayData];

  // Pressure + trend from hourly data (last 3h)
  const pressureHpa = Math.round(data.current?.pressure_msl ?? 0);
  const hourlyPressure: number[] = data.hourly?.pressure_msl ?? [];
  let pressureTrend: WeatherBriefing['pressureTrend'] = '→ stabil';
  if (hourlyPressure.length >= 4) {
    const oldest = hourlyPressure[0];
    const newest = hourlyPressure[hourlyPressure.length - 1];
    const diff = newest - oldest;
    if (diff > 1.5) pressureTrend = '↑ steigend';
    else if (diff < -1.5) pressureTrend = '↓ fallend';
  }

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

  return {
    currentTemp, currentDesc, todayRainHour, days, pressureHpa, pressureTrend,
    // legacy compat
    todayMin: days[0].min, todayMax: days[0].max,
    tomorrowMin: days[1].min, tomorrowMax: days[1].max, tomorrowDesc: days[1].desc,
  };
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
        model: 'claude-sonnet-4-20250514',
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
        model: 'claude-sonnet-4-20250514',
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
    'instaplan', 'instapost', 'instastyle', 'instasubmit', 'instasync',
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
            const newName = `${yymmdd}-${session.id}-${String(fileNum).padStart(2, '0')}${ext}`;
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

            // Send Telegram confirmation directly (bypass AI)
            if (chatId) {
              const msg = saved.length === 1
                ? `📥 ${saved[0]} → Session ${session.id}`
                : `📥 ${saved.length} Dateien → Session ${session.id}`;
              sendTelegram(chatId, msg).catch(err => {
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

  // ── Instagram Module ───────────────────────────────────────────────────────

  const metaAppId        = process.env.META_APP_ID || '';
  const metaAppSecret    = process.env.META_APP_SECRET || '';
  const igBusinessId     = process.env.INSTAGRAM_BUSINESS_ID || '';

  // Bootstrap: Nur wenn kein Token-File existiert → env-Token als Seed schreiben
  // Nicht überschreiben wenn bereits ein gültiger (ggf. refreshter) Token vorliegt
  if (process.env.INSTAGRAM_ACCESS_TOKEN) {
    try {
      const stored = loadInstaTokens();
      if (!stored) {
        // Kein Token gespeichert → Seed aus env
        saveInstaTokens({
          access_token: process.env.INSTAGRAM_ACCESS_TOKEN,
          expires_at: Date.now() + 60 * 24 * 60 * 60 * 1000, // 60 Tage
          refreshed_at: Date.now(),
          ig_business_id: igBusinessId,
          page_id: process.env.META_PAGE_ID || '',
        });
        api.logger.info(`[executive-agent] Instagram: Token aus Env-Variable gespeichert (Initial-Seed)`);
      } else {
        api.logger.info(`[executive-agent] Instagram: Gespeicherter Token vorhanden (${tokenDaysRemaining()} Tage verbleibend) — Env übersprungen`);
      }
    } catch (e: any) {
      api.logger.warn(`[executive-agent] Instagram Bootstrap-Fehler: ${e.message}`);
    }
  }

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
          let sleepNew = 0, sleepUpdated = 0;
          for (const s of sleeps) {
            const ts = new Date(`${s.date}T03:00:00.000Z`);
            const result = upsertEntryForDate(s.date, ts, {
              type: 'sleep', value: s.total_h, unit: 'h',
              deep_sleep_h: s.deep_h, rem_sleep_h: s.rem_h, light_sleep_h: s.light_h,
              quality: s.score, source: 'withings',
            });
            if (result === 'inserted') sleepNew++;
            else if (result === 'updated') sleepUpdated++;
          }
          const sleepParts = [`${sleeps.length} Nächte`];
          if (sleepNew) sleepParts.push(`${sleepNew} neu`);
          if (sleepUpdated) sleepParts.push(`${sleepUpdated} aktualisiert`);
          parts.push(`😴 Schlaf: ${sleepParts.join(', ')}`);
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

  // ── Instagram Commands ──────────────────────────────────────────────────────

  // 4.1 /insta — Account-Überblick
  api.registerCommand({
    name: 'insta',
    description: 'Instagram Account-Überblick: /insta',
    handler: async () => {
      try {
        if (!instaAuthorized()) return { text: '❌ Instagram nicht verbunden. Bitte Tokens in env setzen.' };
        const tokens = await ensureInstaToken(metaAppId, metaAppSecret);
        const insights = await fetchInsights(tokens.access_token, tokens.ig_business_id, false);
        const cacheAge = Math.round((Date.now() - insights.fetched_at) / 60000);
        const daysLeft = tokenDaysRemaining();
        const tokenWarn = daysLeft < 7 ? `\n⚠️ Token läuft in ${daysLeft} Tagen ab!` : '';
        return {
          text: `📸 *Instagram @jurgen_bickel*\n\n` +
            `👥 Follower: ${insights.followers_count.toLocaleString('de')}\n` +
            `📝 Beiträge: ${insights.media_count}\n` +
            `📊 Engagement-Rate: ${insights.engagement_rate}%\n` +
            `❤️ Ø Likes: ${insights.recent_avg_likes}\n` +
            `💬 Ø Kommentare: ${insights.recent_avg_comments}\n` +
            `🕐 Cache: ${cacheAge} min alt\n` +
            `🔑 Token: ${daysLeft} Tage verbleibend${tokenWarn}`,
        };
      } catch (e: any) {
        return { text: `❌ /insta Fehler: ${e.message}` };
      }
    },
  });

  // 4.2 /instatop — Top N Posts
  api.registerCommand({
    name: 'instatop',
    description: 'Top Posts nach Engagement: /instatop [n]',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      try {
        if (!instaAuthorized()) return { text: '❌ Instagram nicht verbunden.' };
        const tokens = await ensureInstaToken(metaAppId, metaAppSecret);
        const n = Math.min(Math.max(parseInt(String(ctx.args || '5')) || 5, 1), 20);
        const media = await fetchMedia(tokens.access_token, tokens.ig_business_id, false);
        const sorted = [...media].sort((a, b) => b.engagement - a.engagement).slice(0, n);
        if (!sorted.length) return { text: '📸 Keine Posts gefunden.' };
        const lines = sorted.map((m, i) => {
          const preview = m.caption.length > 60 ? m.caption.slice(0, 60) + '…' : m.caption;
          return `${i + 1}. ❤️${m.like_count} 💬${m.comments_count} | ${m.media_type}\n   "${preview}"\n   ${m.permalink}`;
        });
        return { text: `📸 *Top ${sorted.length} Posts*\n\n${lines.join('\n\n')}` };
      } catch (e: any) {
        return { text: `❌ /instatop Fehler: ${e.message}` };
      }
    },
  });

  // 4.3 /instatrend — KI Trend-Analyse
  api.registerCommand({
    name: 'instatrend',
    description: 'KI-gestützte Instagram Trend-Analyse: /instatrend',
    handler: async () => {
      try {
        if (!instaAuthorized()) return { text: '❌ Instagram nicht verbunden.' };
        const apiKey = readAnthropicKey();
        if (!apiKey) return { text: '❌ ANTHROPIC_API_KEY nicht gesetzt.' };
        const tokens = await ensureInstaToken(metaAppId, metaAppSecret);
        const insights = await fetchInsights(tokens.access_token, tokens.ig_business_id, false);
        const media = await fetchMedia(tokens.access_token, tokens.ig_business_id, false);
        const top10 = [...media].sort((a, b) => b.engagement - a.engagement).slice(0, 10);
        const last10 = [...media].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 10);

        const prompt = `Du bist ein Social-Media-Marketing-Experte. Analysiere diesen Instagram Business Account.\n\n` +
          `Account: @jurgen_bickel\n` +
          `Follower: ${insights.followers_count}\nBeiträge: ${insights.media_count}\n` +
          `Engagement-Rate: ${insights.engagement_rate}%\nØ Likes: ${insights.recent_avg_likes}\nØ Kommentare: ${insights.recent_avg_comments}\n\n` +
          `TOP 10 Posts (nach Engagement):\n${top10.map(m => `- ${m.media_type} | ❤️${m.like_count} 💬${m.comments_count} | "${m.caption.slice(0, 80)}"`).join('\n')}\n\n` +
          `LETZTE 10 Posts:\n${last10.map(m => `- ${m.timestamp.slice(0, 10)} | ${m.media_type} | ❤️${m.like_count} 💬${m.comments_count} | "${m.caption.slice(0, 80)}"`).join('\n')}\n\n` +
          `Bitte analysiere auf Deutsch:\n1. Welche Inhalte/Themen performen am besten?\n2. Optimale Posting-Zeiten (aus Timestamps ableiten)\n3. Content-Typ-Empfehlung (Reels vs. Karussell vs. Single)\n4. 3 konkrete Verbesserungsvorschläge\n5. Hashtag-Strategie-Empfehlung\n\nKurz und prägnant, max 500 Wörter.`;

        const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
          }),
        }, 30000);

        if (!res.ok) {
          const err = await res.text().catch(() => '');
          throw new Error(`Anthropic API ${res.status}: ${err.slice(0, 200)}`);
        }
        const data: any = await res.json();
        const analysis = data.content?.[0]?.text || 'Keine Antwort erhalten.';
        return { text: `📊 *Instagram Trend-Analyse*\n\n${analysis}` };
      } catch (e: any) {
        return { text: `❌ /instatrend Fehler: ${e.message}` };
      }
    },
  });

  // 4.4 /instaplan — KI Content-Kalender
  api.registerCommand({
    name: 'instaplan',
    description: 'KI-generierter 2-Wochen Content-Kalender: /instaplan',
    handler: async () => {
      try {
        if (!instaAuthorized()) return { text: '❌ Instagram nicht verbunden.' };
        const apiKey = readAnthropicKey();
        if (!apiKey) return { text: '❌ ANTHROPIC_API_KEY nicht gesetzt.' };
        const tokens = await ensureInstaToken(metaAppId, metaAppSecret);
        const insights = await fetchInsights(tokens.access_token, tokens.ig_business_id, false);
        const media = await fetchMedia(tokens.access_token, tokens.ig_business_id, false);
        const top5 = [...media].sort((a, b) => b.engagement - a.engagement).slice(0, 5);

        const today = new Date().toISOString().slice(0, 10);
        const prompt = `Du bist ein Social-Media-Planer für den Instagram Business Account @jurgen_bickel.\n\n` +
          `Account-Daten:\nFollower: ${insights.followers_count}\nEngagement-Rate: ${insights.engagement_rate}%\n\n` +
          `Top 5 Posts:\n${top5.map(m => `- ${m.media_type} | ❤️${m.like_count} 💬${m.comments_count} | "${m.caption.slice(0, 80)}"`).join('\n')}\n\n` +
          `Erstelle einen 2-Wochen Content-Kalender ab ${today}. Antworte NUR mit einem JSON-Array (keine Erklärung):\n` +
          `[{"nr":1,"date":"YYYY-MM-DD","topic":"...","format":"Reel|Karussell|Single Post|Story","caption_idea":"...","hashtags":["tag1","tag2"],"notes":"..."}]\n\n` +
          `Regeln:\n- 3-4 Posts pro Woche\n- Mischung aus Formaten\n- Hashtags relevant und auf Deutsch/Englisch gemischt\n- Caption-Ideen konkret und umsetzbar`;

        const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
          }),
        }, 30000);

        if (!res.ok) {
          const err = await res.text().catch(() => '');
          throw new Error(`Anthropic API ${res.status}: ${err.slice(0, 200)}`);
        }
        const data: any = await res.json();
        const raw = data.content?.[0]?.text || '';

        // Parse JSON from response (may be wrapped in markdown code block)
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (!jsonMatch) return { text: '❌ KI-Antwort konnte nicht als Kalender geparst werden.' };

        const entries: ContentCalendarEntry[] = JSON.parse(jsonMatch[0]);
        const calendar = { generated_at: new Date().toISOString(), entries };
        saveCalendar(calendar);

        const lines = entries.map((e: ContentCalendarEntry) =>
          `${e.nr}. 📅 ${e.date} | ${e.format}\n   ${e.topic}\n   💡 "${e.caption_idea.slice(0, 60)}…"`
        );
        return {
          text: `📅 *Content-Kalender* (${entries.length} Einträge)\n\n${lines.join('\n\n')}\n\n` +
            `→ /instadraft <nr> um einen Draft zu erstellen`,
        };
      } catch (e: any) {
        return { text: `❌ /instaplan Fehler: ${e.message}` };
      }
    },
  });

  // 4.5 /instadraft — Draft aus Plan oder Freitext
  api.registerCommand({
    name: 'instadraft',
    description: 'Instagram Draft erstellen: /instadraft <plan-nr | freitext>',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      try {
        // Guard: block when /instasubmit is actively processing
        // Check 1: per-sender guard (direct match)
        const draftSenderId = String(ctx.senderId || ctx.from || '').replace(/^telegram:/, '');
        if (draftSenderId && instaSubmitActive.has(draftSenderId)) {
          return { text: '⏳ Foto/Video wird via /instasubmit analysiert — kein Draft erstellt.' };
        }
        // Check 2: global timestamp guard (catches AI agent with different senderId)
        if (Date.now() - instaSubmitLastActivatedAt < 120_000) {
          api.logger.warn(`[executive-agent] /instadraft blocked by global instasubmit guard (sender: ${draftSenderId})`);
          return { text: '⏳ /instasubmit ist aktiv — /instadraft blockiert.' };
        }

        const input = String(ctx.args || '').trim();
        if (!input) return { text: '❌ Nutzung: /instadraft <plan-nr> oder /instadraft <freitext>' };

        const planNr = parseInt(input);
        if (!isNaN(planNr)) {
          // Draft aus Content-Kalender
          const cal = loadCalendar();
          if (!cal) return { text: '❌ Kein Content-Kalender vorhanden. Zuerst /instaplan ausführen.' };
          const entry = cal.entries.find((e: ContentCalendarEntry) => e.nr === planNr);
          if (!entry) return { text: `❌ Plan-Nr. ${planNr} nicht gefunden (${cal.entries.length} Einträge vorhanden).` };

          // KI generiert vollständige Caption
          const apiKey = readAnthropicKey();
          if (!apiKey) return { text: '❌ ANTHROPIC_API_KEY nicht gesetzt.' };

          const prompt = `Du bist ein Instagram Content Creator für @jurgen_bickel.\n\n` +
            `Erstelle eine vollständige Instagram-Caption für folgenden Plan:\n` +
            `Thema: ${entry.topic}\nFormat: ${entry.format}\nIdee: ${entry.caption_idea}\n` +
            `Hashtags: ${entry.hashtags.join(', ')}\nNotizen: ${entry.notes || 'keine'}\n\n` +
            `Regeln:\n- Ansprechend und authentisch\n- Passende Emojis\n- Call-to-Action am Ende\n- KEINE Hashtags im Text (die werden separat gehandhabt)\n- Max 2000 Zeichen\n\nAntworte NUR mit der Caption, keine Erklärung.`;

          const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 512,
              messages: [{ role: 'user', content: prompt }],
            }),
          }, 30000);

          if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`Anthropic API ${res.status}: ${err.slice(0, 200)}`);
          }
          const data: any = await res.json();
          const caption = data.content?.[0]?.text || entry.caption_idea;

          const draft = createInstaDraft({
            caption,
            hashtags: entry.hashtags,
            scheduledFor: entry.date,
            planNr: entry.nr,
            notes: `Aus Content-Kalender #${entry.nr}: ${entry.topic}`,
          });

          return {
            text: `✅ *Draft erstellt*\n\n` +
              `🆔 ${draft.id}\n📅 Geplant: ${entry.date}\n📝 Format: ${entry.format}\n\n` +
              `Caption:\n${caption.slice(0, 300)}${caption.length > 300 ? '…' : ''}\n\n` +
              `#️⃣ ${entry.hashtags.map((h: string) => '#' + h).join(' ')}\n\n` +
              `→ /instaedit ${draft.id} zum Bearbeiten`,
          };
        } else {
          // Freitext-Draft
          const draft = createInstaDraft({ caption: input });
          return {
            text: `✅ *Draft erstellt*\n\n🆔 ${draft.id}\n📝 "${input.slice(0, 100)}${input.length > 100 ? '…' : ''}"\n\n` +
              `→ /instaedit ${draft.id} zum Bearbeiten`,
          };
        }
      } catch (e: any) {
        return { text: `❌ /instadraft Fehler: ${e.message}` };
      }
    },
  });

  // 4.6 /instadrafts — Liste aller Drafts
  api.registerCommand({
    name: 'instadrafts',
    description: 'Instagram Drafts auflisten: /instadrafts',
    handler: async () => {
      try {
        const drafts = listInstaDrafts();
        if (!drafts.length) return { text: '📝 Keine Instagram-Drafts vorhanden.' };
        const icons: Record<string, string> = { entwurf: '📝', freigegeben: '✅' };
        const lines = drafts.map(d => {
          const icon = icons[d.status] || '📝';
          const preview = d.caption.length > 50 ? d.caption.slice(0, 50) + '…' : d.caption;
          const sched = d.scheduledFor ? ` | 📅 ${d.scheduledFor}` : '';
          return `${icon} ${d.id}\n   "${preview}"${sched}`;
        });
        return { text: `📸 *Instagram Drafts* (${drafts.length})\n\n${lines.join('\n\n')}` };
      } catch (e: any) {
        return { text: `❌ /instadrafts Fehler: ${e.message}` };
      }
    },
  });

  // 4.7 /instaedit — Draft bearbeiten
  api.registerCommand({
    name: 'instaedit',
    description: 'Instagram Draft anzeigen/bearbeiten: /instaedit <id> [key=value]',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      try {
        const parts = String(ctx.args || '').trim().split(/\s+/);
        const id = parts[0];
        if (!id) return { text: '❌ Nutzung: /instaedit <id> [caption=...|status=...|hashtags=...]' };

        const draft = loadInstaDraft(id);
        if (!draft) return { text: `❌ Draft "${id}" nicht gefunden.` };

        // Ohne weitere Parameter: Draft anzeigen
        if (parts.length === 1) {
          return {
            text: `📸 *Draft: ${draft.id}*\n\n` +
              `Status: ${draft.status}\n` +
              `Erstellt: ${draft.createdAt.slice(0, 16).replace('T', ' ')}\n` +
              `Aktualisiert: ${draft.updatedAt.slice(0, 16).replace('T', ' ')}\n` +
              (draft.scheduledFor ? `Geplant: ${draft.scheduledFor}\n` : '') +
              (draft.planNr ? `Plan-Nr: ${draft.planNr}\n` : '') +
              `\n📝 Caption:\n${draft.caption}\n\n` +
              `#️⃣ ${draft.hashtags.map(h => '#' + h).join(' ') || '(keine)'}` +
              (draft.notes ? `\n\n📌 ${draft.notes}` : ''),
          };
        }

        // Parameter parsen und anwenden
        const updates: string[] = [];
        for (let i = 1; i < parts.length; i++) {
          const [key, ...rest] = parts[i].split('=');
          const val = rest.join('=');
          switch (key) {
            case 'caption':
              draft.caption = val;
              updates.push('Caption aktualisiert');
              break;
            case 'status':
              if (val === 'entwurf' || val === 'freigegeben') {
                draft.status = val;
                updates.push(`Status → ${val}`);
              } else {
                return { text: '❌ Status muss "entwurf" oder "freigegeben" sein.' };
              }
              break;
            case 'hashtags':
              draft.hashtags = val.split(',').map(h => h.trim().replace(/^#/, ''));
              updates.push(`Hashtags → ${draft.hashtags.length} Tags`);
              break;
            default:
              return { text: `❌ Unbekannter Key "${key}". Erlaubt: caption, status, hashtags` };
          }
        }
        saveInstaDraft(draft);
        return { text: `✅ Draft ${id} aktualisiert:\n${updates.join('\n')}` };
      } catch (e: any) {
        return { text: `❌ /instaedit Fehler: ${e.message}` };
      }
    },
  });

  // 4.8 /instasync — Cache + Token Refresh
  api.registerCommand({
    name: 'instasync',
    description: 'Instagram Cache + Token forciert erneuern: /instasync',
    handler: async () => {
      try {
        if (!instaAuthorized()) return { text: '❌ Instagram nicht verbunden.' };
        const tokens = await ensureInstaToken(metaAppId, metaAppSecret);
        const insights = await fetchInsights(tokens.access_token, tokens.ig_business_id, true);
        await fetchMedia(tokens.access_token, tokens.ig_business_id, true);
        const daysLeft = tokenDaysRemaining();
        return {
          text: `🔄 *Instagram Sync abgeschlossen*\n\n` +
            `🔑 Token: ${daysLeft} Tage verbleibend\n` +
            `👥 Follower: ${insights.followers_count.toLocaleString('de')}\n` +
            `📝 Beiträge: ${insights.media_count}\n` +
            `📊 Engagement: ${insights.engagement_rate}%`,
        };
      } catch (e: any) {
        return { text: `❌ /instasync Fehler: ${e.message}` };
      }
    },
  });

  // 4.8b /instatokentest — Manual token refresh test
  api.registerCommand({
    name: 'instatokentest',
    description: 'Instagram Token-Refresh testen: /instatokentest',
    requireAuth: true,
    handler: async () => {
      try {
        if (!metaAppId || !metaAppSecret) {
          return { text: '❌ META_APP_ID oder META_APP_SECRET nicht konfiguriert.' };
        }
        const tokensBefore = loadInstaTokens();
        if (!tokensBefore) return { text: '❌ Kein Instagram-Token vorhanden.' };

        const tokenPreview = tokensBefore.access_token.slice(0, 20) + '...';
        const daysBefore = tokenDaysRemaining();

        // Force refresh
        let refreshedTokens;
        try {
          refreshedTokens = await ensureInstaToken(metaAppId, metaAppSecret, true);
        } catch (e: any) {
          return {
            text: `❌ Token-Refresh fehlgeschlagen!\n\n` +
              `Token (vorher): ${tokenPreview}\n` +
              `Tage verbleibend: ${daysBefore}\n\n` +
              `Fehler: ${e.message}`,
          };
        }

        const newPreview = refreshedTokens.access_token.slice(0, 20) + '...';
        const daysAfter = tokenDaysRemaining();
        const expiresAt = new Date(refreshedTokens.expires_at).toISOString().slice(0, 16).replace('T', ' ');
        const tokenChanged = tokensBefore.access_token !== refreshedTokens.access_token;

        // Live validation via /me
        let liveStatus = '⏳ nicht geprüft';
        try {
          const liveRes = await fetch(
            `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(refreshedTokens.access_token)}`,
            { signal: AbortSignal.timeout(10_000) }
          );
          if (liveRes.ok) {
            const liveData = await liveRes.json() as { id: string; name?: string };
            liveStatus = `✅ Gültig (ID: ${liveData.id})`;
          } else {
            const errBody = await liveRes.text().catch(() => '');
            liveStatus = `❌ Ungültig: ${errBody.slice(0, 120)}`;
          }
        } catch (e: any) {
          liveStatus = `⚠️ Prüfung fehlgeschlagen: ${e.message}`;
        }

        return {
          text: `🔑 Token-Refresh Test\n\n` +
            `Token vorher: ${tokenPreview}\n` +
            `Token nachher: ${newPreview}\n` +
            `Token geändert: ${tokenChanged ? 'Ja ✅' : 'Nein (identisch)'}\n` +
            `Gültig bis: ${expiresAt} UTC\n` +
            `Tage verbleibend: ${daysAfter}\n\n` +
            `Live-Validierung: ${liveStatus}`,
        };
      } catch (e: any) {
        return { text: `❌ /instatokentest Fehler: ${e.message}` };
      }
    },
  });

  // 4.9 /instapost — Phase 2 (deaktiviert)
  api.registerCommand({
    name: 'instapost',
    description: 'Instagram Post veröffentlichen (Phase 2): /instapost',
    handler: async () => {
      return {
        text: '🚧 *Auto-Posting (Phase 2) noch nicht aktiv*\n\n' +
          'Drafts können aktuell über /instadrafts eingesehen und manuell gepostet werden.\n' +
          'Phase 2 wird Container-basiertes Publishing mit Bild-Upload unterstützen.',
      };
    },
  });

  // 4.10 /instavariants — Varianten generieren aus Submission
  api.registerCommand({
    name: 'instavariants',
    description: 'Varianten generieren: /instavariants <submission-id>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      api.logger.info(`[executive-agent] [instavariants] Handler aufgerufen mit args: ${String(ctx.args || '<keine>')}`);
      const senderId = String(ctx.senderId || ctx.from || '').replace(/^telegram:/, '');
      const chatId = senderId;
      try {
        const id = String(ctx.args || '').trim();
        if (!id) return { text: '❌ Nutzung: /instavariants <submission-id>\nBeispiel: /instavariants sub-bvcw-0605' };

        // Pre-flight check
        const pf = await preFlightInstagram(id);
        if (!pf.ok) return { text: formatPreFlightFailure(pf.failures) };

        let submission: Submission;
        try {
          submission = await loadSubmission(id);
        } catch {
          return { text: `❌ Submission nicht gefunden: ${id}` };
        }

        if (submission.status !== 'analyzed' && submission.status !== 'generated') {
          return { text: `❌ Submission ${id} hat Status "${submission.status}" — Analyse muss zuerst abgeschlossen sein.` };
        }

        // If already generated, show existing variants
        if (submission.status === 'generated' && submission.variants && submission.variants.length > 0) {
          return { text: formatVariantsOutput(id, submission.variants) };
        }

        // Generate variants (Pass 2 + Pass 3)
        if (chatId) {
          sendTelegram(chatId, `⏳ Generiere Varianten fuer ${id}...`).catch((err) => {
            api.logger.error(`[executive-agent] /instavariants: Telegram-Bestätigung fehlgeschlagen: ${err?.message}`);
          });
        }

        api.logger.info(`[executive-agent] /instavariants: Starte Varianten-Generierung fuer ${id}`);
        const variants = await generateVariants(submission);
        api.logger.info(`[executive-agent] /instavariants: ${variants.length} Varianten generiert fuer ${id}`);

        const output = formatVariantsOutput(id, variants);
        // Return text only — gateway sends it to Telegram. No extra sendTelegram() to avoid double message.
        return { text: output };
      } catch (e: any) {
        api.logger.error(`[executive-agent] /instavariants Fehler: ${e.message}`);
        if (chatId) {
          sendTelegram(chatId, `❌ Varianten-Generierung fehlgeschlagen: ${e.message}`).catch(() => {});
        }
        return { text: `❌ /instavariants Fehler: ${e.message}` };
      }
    },
  });

  // 4.11 /instaapprove — Variante auswählen + Draft anlegen
  api.registerCommand({
    name: 'instaapprove',
    description: 'Variante genehmigen: /instaapprove <submission-id> <1|2|3>',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      api.logger.info(`[executive-agent] [instaapprove] Handler aufgerufen mit args: ${String(ctx.args || '<keine>')}`);
      try {
        const args = String(ctx.args || '').trim().split(/\s+/);
        const id = args[0];
        const variantNr = parseInt(args[1]);

        if (!id || isNaN(variantNr)) {
          return { text: '❌ Nutzung: /instaapprove <submission-id> <1|2|3>\nBeispiel: /instaapprove sub-bvcw-0605 2' };
        }

        // Pre-flight check
        const pf = await preFlightInstagram(id);
        if (!pf.ok) return { text: formatPreFlightFailure(pf.failures) };

        let submission: Submission;
        try {
          submission = await loadSubmission(id);
        } catch {
          return { text: `❌ Submission nicht gefunden: ${id}` };
        }

        if (!submission.variants || submission.variants.length === 0) {
          return { text: `❌ Submission ${id} hat keine Varianten. Zuerst /instavariants ${id} ausfuehren.` };
        }

        const idx = variantNr - 1;
        if (idx < 0 || idx >= submission.variants.length) {
          return { text: `❌ Variante ${variantNr} ungueltig. Verfuegbar: 1-${submission.variants.length}` };
        }

        const chosen = submission.variants[idx];

        // Update submission
        submission.selected_variant = idx;
        submission.status = 'approved';
        await saveSubmission(submission);

        // Create draft from chosen variant
        const draft = createInstaDraft({
          caption: chosen.caption,
          hashtags: chosen.hashtags,
          notes: `Aus Submission ${id}, Variante ${variantNr} (${chosen.type})`,
        });

        api.logger.info(`[executive-agent] /instaapprove: Variante ${variantNr} (${chosen.type}) gewaehlt fuer ${id} → Draft ${draft.id}`);

        return {
          text: `✅ Variante ${variantNr} (${chosen.type}) uebernommen\n\n` +
            `Submission: ${id} → Status: approved\n` +
            `Draft: ${draft.id}\n\n` +
            `Caption:\n${chosen.caption.slice(0, 300)}${chosen.caption.length > 300 ? '…' : ''}\n\n` +
            `Tags: ${chosen.hashtags.map(h => '#' + h).join(' ')}\n\n` +
            `→ /instaedit ${draft.id} zum Bearbeiten`,
        };
      } catch (e: any) {
        return { text: `❌ /instaapprove Fehler: ${e.message}` };
      }
    },
  });

  // Helper: Format variants for Telegram output
  function formatVariantsOutput(submissionId: string, variants: ContentVariant[]): string {
    const lines: string[] = [];
    lines.push(`✅ ${variants.length} Varianten fuer ${submissionId}`);
    lines.push('');

    const typeLabels: Record<string, string> = { story: 'Story', insight: 'Insight', hook: 'Hook' };
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const label = typeLabels[v.type] || v.type;
      lines.push(`── Variante ${i + 1}: ${label} ──`);
      if (v.hook) lines.push(`Hook: ${v.hook}`);
      lines.push(v.caption);
      lines.push(`Tags: ${v.hashtags.join(', ')}`);
      lines.push('');
    }

    lines.push(`Antwort: /instaapprove ${submissionId} <1|2|3>`);
    return lines.join('\n');
  }

  // 4.12 /instastyle — Style-Profil v2
  api.registerCommand({
    name: 'instastyle',
    description: 'Style-Profil: /instastyle | reload | pillar <id> | dos | donts | export | edit',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const arg = raw.toLowerCase();

        // /instastyle reload — reload from disk + validate
        if (arg === 'reload') {
          const profile = loadStyleProfile();
          const error = validateStyleProfile(profile);
          if (error) {
            return { text: `Validierung fehlgeschlagen: ${error}` };
          }
          return { text: `Style-Profil v${profile.version} geladen und validiert.\n${profile.pillars.length} Pillars | ${profile.dos.length} Dos | ${profile.donts.length} Donts | ${profile.formats.length} Formate` };
        }

        // /instastyle pillar <id>
        if (arg.startsWith('pillar ')) {
          const pillarId = arg.slice(7).trim();
          const profile = loadStyleProfile();
          const pillar = profile.pillars.find(p => p.id === pillarId);
          if (!pillar) {
            const ids = profile.pillars.map(p => p.id).join(', ');
            return { text: `Pillar "${pillarId}" nicht gefunden.\nVerfuegbar: ${ids}` };
          }
          const lines: string[] = [];
          lines.push(`Pillar: ${pillar.name} (${pillar.id})`);
          lines.push('');
          lines.push(pillar.description);
          lines.push('');
          lines.push('Good Examples:');
          for (const ex of pillar.good_examples) lines.push(`  + ${ex}`);
          lines.push('');
          lines.push('Bad Examples:');
          for (const ex of pillar.bad_examples) lines.push(`  - ${ex}`);
          lines.push('');
          lines.push('Content Ideas:');
          for (const ci of pillar.content_ideas) lines.push(`  ${ci.format}: ${ci.idea}`);
          lines.push('');
          lines.push('Example Caption:');
          lines.push(pillar.example_caption);
          return { text: lines.join('\n') };
        }

        // /instastyle dos
        if (arg === 'dos') {
          const profile = loadStyleProfile();
          const lines: string[] = [];
          lines.push(`Dos (${profile.dos.length})`);
          lines.push('');
          for (const d of profile.dos) {
            lines.push(`${d.id}. ${d.title}`);
            lines.push(`   ${d.rule}`);
            lines.push('');
          }
          return { text: lines.join('\n') };
        }

        // /instastyle donts
        if (arg === 'donts') {
          const profile = loadStyleProfile();
          const lines: string[] = [];
          lines.push(`Donts (${profile.donts.length})`);
          lines.push('');
          for (const d of profile.donts) {
            lines.push(`${d.id}. ${d.title}`);
            lines.push(`   Stattdessen: ${d.alternative}`);
            lines.push('');
          }
          return { text: lines.join('\n') };
        }

        // /instastyle export — send JSON file via Telegram
        if (arg === 'export') {
          const chatId = String(ctx.chatId || ctx.chat?.id || ctx.threadId || ctx.conversationId || ctx.senderId || '');
          if (!chatId || !telegramBotToken) {
            return { text: 'Export nur via Telegram moeglich (Chat-ID oder Bot-Token fehlt).' };
          }
          const profilePath = path.join(
            process.env.HOME || '/root',
            '.openclaw/workspace/artifacts/personal/instagram/style-profile.json',
          );
          if (!fs.existsSync(profilePath)) {
            return { text: 'style-profile.json nicht gefunden.' };
          }
          try {
            const fileData = fs.readFileSync(profilePath);
            const blob = new Blob([fileData], { type: 'application/json' });
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('document', blob, 'style-profile.json');
            form.append('caption', 'Style-Profil v2 (JSON)');
            const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendDocument`, {
              method: 'POST',
              body: form,
            });
            if (res.ok) {
              return { text: 'Style-Profil als Datei gesendet.' };
            }
            const body = await res.text().catch(() => '');
            return { text: `Export fehlgeschlagen: ${res.status} ${body.slice(0, 100)}` };
          } catch (e: any) {
            return { text: `Export Fehler: ${e.message}` };
          }
        }

        // /instastyle edit — hint to use file editor
        if (arg === 'edit') {
          return {
            text: 'Style-Profil bearbeiten:\n\nEdit via VS Code Remote SSH unter\nartifacts/personal/instagram/style-profile.json\n\nDanach: /instastyle reload',
          };
        }

        // /instastyle set — deactivated
        if (arg.startsWith('set')) {
          return {
            text: 'Inline-Edit deaktiviert. Pflege erfolgt per Datei-Edit.\n\nSiehe: /instastyle edit',
          };
        }

        // /instastyle — overview
        return { text: getStyleProfileSummary() };
      } catch (e: any) {
        return { text: `/instastyle Fehler: ${e.message}` };
      }
    },
  });

  // 4.13 /instaforensic — Follower-Spike Forensik
  api.registerCommand({
    name: 'instaforensic',
    description: 'Follower-Forensik: /instaforensic',
    requireAuth: true,
    handler: async (ctx: any) => {
      const senderId = String(ctx.senderId || ctx.from || '').replace(/^telegram:/, '');
      const chatId = senderId;

      const scriptPath = path.join(__dirname, '..', 'scripts', 'instagram-spike-forensic.ts');
      if (!fs.existsSync(scriptPath)) {
        return { text: '❌ Script nicht gefunden: scripts/instagram-spike-forensic.ts' };
      }

      // Run script async — it sends the report via Telegram itself
      const child = spawn('bun', ['run', scriptPath], {
        cwd: path.join(__dirname, '..'),
        stdio: 'ignore',
        detached: true,
        env: { ...process.env },
      });

      child.on('error', (err) => {
        api.logger.error(`[executive-agent] instaforensic spawn Fehler: ${err.message}`);
        sendTelegram(chatId, `❌ Forensik fehlgeschlagen: ${err.message}`).catch(() => {});
      });

      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          api.logger.error(`[executive-agent] instaforensic Exit-Code: ${code}`);
          sendTelegram(chatId, '❌ Forensik fehlgeschlagen — siehe journalctl').catch(() => {});
        }
      });

      child.unref();

      return { text: '🔍 Follower-Forensik läuft... (ca. 30s)' };
    },
  });

  // ── /instasubmit — Photo/Video submission + Pass 1 Vision Analysis ───────
  //
  // Architecture note (2026-05-06):
  // The gateway's message_received hook only provides {from, content, timestamp, metadata}.
  // There is NO event.raw.message — photo/video data is NOT available in hooks.
  // The gateway downloads media to ~/.openclaw/media/inbound/ BEFORE dispatching.
  // Strategy: /instasubmit command handler finds the most recent inbound media file
  // and processes it directly. A guard on /instadraft prevents the AI agent from
  // creating a duplicate draft while instasubmit is active.

  const GATEWAY_MEDIA_DIR = path.join(process.env.HOME || '/root', '.openclaw/media/inbound');

  // ── Raw Material Inbox ──────────────────────────────────────────────────
  const RAW_DIR = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal/instagram/raw');

  interface CutSegment {
    source: string;      // Dateiname in original/
    start_s: number;
    end_s: number;
  }

  interface CutPlan {
    output_file: string;
    segments: CutSegment[];
    transitions?: 'none' | 'fade';
  }

  type InstaFormat = 'reel' | 'feed-video' | 'feed-photo';

  interface CutResult {
    output_path: string;
    duration_s: number;
    format: InstaFormat | 'raw';
    file_size: number;
    segments_used: number;
  }

  interface VideoProbe {
    duration_s: number;
    width: number;
    height: number;
    codec: string;
    fps: number;
    has_audio: boolean;
  }

  interface FileAnalysis {
    fileName: string;
    type: 'image' | 'video';
    analysis: VisionAnalysis;
    duration_s?: number;
    probe?: VideoProbe;
  }

  interface ContentProposal {
    id: string;                    // "A", "B", "C"
    format: InstaFormat;
    title: string;
    rationale: string;
    pillar_match: string[];
    cut_plan?: CutPlan;           // nur bei Video-Vorschlägen
    source_files: string[];
    estimated_duration_s?: number;
  }

  interface ScanResult {
    scanned_at: string;
    file_analyses: FileAnalysis[];
    proposals: ContentProposal[];
    selected_proposal?: string;
  }

  interface CraftDialogState {
    sessionId: string;
    direction: string;
    currentPlan?: ContentProposal;
    fileAnalyses?: FileAnalysis[];
    step: 'awaiting_direction' | 'generating' | 'plan_ready' | 'adjusting' | 'executing';
    expiresAt: number;
  }

  interface RawSessionFile { name: string; size: number; type: 'image' | 'video' | 'document'; addedAt: string }
  interface RawSession {
    id: string;
    created_at: string;
    mode: 'upload';
    status: 'active' | 'closed' | 'scanning' | 'scanned' | 'crafting' | 'cutting' | 'cut_done';
    files: RawSessionFile[];
    cut_plan?: CutPlan;
    cut_result?: CutResult;
    scan_result?: ScanResult;
  }

  const activeRawSessions = new Map<string, string>(); // senderId → sessionId

  function generateRawSessionId(context?: string): string {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    let base = 'raw';
    if (context) {
      const slug = context.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 12);
      if (slug) base = `raw-${slug}`;
    }
    const candidate = `${base}-${dd}${mm}`;
    // Duplicate check
    if (!fs.existsSync(path.join(RAW_DIR, candidate))) return candidate;
    for (let i = 2; i <= 20; i++) {
      const alt = `${candidate}-${i}`;
      if (!fs.existsSync(path.join(RAW_DIR, alt))) return alt;
    }
    return `${candidate}-${Date.now().toString(36).slice(-4)}`;
  }

  function sessionDir(id: string): string { return path.join(RAW_DIR, id); }
  function sessionJsonPath(id: string): string { return path.join(RAW_DIR, id, 'session.json'); }

  function createRawSession(id: string): RawSession {
    const dir = sessionDir(id);
    fs.mkdirSync(path.join(dir, 'original'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'processed'), { recursive: true });
    const session: RawSession = { id, created_at: new Date().toISOString(), mode: 'upload', status: 'active', files: [] };
    fs.writeFileSync(sessionJsonPath(id), JSON.stringify(session, null, 2));
    return session;
  }

  function loadRawSession(id: string): RawSession | null {
    try { return JSON.parse(fs.readFileSync(sessionJsonPath(id), 'utf-8')); } catch { return null; }
  }

  function saveRawSession(session: RawSession): void {
    fs.writeFileSync(sessionJsonPath(session.id), JSON.stringify(session, null, 2));
  }

  function listRawSessions(): RawSession[] {
    if (!fs.existsSync(RAW_DIR)) return [];
    return fs.readdirSync(RAW_DIR)
      .map(name => loadRawSession(name))
      .filter((s): s is RawSession => s !== null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  function deleteRawSession(id: string): boolean {
    const dir = sessionDir(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    // Cleanup active session references
    for (const [sender, sid] of activeRawSessions) {
      if (sid === id) activeRawSessions.delete(sender);
    }
    return true;
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function detectMediaType(filename: string): 'image' | 'video' | 'document' | null {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'video';
    if (['pdf', 'doc', 'docx', 'txt', 'zip'].includes(ext)) return 'document';
    return null;
  }

  /** Find the most recent inbound file (image/video/document) in the gateway's inbound media dir (max 60s old). */
  function findRecentInboundFile(): { path: string; name: string; type: 'image' | 'video' | 'document' } | null {
    if (!fs.existsSync(GATEWAY_MEDIA_DIR)) return null;
    const now = Date.now();
    const files = fs.readdirSync(GATEWAY_MEDIA_DIR)
      .map(name => {
        const fullPath = path.join(GATEWAY_MEDIA_DIR, name);
        try {
          const stat = fs.statSync(fullPath);
          return { name, path: fullPath, mtime: stat.mtimeMs, size: stat.size };
        } catch { return null; }
      })
      .filter((f): f is { name: string; path: string; mtime: number; size: number } =>
        f !== null && (now - f.mtime) < 60_000
      )
      .sort((a, b) => b.mtime - a.mtime);

    for (const f of files) {
      const mediaType = detectMediaType(f.name);
      if (mediaType) return { path: f.path, name: f.name, type: mediaType };
    }
    return null;
  }

  // Active instasubmit sessions — guards /instadraft from firing concurrently
  const instaSubmitActive = new Set<string>();

  // Global timestamp guard: blocks /instadraft for ALL senders when ANY /instasubmit is active.
  // This catches the case where the AI agent calls /instadraft with a different senderId.
  let instaSubmitLastActivatedAt = 0;

  // Concurrency guard: prevents parallel /instascan runs per chatId
  const instaScanActive = new Set<string>();

  // Active /instacraft guided dialog states per senderId
  const activeCraftDialogs = new Map<string, CraftDialogState>();

  // Track pending /instasubmit states (user sends command first, then media)
  const pendingInstaSubmits = new Map<string, { expiresAt: number; note: string }>();

  /** Find the most recent image or video in the gateway's inbound media dir (max 60s old). */
  function findRecentInboundMedia(): { path: string; type: 'image' | 'video' } | null {
    if (!fs.existsSync(GATEWAY_MEDIA_DIR)) {
      api.logger.warn(`[executive-agent] instasubmit: GATEWAY_MEDIA_DIR nicht vorhanden: ${GATEWAY_MEDIA_DIR}`);
      return null;
    }
    const now = Date.now();
    const allFiles = fs.readdirSync(GATEWAY_MEDIA_DIR);
    const files = allFiles
      .map(name => {
        const fullPath = path.join(GATEWAY_MEDIA_DIR, name);
        try {
          const stat = fs.statSync(fullPath);
          return { name, path: fullPath, mtime: stat.mtimeMs, ageMs: now - stat.mtimeMs };
        } catch { return null; }
      })
      .filter((f): f is { name: string; path: string; mtime: number; ageMs: number } =>
        f !== null && (now - f.mtime) < 60_000  // max 60 seconds old (was 30s — too tight)
      )
      .sort((a, b) => b.mtime - a.mtime);

    api.logger.info(`[executive-agent] instasubmit: findRecentInboundMedia — ${allFiles.length} Dateien total, ${files.length} < 60s alt`);

    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() || '';
      if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
        api.logger.info(`[executive-agent] instasubmit: Media gefunden: ${f.name} (${Math.round(f.ageMs / 1000)}s alt)`);
        return { path: f.path, type: 'image' };
      }
      if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) {
        api.logger.info(`[executive-agent] instasubmit: Media gefunden: ${f.name} (${Math.round(f.ageMs / 1000)}s alt)`);
        return { path: f.path, type: 'video' };
      }
    }
    if (files.length > 0) {
      api.logger.warn(`[executive-agent] instasubmit: ${files.length} neue Dateien aber keine Bild/Video-Extension: ${files.map(f => f.name).join(', ')}`);
    }
    return null;
  }

  /** Find the most recent audio file in the gateway's inbound media dir (max 60s old). */
  function findRecentAudioFile(): { path: string; name: string } | null {
    if (!fs.existsSync(GATEWAY_MEDIA_DIR)) return null;
    const now = Date.now();
    const AUDIO_EXTS = ['ogg', 'oga', 'mp3', 'wav', 'opus', 'm4a'];
    const files = fs.readdirSync(GATEWAY_MEDIA_DIR)
      .map(name => {
        const fullPath = path.join(GATEWAY_MEDIA_DIR, name);
        try {
          const stat = fs.statSync(fullPath);
          return { name, path: fullPath, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter((f): f is { name: string; path: string; mtime: number } =>
        f !== null && (now - f.mtime) < 60_000
      )
      .sort((a, b) => b.mtime - a.mtime);

    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() || '';
      if (AUDIO_EXTS.includes(ext)) {
        api.logger.info(`[executive-agent] findRecentAudioFile: ${f.name} (${Math.round((now - f.mtime) / 1000)}s alt)`);
        return { path: f.path, name: f.name };
      }
    }
    return null;
  }

  /** Read OpenAI OAuth token from gateway auth.json */
  function readOpenAIOAuthToken(): string {
    try {
      const authPath = path.join(process.env.HOME || '/root', '.openclaw/agents/main/agent/auth.json');
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      const codex = auth['openai-codex'];
      if (codex?.access && codex.expires > Date.now()) return codex.access;
    } catch {}
    return '';
  }

  /** Read GROQ_API_KEY from env file */
  function readGroqKey(): string {
    if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
    try {
      const envPath = path.join(process.env.HOME || '/root', '.config/openclaw/env');
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (line.startsWith('#') || !line.includes('=')) continue;
        const eq = line.indexOf('=');
        if (line.slice(0, eq).trim() === 'GROQ_API_KEY') return line.slice(eq + 1).trim();
      }
    } catch {}
    return '';
  }

  /**
   * Transcribe audio via Whisper. Tries backends in order:
   * 1. Local faster-whisper (no API key, fast on CPU)
   * 2. Groq (free tier) if GROQ_API_KEY is set
   * 3. OpenAI OAuth token (from gateway auth)
   * 4. OPENAI_API_KEY from env
   */
  async function transcribeVoice(audioPath: string): Promise<string> {
    // 1. Try local faster-whisper (preferred — no API key, fast, private)
    try {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'transcribe.py');
      if (fs.existsSync(scriptPath)) {
        const result = execSync(
          `python3 "${scriptPath}" "${audioPath}" de`,
          { timeout: 60_000, stdio: 'pipe' }
        ).toString().trim();
        const parsed = JSON.parse(result);
        if (parsed.text) {
          api.logger.info(`[executive-agent] transcribeVoice: local whisper erfolgreich (${parsed.text.length} Zeichen)`);
          return parsed.text;
        }
        if (parsed.error) {
          api.logger.warn(`[executive-agent] transcribeVoice: local whisper Fehler: ${parsed.error}`);
        }
      }
    } catch (e: any) {
      api.logger.warn(`[executive-agent] transcribeVoice: local whisper fehlgeschlagen: ${e.message?.slice(0, 200)}`);
    }

    // 2–4. Cloud backends (need API conversion to MP3)
    const ext = audioPath.split('.').pop()?.toLowerCase() || '';
    let inputPath = audioPath;
    let tempMp3 = '';

    if (['ogg', 'oga', 'opus'].includes(ext)) {
      tempMp3 = audioPath.replace(/\.[^.]+$/, '_whisper.mp3');
      try {
        execSync(
          `ffmpeg -y -i "${audioPath}" -acodec libmp3lame -ar 16000 -ac 1 "${tempMp3}"`,
          { timeout: 15_000, stdio: 'pipe' }
        );
        inputPath = tempMp3;
      } catch (e: any) {
        throw new Error(`ffmpeg Konvertierung fehlgeschlagen: ${e.message}`);
      }
    }

    try {
      const audioData = fs.readFileSync(inputPath);
      const fileName = path.basename(inputPath);

      const backends: { name: string; url: string; token: string; model: string }[] = [];

      const groqKey = readGroqKey();
      if (groqKey) {
        backends.push({
          name: 'Groq',
          url: 'https://api.groq.com/openai/v1/audio/transcriptions',
          token: groqKey,
          model: 'whisper-large-v3-turbo',
        });
      }

      const oauthToken = readOpenAIOAuthToken();
      if (oauthToken) {
        backends.push({
          name: 'OpenAI-OAuth',
          url: 'https://api.openai.com/v1/audio/transcriptions',
          token: oauthToken,
          model: 'whisper-1',
        });
      }

      const openaiKey = readOpenAIKey();
      if (openaiKey && openaiKey.length > 10) {
        backends.push({
          name: 'OpenAI-Key',
          url: 'https://api.openai.com/v1/audio/transcriptions',
          token: openaiKey,
          model: 'whisper-1',
        });
      }

      if (backends.length === 0) {
        throw new Error('Kein Whisper-Backend verfügbar (local whisper fehlgeschlagen, keine Cloud-Keys).');
      }

      const errors: string[] = [];
      for (const backend of backends) {
        try {
          const blob = new Blob([audioData], { type: 'audio/mpeg' });
          const formData = new FormData();
          formData.append('file', blob, fileName);
          formData.append('model', backend.model);
          formData.append('language', 'de');

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30_000);
          try {
            const res = await fetch(backend.url, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${backend.token}` },
              body: formData,
              signal: controller.signal,
            });
            clearTimeout(timeout);
            if (res.ok) {
              const json = await res.json() as { text: string };
              api.logger.info(`[executive-agent] transcribeVoice: ${backend.name} erfolgreich`);
              return json.text;
            }
            const errBody = await res.text().catch(() => '');
            errors.push(`${backend.name}: ${res.status} ${errBody.slice(0, 200)}`);
          } finally {
            clearTimeout(timeout);
          }
        } catch (e: any) {
          errors.push(`${backend.name}: ${e.message}`);
        }
      }

      throw new Error(`Alle Whisper-Backends fehlgeschlagen:\n${errors.join('\n')}`);
    } finally {
      if (tempMp3) {
        try { fs.unlinkSync(tempMp3); } catch {}
      }
    }
  }

  /** Run Vision Analysis pipeline on a media file. Sends results/errors via Telegram. */
  async function runInstaSubmitPipeline(
    chatId: string, userNote: string, mediaFile: { path: string; type: 'image' | 'video' },
  ): Promise<void> {
    const submissionId = generateSubmissionId(userNote);
    const mediaType = mediaFile.type;
    api.logger.info(`[executive-agent] instasubmit pipeline START: id=${submissionId} type=${mediaType} source=${mediaFile.path} chatId=${chatId}`);

    // Copy media to submission directory
    let localPath: string;
    try {
      const mediaDir = getMediaDir(submissionId);
      const ext = mediaType === 'image' ? '.jpg' : '.mp4';
      localPath = path.join(mediaDir, `${submissionId}${ext}`);
      fs.copyFileSync(mediaFile.path, localPath);
      api.logger.info(`[executive-agent] instasubmit: ${mediaType} kopiert → ${localPath} (${fs.statSync(localPath).size} bytes)`);
    } catch (cpErr: any) {
      api.logger.error(`[executive-agent] instasubmit: Medien-Kopie fehlgeschlagen: ${cpErr.message}`);
      await sendTelegram(chatId, `❌ Medien-Kopie fehlgeschlagen: ${cpErr.message}`);
      return;
    }

    // Create submission
    const submission: Submission = {
      id: submissionId,
      media: [{
        type: mediaType,
        path: localPath,
        mimeType: mediaType === 'image' ? 'image/jpeg' : 'video/mp4',
      }],
      context: { user_note: userNote },
      status: 'received',
      created: new Date().toISOString(),
    };
    await saveSubmission(submission);
    api.logger.info(`[executive-agent] instasubmit: Submission gespeichert: ${submissionId}`);

    // Pass 1: Vision Analysis
    try {
      api.logger.info(`[executive-agent] instasubmit: Vision-Analyse gestartet (${mediaType})...`);
      let analysis;
      if (mediaType === 'image') {
        analysis = await analyzeImage(localPath);
      } else {
        analysis = await analyzeVideo(localPath);
      }
      api.logger.info(`[executive-agent] instasubmit: Vision-Analyse erfolgreich — subjects=${analysis.subjects?.join(',')}`);

      submission.analysis = analysis;
      submission.status = 'analyzed';
      await saveSubmission(submission);

      const summary = formatAnalysisSummary(analysis, mediaType);
      await sendTelegram(
        chatId,
        `✅ Analyse abgeschlossen\n\n${summary}\n\nSubmission-ID: ${submissionId}\n\nNaechste Schritte: /instavariants ${submissionId} (kommt in Schritt 2)`,
      );
      api.logger.info(`[executive-agent] instasubmit pipeline DONE: ${submissionId}`);
    } catch (analysisErr: any) {
      api.logger.error(`[executive-agent] instasubmit Vision-Fehler: ${analysisErr.message}\n${analysisErr.stack || ''}`);
      await sendTelegram(
        chatId,
        `❌ Vision-Analyse fehlgeschlagen: ${analysisErr.message}\n\nSubmission-ID: ${submissionId} (Status: received)\nBitte erneut versuchen mit /instasubmit`,
      );
    }
  }

  api.registerCommand({
    name: 'instasubmit',
    description: 'Instagram Content einreichen: Foto/Video mit Caption /instasubmit <kontext>',
    requireAuth: true,
    acceptsArgs: true,
    handler: async (ctx: any) => {
      const note = String(ctx.args || '').trim();
      // ctx per SDK: senderId, from, channelId — no chatId
      const senderId = String(ctx.senderId || ctx.from || '').replace(/^telegram:/, '');
      const chatId = senderId;

      api.logger.info(`[executive-agent] /instasubmit HANDLER: senderId=${senderId} chatId=${chatId} note="${note}" ctx.keys=${Object.keys(ctx).join(',')}`);

      // Pre-flight check (no submission ID yet for instasubmit)
      const pf = await preFlightInstagram();
      if (!pf.ok) return { text: formatPreFlightFailure(pf.failures) };

      if (!chatId) {
        api.logger.error(`[executive-agent] /instasubmit: chatId ist leer! ctx.senderId=${ctx.senderId} ctx.from=${ctx.from}`);
        return { text: '❌ Interner Fehler: Absender nicht erkannt. Bitte erneut versuchen.' };
      }

      // Mark active — blocks /instadraft for this sender AND globally
      instaSubmitLastActivatedAt = Date.now();
      instaSubmitActive.add(senderId);
      setTimeout(() => instaSubmitActive.delete(senderId), 120_000);

      // Check if note references a raw session (e.g. "raw-0905" or "raw-strand-0509")
      const rawSessionMatch = note.match(/\b(raw-[a-z0-9-]+)\b/i);
      if (rawSessionMatch) {
        const refSessionId = rawSessionMatch[1].toLowerCase();
        const refSession = loadRawSession(refSessionId);
        if (refSession) {
          const sessionMediaFiles = refSession.files
            .filter(f => f.type === 'image' || f.type === 'video')
            .map(f => ({
              path: path.join(sessionDir(refSessionId), 'original', f.name),
              type: f.type as 'image' | 'video',
              name: f.name,
            }))
            .filter(f => fs.existsSync(f.path));

          if (sessionMediaFiles.length > 0) {
            api.logger.info(`[executive-agent] /instasubmit: Raw-Session "${refSessionId}" referenziert — ${sessionMediaFiles.length} Dateien`);
            // Use first media file for submission pipeline
            const firstMedia = sessionMediaFiles[0];
            sendTelegram(chatId, `📥 Session ${refSessionId}: ${sessionMediaFiles.length} Datei(en) gefunden. Analyse laeuft...`).catch(() => {});

            // Run pipeline for each media file sequentially
            (async () => {
              try {
                for (const mf of sessionMediaFiles) {
                  await runInstaSubmitPipeline(chatId, note, { path: mf.path, type: mf.type });
                }
              } catch (err: any) {
                api.logger.error(`[executive-agent] /instasubmit session-pipeline CRASH: ${err?.message}\n${err?.stack || ''}`);
                sendTelegram(chatId, `❌ Pipeline-Fehler: ${err?.message}`).catch(() => {});
              } finally {
                instaSubmitActive.delete(senderId);
              }
            })();

            return {
              text: `📥 Session ${refSessionId}: ${sessionMediaFiles.length} Medien-Datei(en) — Vision-Analyse gestartet. Ergebnisse folgen per Telegram.`,
            };
          } else {
            api.logger.warn(`[executive-agent] /instasubmit: Raw-Session "${refSessionId}" hat keine Medien`);
          }
        }
      }

      // Try to find recent inbound media (gateway already downloaded it)
      const media = findRecentInboundMedia();
      if (media) {
        // Photo/video was sent WITH the /instasubmit caption — process immediately
        api.logger.info(`[executive-agent] /instasubmit: Media gefunden, starte Pipeline async`);
        sendTelegram(chatId, '📥 Empfangen. Analyse laeuft...').catch((err) => {
          api.logger.error(`[executive-agent] /instasubmit: Telegram-Bestätigung fehlgeschlagen: ${err?.message}`);
        });
        // Run pipeline async — MUST have .catch() to prevent unhandled rejection
        runInstaSubmitPipeline(chatId, note, media)
          .catch((err) => {
            api.logger.error(`[executive-agent] /instasubmit pipeline CRASH: ${err?.message}\n${err?.stack || ''}`);
            sendTelegram(chatId, `❌ Pipeline-Fehler: ${err?.message}\nBitte erneut versuchen.`).catch(() => {});
          })
          .finally(() => {
            instaSubmitActive.delete(senderId);
          });
        return {
          text: '📥 Foto/Video erkannt — Vision-Analyse gestartet. Ergebnis folgt per Telegram.',
        };
      }

      // No media found — user sends /instasubmit first, then media separately
      api.logger.info(`[executive-agent] /instasubmit: Kein Media gefunden, warte auf Follow-up`);
      pendingInstaSubmits.set(senderId, {
        expiresAt: Date.now() + 5 * 60 * 1000,
        note,
      });
      return {
        text: '📷 Kein Foto/Video gefunden — sende jetzt ein Foto oder Video.\n\nTipp: Foto direkt mit Caption /instasubmit <text> senden fuer sofortige Analyse.\nOder: /instasubmit raw-<session-id> für Session-basierte Analyse.',
      };
    },
  });

  // ── /instaraw — Raw Material Session Management ────────────────────────
  api.registerCommand({
    name: 'instaraw',
    description: 'Raw Material Sessions verwalten: /instaraw [new|del|close]',
    requireAuth: true,
    acceptsArgs: true,
    handler: async (ctx: any) => {
      const args = String(ctx.args || '').trim();
      const parts = args.split(/\s+/);
      const subCmd = parts[0]?.toLowerCase() || '';

      // /instaraw new [kontext]
      if (subCmd === 'new') {
        const context = parts.slice(1).join(' ') || undefined;
        const senderId = String(ctx.senderId || ctx.from || '').replace(/^telegram:/, '');
        const id = generateRawSessionId(context);
        createRawSession(id);
        if (senderId) activeRawSessions.set(senderId, id);
        return { text: `✅ Neue Raw-Session erstellt: ${id}\n\nSende jetzt Fotos/Videos — sie werden automatisch in dieser Session gespeichert.` };
      }

      // /instaraw del <id>
      if (subCmd === 'del' || subCmd === 'delete') {
        const id = parts[1];
        if (!id) return { text: '❌ Bitte Session-ID angeben: /instaraw del <id>' };
        const deleted = deleteRawSession(id);
        if (!deleted) return { text: `❌ Session "${id}" nicht gefunden.` };
        return { text: `🗑️ Session "${id}" und alle Dateien gelöscht.` };
      }

      // /instaraw close
      if (subCmd === 'close') {
        const senderId = String(ctx.senderId || ctx.from || '').replace(/^telegram:/, '');
        const sessionId = activeRawSessions.get(senderId);
        if (!sessionId) return { text: '❌ Keine aktive Session.' };
        const session = loadRawSession(sessionId);
        if (session) {
          session.status = 'closed';
          saveRawSession(session);
        }
        activeRawSessions.delete(senderId);
        return { text: `✅ Session "${sessionId}" geschlossen.` };
      }

      // /instaraw — list all sessions
      const sessions = listRawSessions();
      if (sessions.length === 0) return { text: '📁 Keine Raw-Sessions vorhanden.\n\nErstelle eine neue: /instaraw new [kontext]' };

      const activeSids = new Set(activeRawSessions.values());
      const lines = sessions.map(s => {
        const fileCount = s.files.length;
        const totalSize = s.files.reduce((sum, f) => sum + f.size, 0);
        const activeTag = activeSids.has(s.id) ? ' ← aktiv' : '';
        return `📁 ${s.id} [${s.status}]${activeTag}\n   ${fileCount} Datei(en), ${formatFileSize(totalSize)}\n   Erstellt: ${s.created_at.slice(0, 16).replace('T', ' ')}`;
      });
      return { text: `📁 Raw-Sessions:\n\n${lines.join('\n\n')}` };
    },
  });

  // ── /instascan — Proactive Scan Engine ──────────────────────────────────
  api.registerCommand({
    name: 'instascan',
    description: 'Proaktiver Scan: /instascan [session-id]',
    requireAuth: true,
    acceptsArgs: true,
    handler: async (ctx: any) => {
      const args = String(ctx.args || '').trim();
      const senderId = String(ctx.senderId || ctx.from || '').replace(/^telegram:/, '');
      const chatId = senderId;

      if (!args) {
        // List all scannable sessions
        const sessions = listRawSessions().filter(s =>
          (s.status === 'active' || s.status === 'closed' || s.status === 'scanned') && s.files.some(f => f.type === 'image' || f.type === 'video')
        );
        if (sessions.length === 0) {
          return { text: '📁 Keine scanbaren Sessions vorhanden.\n\nErstelle eine Session: /instaraw new [kontext]\nDann sende Fotos/Videos.' };
        }
        const lines = sessions.map(s => {
          const mediaFiles = s.files.filter(f => f.type === 'image' || f.type === 'video');
          const scanTag = s.status === 'scanned' ? ' ✅ gescannt' : '';
          return `📁 ${s.id} [${s.status}]${scanTag}\n   ${mediaFiles.length} Medien-Datei(en)`;
        });
        return { text: `📁 Scanbare Sessions:\n\n${lines.join('\n\n')}\n\n→ /instascan <session-id>` };
      }

      const sessionId = args;

      // Concurrency guard
      if (instaScanActive.has(chatId)) {
        return { text: '⏳ Ein Scan läuft bereits. Bitte warten.' };
      }

      const session = loadRawSession(sessionId);
      if (!session) {
        return { text: `❌ Session "${sessionId}" nicht gefunden.\n\n→ /instaraw für alle Sessions` };
      }

      // If already scanned with results — show proposals again without re-scanning
      if (session.status === 'scanned' && session.scan_result?.proposals?.length) {
        const msg = formatProposalMessage(sessionId, session.scan_result.proposals);
        const keyboard = buildProposalKeyboard(sessionId, session.scan_result.proposals);
        await sendTelegramWithKeyboard(chatId, msg, keyboard);
        return { text: `📋 Vorschläge für ${sessionId} erneut angezeigt.` };
      }

      // Check for media files
      const mediaFiles = session.files.filter(f => f.type === 'image' || f.type === 'video');
      if (mediaFiles.length === 0) {
        return { text: `❌ Session "${sessionId}" hat keine Medien-Dateien.\n\nSende Fotos/Videos in die Session.` };
      }

      // Start scan pipeline async
      instaScanActive.add(chatId);
      runInstascanPipeline(sessionId, chatId).catch(err => {
        api.logger.error(`[executive-agent] instascan pipeline CRASH: ${err?.message}\n${err?.stack || ''}`);
        sendTelegram(chatId, `❌ Scan-Pipeline abgestürzt: ${err?.message}`).catch(() => {});
        instaScanActive.delete(chatId);
      });

      return { text: `🔍 Scan gestartet für Session ${sessionId} (${mediaFiles.length} Datei(en)).\nFortschritt folgt per Telegram.` };
    },
  });

  // ── /instacraft — Guided Content Dialog ──────────────────────────────────
  api.registerCommand({
    name: 'instacraft',
    description: 'Guided Content: /instacraft <session-id> [richtung]',
    requireAuth: true,
    acceptsArgs: true,
    handler: async (ctx: any) => {
      const args = String(ctx.args || '').trim();
      const senderId = String(ctx.senderId || ctx.from || '').replace(/^telegram:/, '');
      const chatId = senderId;

      // /instacraft cancel — abort active dialog
      if (args === 'cancel') {
        const state = activeCraftDialogs.get(chatId);
        if (!state) return { text: 'Kein aktiver Craft-Dialog vorhanden.' };
        activeCraftDialogs.delete(chatId);
        const freshSession = loadRawSession(state.sessionId);
        if (freshSession && freshSession.status === 'crafting') {
          freshSession.status = freshSession.scan_result ? 'scanned' : 'active';
          saveRawSession(freshSession);
        }
        return { text: '❌ Craft-Dialog abgebrochen.' };
      }

      // No args — list craftable sessions
      if (!args) {
        const sessions = listRawSessions().filter(s =>
          (s.status === 'active' || s.status === 'closed' || s.status === 'scanned') &&
          s.files.some(f => f.type === 'image' || f.type === 'video')
        );
        if (sessions.length === 0) {
          return { text: '📁 Keine craftbaren Sessions vorhanden.\n\nErstelle eine Session: /instaraw new [kontext]\nDann sende Fotos/Videos.' };
        }
        const lines = sessions.map(s => {
          const mediaFiles = s.files.filter(f => f.type === 'image' || f.type === 'video');
          const scanTag = s.status === 'scanned' ? ' ✅ gescannt' : '';
          return `📁 ${s.id} [${s.status}]${scanTag}\n   ${mediaFiles.length} Medien-Datei(en)`;
        });
        return { text: `🎨 Craftbare Sessions:\n\n${lines.join('\n\n')}\n\n→ /instacraft <session-id> [kreative Richtung]` };
      }

      // Parse: first word = session-id, rest = direction
      const spaceIdx = args.indexOf(' ');
      const sessionId = spaceIdx > 0 ? args.slice(0, spaceIdx) : args;
      const direction = spaceIdx > 0 ? args.slice(spaceIdx + 1).trim() : '';

      // Guard: active dialog already running
      const existing = activeCraftDialogs.get(chatId);
      if (existing && Date.now() < existing.expiresAt) {
        return { text: `⏳ Craft-Dialog bereits aktiv (Session: ${existing.sessionId}, Step: ${existing.step}).\n\n→ /instacraft cancel zum Abbrechen` };
      }

      const session = loadRawSession(sessionId);
      if (!session) {
        return { text: `❌ Session "${sessionId}" nicht gefunden.\n\n→ /instaraw für alle Sessions` };
      }

      if (session.status === 'crafting') {
        return { text: `❌ Session "${sessionId}" wird bereits bearbeitet.` };
      }

      const mediaFiles = session.files.filter(f => f.type === 'image' || f.type === 'video');
      if (mediaFiles.length === 0) {
        return { text: `❌ Session "${sessionId}" hat keine Medien-Dateien.\n\nSende Fotos/Videos in die Session.` };
      }

      // Set session status to crafting
      session.status = 'crafting';
      saveRawSession(session);

      const CRAFT_DIALOG_TTL = 30 * 60_000; // 30 minutes

      if (direction) {
        // Direction inline — start generation immediately
        const state: CraftDialogState = {
          sessionId,
          direction,
          step: 'generating',
          expiresAt: Date.now() + CRAFT_DIALOG_TTL,
        };
        activeCraftDialogs.set(chatId, state);

        runCraftPlanGeneration(chatId, sessionId, direction).catch(err => {
          api.logger.error(`[executive-agent] craft pipeline CRASH: ${err?.message}\n${err?.stack || ''}`);
          sendTelegram(chatId, `❌ Craft-Pipeline abgestürzt: ${err?.message}`).catch(() => {});
          activeCraftDialogs.delete(chatId);
        });

        return { text: `🎨 Craft gestartet für ${sessionId}: "${direction}"\nFortschritt folgt per Telegram.` };
      } else {
        // No direction — prompt user
        const state: CraftDialogState = {
          sessionId,
          direction: '',
          step: 'awaiting_direction',
          expiresAt: Date.now() + CRAFT_DIALOG_TTL,
        };
        activeCraftDialogs.set(chatId, state);

        return { text: `🎨 Craft-Dialog gestartet für ${sessionId}\n\nSende deine kreative Richtung (Text oder Sprachnachricht):` };
      }
    },
  });

  // Hook: craft dialog — text input handler
  api.on('message_received', async (event: any) => {
    try {
      const content: string = event?.content ?? '';
      if (!content || content.startsWith('/') || content.includes('<media:')) return;

      const senderId = String(event?.metadata?.senderId || '');
      if (!senderId) return;

      const state = activeCraftDialogs.get(senderId);
      if (!state || Date.now() > state.expiresAt) return;
      if (state.step !== 'awaiting_direction' && state.step !== 'adjusting') return;

      const chatId = senderId;

      if (state.step === 'awaiting_direction') {
        state.direction = content;
        state.step = 'generating';
        runCraftPlanGeneration(chatId, state.sessionId, content).catch(err => {
          api.logger.error(`[executive-agent] craft text-handler CRASH: ${err?.message}`);
          sendTelegram(chatId, `❌ Craft-Plan fehlgeschlagen: ${err?.message}`).catch(() => {});
          activeCraftDialogs.delete(chatId);
        });
      } else if (state.step === 'adjusting') {
        state.step = 'generating';
        runCraftPlanGeneration(chatId, state.sessionId, state.direction, state.currentPlan, content).catch(err => {
          api.logger.error(`[executive-agent] craft adjustment CRASH: ${err?.message}`);
          sendTelegram(chatId, `❌ Craft-Anpassung fehlgeschlagen: ${err?.message}`).catch(() => {});
          activeCraftDialogs.delete(chatId);
        });
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] craft-text-handler Fehler: ${e?.message}`);
    }
  });

  // Hook: craft dialog — voice input handler
  api.on('message_received', async (event: any) => {
    try {
      const content: string = event?.content ?? '';
      if (!content.includes('<media:audio>')) return;

      const senderId = String(event?.metadata?.senderId || '');
      if (!senderId) return;

      const state = activeCraftDialogs.get(senderId);
      if (!state || Date.now() > state.expiresAt) return;
      if (state.step !== 'awaiting_direction' && state.step !== 'adjusting') return;

      const chatId = senderId;

      const audioFile = findRecentAudioFile();
      if (!audioFile) {
        await sendTelegram(chatId, '❌ Audio-Datei nicht gefunden.');
        return;
      }

      await sendTelegram(chatId, '🎤 Transkribiere Sprachnachricht...');
      const transcription = await transcribeVoice(audioFile.path);
      await sendTelegram(chatId, `🎤 "${transcription}"`);

      if (state.step === 'awaiting_direction') {
        state.direction = transcription;
        state.step = 'generating';
        runCraftPlanGeneration(chatId, state.sessionId, transcription).catch(err => {
          api.logger.error(`[executive-agent] craft voice-handler CRASH: ${err?.message}`);
          sendTelegram(chatId, `❌ Craft-Plan fehlgeschlagen: ${err?.message}`).catch(() => {});
          activeCraftDialogs.delete(chatId);
        });
      } else if (state.step === 'adjusting') {
        state.step = 'generating';
        runCraftPlanGeneration(chatId, state.sessionId, state.direction, state.currentPlan, transcription).catch(err => {
          api.logger.error(`[executive-agent] craft voice adjustment CRASH: ${err?.message}`);
          sendTelegram(chatId, `❌ Craft-Anpassung fehlgeschlagen: ${err?.message}`).catch(() => {});
          activeCraftDialogs.delete(chatId);
        });
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] craft-voice-handler Fehler: ${e?.message}`);
    }
  });

  // Hook: catch bare photo/video AFTER /instasubmit (pending state flow)
  // Event structure: { from, content, timestamp, metadata: { senderId, ... } }
  api.on('message_received', async (event: any) => {
    try {
      const content: string = event?.content ?? '';
      // Detect bare media message: gateway sets content to "<media:image>" or "<media:video>"
      // when no caption is present
      const isMediaMsg = content.includes('<media:image>') || content.includes('<media:video>');
      if (!isMediaMsg) return;

      const senderId = String(event?.metadata?.senderId || '');
      if (!senderId) return;

      const pending = pendingInstaSubmits.get(senderId);
      if (!pending || Date.now() > pending.expiresAt) {
        if (pending) pendingInstaSubmits.delete(senderId);
        return;
      }

      api.logger.info(`[executive-agent] instasubmit HOOK: bare media von ${senderId}, pending note="${pending.note}"`);

      // Match: bare media + pending instasubmit state
      pendingInstaSubmits.delete(senderId);
      instaSubmitActive.add(senderId);
      instaSubmitLastActivatedAt = Date.now();

      const chatId = senderId;
      sendTelegram(chatId, '📥 Empfangen. Analyse laeuft...').catch((err) => {
        api.logger.error(`[executive-agent] instasubmit Hook: Telegram-Bestätigung fehlgeschlagen: ${err?.message}`);
      });

      // Find the media file the gateway just downloaded
      const media = findRecentInboundMedia();
      if (!media) {
        api.logger.warn(`[executive-agent] instasubmit Hook: Kein Media gefunden nach bare-media-event`);
        await sendTelegram(chatId, '❌ Mediendatei nicht gefunden.\n\nBitte erneut senden: Foto direkt mit Caption /instasubmit <text>');
        instaSubmitActive.delete(senderId);
        return;
      }

      await runInstaSubmitPipeline(chatId, pending.note, media);
      instaSubmitActive.delete(senderId);
    } catch (e: any) {
      api.logger.error(`[executive-agent] instasubmit Hook-Fehler: ${e?.message}\n${e?.stack || ''}`);
    }
  });

  // Raw material saving is now handled in before_agent_start (command-guard).
  // The before_agent_start hook has direct access to file paths from the prompt
  // and can suppress AI commentary via prependContext + NO_REPLY.

  // ── Cut Engine ─────────────────────────────────────────────────────────────

  function probeVideo(filePath: string): VideoProbe {
    const raw = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
      { timeout: 15_000, stdio: 'pipe' }
    ).toString();
    const info = JSON.parse(raw);
    const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');
    const audioStream = info.streams?.find((s: any) => s.codec_type === 'audio');
    if (!videoStream) throw new Error(`Kein Video-Stream gefunden: ${filePath}`);
    const duration = parseFloat(info.format?.duration || videoStream.duration || '0');
    const fpsRaw = videoStream.r_frame_rate || '30/1';
    const [fpsNum, fpsDen] = fpsRaw.split('/').map(Number);
    return {
      duration_s: duration,
      width: parseInt(videoStream.width, 10),
      height: parseInt(videoStream.height, 10),
      codec: videoStream.codec_name || 'unknown',
      fps: fpsDen ? fpsNum / fpsDen : fpsNum,
      has_audio: !!audioStream,
    };
  }

  function getVideoDuration(filePath: string): number {
    return probeVideo(filePath).duration_s;
  }

  function normalizeForInstagram(inputPath: string, outputPath: string, format: InstaFormat): void {
    let scaleFilter: string;
    switch (format) {
      case 'reel':
        scaleFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black';
        break;
      case 'feed-video':
      case 'feed-photo':
        scaleFilter = 'scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black';
        break;
    }
    execSync(
      `ffmpeg -y -i "${inputPath}" -vf "${scaleFilter}" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`,
      { timeout: 120_000, stdio: 'pipe' }
    );
  }

  async function executeCutPlan(sessionId: string, plan: CutPlan, format?: InstaFormat): Promise<CutResult> {
    const session = loadRawSession(sessionId);
    if (!session) throw new Error(`Session nicht gefunden: ${sessionId}`);
    const dir = sessionDir(sessionId);
    const originalDir = path.join(dir, 'original');

    // Status → cutting
    session.status = 'cutting';
    session.cut_plan = plan;
    saveRawSession(session);

    const tempFiles: string[] = [];

    try {
      // 1. Segmente extrahieren
      const segPaths: string[] = [];
      for (let i = 0; i < plan.segments.length; i++) {
        const seg = plan.segments[i];
        const sourcePath = path.join(originalDir, seg.source);
        if (!fs.existsSync(sourcePath)) throw new Error(`Quelldatei nicht gefunden: ${seg.source}`);

        const probe = probeVideo(sourcePath);
        if (seg.start_s < 0 || seg.end_s <= seg.start_s) throw new Error(`Ungültige Zeiten für Segment ${i}: ${seg.start_s}–${seg.end_s}`);
        if (seg.end_s > probe.duration_s + 0.5) throw new Error(`Segment ${i} end_s (${seg.end_s}) > Dauer (${probe.duration_s})`);

        const segFile = path.join(dir, `_seg_${i}.mp4`);
        tempFiles.push(segFile);
        execSync(
          `ffmpeg -y -i "${sourcePath}" -ss ${seg.start_s} -to ${seg.end_s} -c copy "${segFile}"`,
          { timeout: 60_000, stdio: 'pipe' }
        );
        segPaths.push(segFile);
      }

      // 2. Concat
      const filelistPath = path.join(dir, '_filelist.txt');
      tempFiles.push(filelistPath);
      const filelistContent = segPaths.map(p => `file '${p}'`).join('\n');
      fs.writeFileSync(filelistPath, filelistContent);

      const concatPath = path.join(dir, '_concat_raw.mp4');
      tempFiles.push(concatPath);
      execSync(
        `ffmpeg -y -f concat -safe 0 -i "${filelistPath}" -c copy "${concatPath}"`,
        { timeout: 60_000, stdio: 'pipe' }
      );

      // 3. Normalisieren (optional)
      const outputPath = path.join(dir, plan.output_file);
      if (format && format !== 'feed-photo') {
        normalizeForInstagram(concatPath, outputPath, format);
      } else {
        fs.copyFileSync(concatPath, outputPath);
      }

      const finalProbe = probeVideo(outputPath);
      const fileStat = fs.statSync(outputPath);

      const result: CutResult = {
        output_path: outputPath,
        duration_s: finalProbe.duration_s,
        format: format || 'raw',
        file_size: fileStat.size,
        segments_used: plan.segments.length,
      };

      // Status → cut_done
      session.status = 'cut_done';
      session.cut_result = result;
      saveRawSession(session);

      return result;
    } catch (e) {
      // Fehler → zurück auf active
      session.status = 'active';
      delete session.cut_plan;
      saveRawSession(session);
      throw e;
    } finally {
      // Temp-Files aufräumen
      for (const f of tempFiles) {
        try { fs.unlinkSync(f); } catch {}
      }
    }
  }

  // ── Scan Engine ──────────────────────────────────────────────────────────

  async function analyzeSessionFiles(sessionId: string, chatId: string): Promise<FileAnalysis[]> {
    const origDir = path.join(sessionDir(sessionId), 'original');
    if (!fs.existsSync(origDir)) throw new Error(`original/ Verzeichnis nicht gefunden: ${origDir}`);

    const allFiles = fs.readdirSync(origDir).filter(name => {
      const mt = detectMediaType(name);
      return mt === 'image' || mt === 'video';
    });
    if (allFiles.length === 0) throw new Error('Keine Bild-/Video-Dateien in der Session gefunden.');

    const results: FileAnalysis[] = [];
    for (let i = 0; i < allFiles.length; i++) {
      const fileName = allFiles[i];
      const filePath = path.join(origDir, fileName);
      const mediaType = detectMediaType(fileName) as 'image' | 'video';

      try {
        await sendTelegram(chatId, `🔍 Analysiere ${i + 1}/${allFiles.length}: ${fileName}...`);

        let analysis: VisionAnalysis;
        let probe: VideoProbe | undefined;
        let duration_s: number | undefined;

        if (mediaType === 'video') {
          probe = probeVideo(filePath);
          duration_s = probe.duration_s;
          analysis = await analyzeVideo(filePath);
        } else {
          analysis = await analyzeImage(filePath);
        }

        results.push({ fileName, type: mediaType, analysis, duration_s, probe });
      } catch (err: any) {
        api.logger.warn(`[executive-agent] instascan: Analyse fehlgeschlagen für ${fileName}: ${err.message}`);
        await sendTelegram(chatId, `⚠️ ${fileName}: Analyse fehlgeschlagen — ${err.message}`);
      }
    }

    if (results.length === 0) throw new Error('Keine Datei konnte erfolgreich analysiert werden.');
    return results;
  }

  async function generateProposals(sessionId: string, fileAnalyses: FileAnalysis[]): Promise<ContentProposal[]> {
    const apiKey = readAnthropicKey();
    const styleContext = getStyleProfileSummary();
    const topContext = await getTopPerformerContext();

    const fileDescriptions = fileAnalyses.map(fa => {
      const dur = fa.duration_s ? ` (${fa.duration_s.toFixed(1)}s)` : '';
      const storyboard = fa.analysis.storyboard
        ? `\n    Storyboard: ${fa.analysis.storyboard.map(f => `${f.timestamp_s}s: ${f.description}`).join(' | ')}`
        : '';
      return `  - ${fa.fileName} [${fa.type}]${dur}\n    Subjects: ${fa.analysis.subjects.join(', ')}\n    Mood: ${fa.analysis.mood}\n    Setting: ${fa.analysis.setting}\n    Pillars: ${fa.analysis.pillar_match.join(', ')}\n    Quality: ${fa.analysis.visual_quality}${storyboard}`;
    }).join('\n');

    const prompt = `Du bist ein Instagram-Content-Stratege. Analysiere das folgende Rohmaterial und erstelle 2-3 Content-Vorschläge.

Session: ${sessionId}

Verfügbare Dateien:
${fileDescriptions}

Brand-Kontext:
${styleContext}

${topContext ? `Referenz (Top-Posts):\n${topContext}\n` : ''}
Erstelle 2-3 Vorschläge als JSON-Array. Jeder Vorschlag:
- "id": "A", "B", "C"
- "format": "reel" | "feed-video" | "feed-photo"
- "title": kurzer Titel (max 40 Zeichen)
- "rationale": warum dieser Content funktioniert (1-2 Sätze)
- "pillar_match": passende Pillars aus dem Style-Profil
- "source_files": welche Dateien verwendet werden
- "estimated_duration_s": geschätzte Dauer (nur bei Video)
- "cut_plan": nur bei Video — Objekt mit "output_file" (string) und "segments" (Array von {"source": Dateiname, "start_s": number, "end_s": number})

Regeln für cut_plan:
- source_files müssen existierende Dateinamen sein
- start_s/end_s müssen innerhalb der Datei-Dauer liegen
- Reel max 90s, Feed-Video max 60s
- output_file: "<format>-<session-id>.mp4"
- Bei Foto-Vorschlägen: kein cut_plan

Antworte NUR mit dem JSON-Array, kein Markdown, kein Text drumherum.`;

    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, 90_000);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data: any = await res.json();
    const rawText = (data.content?.[0]?.text || '').trim();

    let proposals: ContentProposal[];
    try {
      // Strip potential markdown fencing
      const cleaned = rawText.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      proposals = JSON.parse(cleaned);
    } catch {
      throw new Error(`Konnte Proposals nicht parsen: ${rawText.slice(0, 200)}`);
    }

    if (!Array.isArray(proposals) || proposals.length === 0) {
      throw new Error('Keine gültigen Proposals erhalten.');
    }

    // Build duration lookup from file analyses
    const durationMap = new Map<string, number>();
    for (const fa of fileAnalyses) {
      if (fa.duration_s != null) durationMap.set(fa.fileName, fa.duration_s);
    }
    const knownFiles = new Set(fileAnalyses.map(fa => fa.fileName));

    // Validate proposals
    for (const p of proposals) {
      // Validate source_files exist
      p.source_files = (p.source_files || []).filter((f: string) => knownFiles.has(f));

      // Validate cut_plan timing
      if (p.cut_plan?.segments) {
        p.cut_plan.segments = p.cut_plan.segments.filter((seg: CutSegment) => {
          if (!knownFiles.has(seg.source)) return false;
          const dur = durationMap.get(seg.source);
          if (dur != null && (seg.start_s < 0 || seg.end_s > dur + 0.5)) return false;
          return seg.end_s > seg.start_s;
        });
      }
    }

    return proposals;
  }

  function formatProposalMessage(sessionId: string, proposals: ContentProposal[]): string {
    const lines: string[] = [`📁 Session: ${sessionId}\n`];
    for (const p of proposals) {
      const formatEmoji = p.format === 'reel' ? '🎬' : p.format === 'feed-video' ? '📹' : '📸';
      const dur = p.estimated_duration_s ? ` (${Math.round(p.estimated_duration_s)}s)` : '';
      const pillars = p.pillar_match.length > 0 ? `\n   Pillars: ${p.pillar_match.join(', ')}` : '';
      const files = p.source_files.length > 0 ? `\n   Dateien: ${p.source_files.join(', ')}` : '';
      lines.push(`${formatEmoji} ${p.id}: ${p.title} [${p.format}]${dur}${pillars}${files}\n   ${p.rationale}`);
    }
    const msg = lines.join('\n\n');
    return msg.length > 4000 ? msg.slice(0, 3997) + '...' : msg;
  }

  function buildProposalKeyboard(sessionId: string, proposals: ContentProposal[]): Array<Array<{ text: string; callback_data: string }>> {
    return proposals.map(p => {
      const formatLabel = p.format === 'reel' ? 'Reel' : p.format === 'feed-video' ? 'Feed' : 'Foto';
      // callback_data max 64 bytes — use compact format
      const cbData = `iscan_${sessionId}::${p.id}`;
      return [{ text: `${p.id}: ${formatLabel} — ${p.title.slice(0, 25)}`, callback_data: cbData.slice(0, 64) }];
    });
  }

  async function handleInstascanCallback(callbackQueryId: string, chatId: string, data: string): Promise<void> {
    // Parse: iscan_<sessionId>::<proposalId>
    const sepIdx = data.indexOf('::');
    if (sepIdx === -1) {
      await answerCallbackQuery(callbackQueryId, 'Ungültige Daten');
      return;
    }
    const sessionId = data.slice(6, sepIdx); // skip "iscan_"
    const proposalId = data.slice(sepIdx + 2);

    await answerCallbackQuery(callbackQueryId, 'Wird ausgeführt...');

    const session = loadRawSession(sessionId);
    if (!session?.scan_result) {
      await sendTelegram(chatId, `❌ Session ${sessionId} hat kein Scan-Ergebnis.`);
      return;
    }

    const proposal = session.scan_result.proposals.find(p => p.id === proposalId);
    if (!proposal) {
      await sendTelegram(chatId, `❌ Vorschlag ${proposalId} nicht gefunden.`);
      return;
    }

    try {
      session.scan_result.selected_proposal = proposalId;
      saveRawSession(session);

      if (proposal.cut_plan && (proposal.format === 'reel' || proposal.format === 'feed-video')) {
        // Video proposal — cut + analyze + variants + draft
        await sendTelegram(chatId, `✂️ Schneide Video (Vorschlag ${proposalId})...`);
        const cutResult = await executeCutPlan(sessionId, proposal.cut_plan, proposal.format);

        await sendTelegram(chatId, '🔍 Analysiere Ergebnis...');
        const analysis = await analyzeVideo(cutResult.output_path);

        // Create submission
        const submissionId = generateSubmissionId(proposal.title);
        const submission: Submission = {
          id: submissionId,
          media: [{ type: 'video', path: cutResult.output_path, mimeType: 'video/mp4' }],
          context: { user_note: `Scan ${sessionId} → ${proposalId}: ${proposal.title}` },
          status: 'analyzed',
          analysis,
          created: new Date().toISOString(),
        };
        await saveSubmission(submission);

        await sendTelegram(chatId, '✍️ Generiere Caption-Varianten...');
        const variants = await generateVariants(submission);
        submission.variants = variants;
        submission.status = 'generated';
        await saveSubmission(submission);

        // Create draft from first variant
        const chosen = variants[0];
        const draft = createInstaDraft({
          caption: chosen.caption,
          hashtags: chosen.hashtags,
          mediaPath: cutResult.output_path,
          notes: `Scan ${sessionId} → Vorschlag ${proposalId}: ${proposal.title}`,
        });

        const variantsText = formatVariantsOutput(submissionId, variants);
        await sendTelegram(chatId,
          `✅ Vorschlag ${proposalId} umgesetzt\n\n` +
          `🎬 Video: ${cutResult.duration_s.toFixed(1)}s, ${formatFileSize(cutResult.file_size)}\n` +
          `📝 Draft: ${draft.id}\n` +
          `📋 Submission: ${submissionId}\n\n` +
          `${variantsText}\n\n` +
          `→ /instaapprove ${submissionId} <nr> für andere Variante\n` +
          `→ /instaedit ${draft.id} zum Bearbeiten`
        );
      } else {
        // Photo proposal — use cached analysis + variants + draft
        const fileAnalysis = session.scan_result.file_analyses.find(fa =>
          proposal.source_files.includes(fa.fileName)
        );
        const analysis = fileAnalysis?.analysis;

        const sourceFile = proposal.source_files[0];
        const sourcePath = path.join(sessionDir(sessionId), 'original', sourceFile);

        const submissionId = generateSubmissionId(proposal.title);
        const submission: Submission = {
          id: submissionId,
          media: [{ type: 'image', path: sourcePath, mimeType: 'image/jpeg' }],
          context: { user_note: `Scan ${sessionId} → ${proposalId}: ${proposal.title}` },
          status: 'analyzed',
          analysis,
          created: new Date().toISOString(),
        };
        await saveSubmission(submission);

        await sendTelegram(chatId, '✍️ Generiere Caption-Varianten...');
        const variants = await generateVariants(submission);
        submission.variants = variants;
        submission.status = 'generated';
        await saveSubmission(submission);

        const chosen = variants[0];
        const draft = createInstaDraft({
          caption: chosen.caption,
          hashtags: chosen.hashtags,
          mediaPath: sourcePath,
          notes: `Scan ${sessionId} → Vorschlag ${proposalId}: ${proposal.title}`,
        });

        const variantsText = formatVariantsOutput(submissionId, variants);
        await sendTelegram(chatId,
          `✅ Vorschlag ${proposalId} umgesetzt\n\n` +
          `📸 Foto: ${sourceFile}\n` +
          `📝 Draft: ${draft.id}\n` +
          `📋 Submission: ${submissionId}\n\n` +
          `${variantsText}\n\n` +
          `→ /instaapprove ${submissionId} <nr> für andere Variante\n` +
          `→ /instaedit ${draft.id} zum Bearbeiten`
        );
      }
    } catch (err: any) {
      api.logger.error(`[executive-agent] instascan callback Fehler: ${err.message}\n${err.stack || ''}`);
      // Reset session status
      const freshSession = loadRawSession(sessionId);
      if (freshSession && freshSession.status !== 'active' && freshSession.status !== 'scanned') {
        freshSession.status = 'scanned';
        saveRawSession(freshSession);
      }
      await sendTelegram(chatId, `❌ Vorschlag ${proposalId} fehlgeschlagen: ${err.message}`);
    }
  }

  async function runInstascanPipeline(sessionId: string, chatId: string): Promise<void> {
    const session = loadRawSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} nicht gefunden`);

    try {
      session.status = 'scanning';
      saveRawSession(session);

      await sendTelegram(chatId, `🔍 Scanne Session ${sessionId}...`);

      const fileAnalyses = await analyzeSessionFiles(sessionId, chatId);

      await sendTelegram(chatId, '💡 Generiere Vorschläge...');

      const proposals = await generateProposals(sessionId, fileAnalyses);

      // Save scan result
      session.status = 'scanned';
      session.scan_result = {
        scanned_at: new Date().toISOString(),
        file_analyses: fileAnalyses,
        proposals,
      };
      saveRawSession(session);

      const msg = formatProposalMessage(sessionId, proposals);
      const keyboard = buildProposalKeyboard(sessionId, proposals);
      await sendTelegramWithKeyboard(chatId, msg, keyboard);
    } catch (err: any) {
      api.logger.error(`[executive-agent] instascan pipeline Fehler: ${err.message}\n${err.stack || ''}`);
      // Reset session status
      const freshSession = loadRawSession(sessionId);
      if (freshSession && freshSession.status === 'scanning') {
        freshSession.status = 'active';
        saveRawSession(freshSession);
      }
      await sendTelegram(chatId, `❌ Scan fehlgeschlagen: ${err.message}`);
    } finally {
      instaScanActive.delete(chatId);
    }
  }

  // ── Craft Engine ─────────────────────────────────────────────────────────

  async function generateCraftPlan(
    sessionId: string,
    fileAnalyses: FileAnalysis[],
    direction: string,
    previousPlan?: ContentProposal,
    adjustmentNote?: string,
  ): Promise<ContentProposal> {
    const apiKey = readAnthropicKey();
    const styleContext = getStyleProfileSummary();
    const topContext = await getTopPerformerContext();

    const fileDescriptions = fileAnalyses.map(fa => {
      const dur = fa.duration_s ? ` (${fa.duration_s.toFixed(1)}s)` : '';
      const storyboard = fa.analysis.storyboard
        ? `\n    Storyboard: ${fa.analysis.storyboard.map(f => `${f.timestamp_s}s: ${f.description}`).join(' | ')}`
        : '';
      return `  - ${fa.fileName} [${fa.type}]${dur}\n    Subjects: ${fa.analysis.subjects.join(', ')}\n    Mood: ${fa.analysis.mood}\n    Setting: ${fa.analysis.setting}\n    Pillars: ${fa.analysis.pillar_match.join(', ')}\n    Quality: ${fa.analysis.visual_quality}${storyboard}`;
    }).join('\n');

    let adjustmentBlock = '';
    if (previousPlan && adjustmentNote) {
      adjustmentBlock = `\nVorheriger Plan (anpassen, nicht neu erstellen):
- Format: ${previousPlan.format}
- Titel: ${previousPlan.title}
- Rationale: ${previousPlan.rationale}
- Dateien: ${previousPlan.source_files.join(', ')}
${previousPlan.cut_plan ? `- Cut-Plan: ${previousPlan.cut_plan.segments.map(s => `${s.source} ${s.start_s}-${s.end_s}s`).join(', ')}` : ''}

Anpassungswunsch des Users: "${adjustmentNote}"
`;
    }

    const prompt = `Du bist ein Instagram-Content-Stratege. Der User hat eine kreative Richtung vorgegeben. Erstelle EINEN maßgeschneiderten Content-Vorschlag.

Session: ${sessionId}

Kreative Richtung des Users: "${direction}"

Verfügbare Dateien:
${fileDescriptions}

Brand-Kontext:
${styleContext}

${topContext ? `Referenz (Top-Posts):\n${topContext}\n` : ''}${adjustmentBlock}
Erstelle EINEN Vorschlag als JSON-Objekt (kein Array). Der Vorschlag:
- "id": "craft"
- "format": "reel" | "feed-video" | "feed-photo"
- "title": kurzer Titel (max 40 Zeichen)
- "rationale": warum dieser Content funktioniert (1-2 Sätze)
- "pillar_match": passende Pillars aus dem Style-Profil
- "source_files": welche Dateien verwendet werden
- "estimated_duration_s": geschätzte Dauer (nur bei Video)
- "cut_plan": nur bei Video — Objekt mit "output_file" (string) und "segments" (Array von {"source": Dateiname, "start_s": number, "end_s": number})

Regeln für cut_plan:
- source_files müssen existierende Dateinamen sein
- start_s/end_s müssen innerhalb der Datei-Dauer liegen
- Reel max 90s, Feed-Video max 60s
- output_file: "<format>-${sessionId}.mp4"
- Bei Foto-Vorschlägen: kein cut_plan

Der Vorschlag muss die kreative Richtung des Users widerspiegeln.

Antworte NUR mit dem JSON-Objekt, kein Markdown, kein Text drumherum.`;

    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, 90_000);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data: any = await res.json();
    const rawText = (data.content?.[0]?.text || '').trim();

    let proposal: ContentProposal;
    try {
      const cleaned = rawText.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      proposal = JSON.parse(cleaned);
    } catch {
      throw new Error(`Konnte Craft-Plan nicht parsen: ${rawText.slice(0, 200)}`);
    }

    if (!proposal || typeof proposal !== 'object' || !proposal.format) {
      throw new Error('Kein gültiger Craft-Plan erhalten.');
    }

    // Validate source_files + cut_plan timing (same logic as generateProposals)
    const durationMap = new Map<string, number>();
    for (const fa of fileAnalyses) {
      if (fa.duration_s != null) durationMap.set(fa.fileName, fa.duration_s);
    }
    const knownFiles = new Set(fileAnalyses.map(fa => fa.fileName));

    proposal.source_files = (proposal.source_files || []).filter((f: string) => knownFiles.has(f));
    if (proposal.cut_plan?.segments) {
      proposal.cut_plan.segments = proposal.cut_plan.segments.filter((seg: CutSegment) => {
        if (!knownFiles.has(seg.source)) return false;
        const dur = durationMap.get(seg.source);
        if (dur != null && (seg.start_s < 0 || seg.end_s > dur + 0.5)) return false;
        return seg.end_s > seg.start_s;
      });
    }

    proposal.id = 'craft';
    return proposal;
  }

  function formatCraftPlanMessage(sessionId: string, plan: ContentProposal, direction: string): string {
    const formatEmoji = plan.format === 'reel' ? '🎬' : plan.format === 'feed-video' ? '📹' : '📸';
    const dur = plan.estimated_duration_s ? ` (${Math.round(plan.estimated_duration_s)}s)` : '';
    const pillars = plan.pillar_match.length > 0 ? `\nPillars: ${plan.pillar_match.join(', ')}` : '';
    const files = plan.source_files.length > 0 ? `\nDateien: ${plan.source_files.join(', ')}` : '';

    let cutDetails = '';
    if (plan.cut_plan?.segments?.length) {
      const segLines = plan.cut_plan.segments.map((s, i) =>
        `  ${i + 1}. ${s.source} [${s.start_s.toFixed(1)}s – ${s.end_s.toFixed(1)}s]`
      );
      cutDetails = `\n\nCut-Plan:\n${segLines.join('\n')}`;
    }

    const msg = `🎨 Craft-Plan — Session: ${sessionId}\n` +
      `Richtung: "${direction}"\n\n` +
      `${formatEmoji} ${plan.title} [${plan.format}]${dur}${pillars}${files}\n${plan.rationale}` +
      cutDetails;

    return msg.length > 4000 ? msg.slice(0, 3997) + '...' : msg;
  }

  function buildCraftKeyboard(sessionId: string): Array<Array<{ text: string; callback_data: string }>> {
    return [
      [
        { text: '✅ Ja', callback_data: `icraft_${sessionId}::ja`.slice(0, 64) },
        { text: '✏️ Anpassen', callback_data: `icraft_${sessionId}::anpassen`.slice(0, 64) },
        { text: '❌ Abbrechen', callback_data: `icraft_${sessionId}::abbrechen`.slice(0, 64) },
      ],
    ];
  }

  async function handleCraftCallback(callbackQueryId: string, chatId: string, data: string): Promise<void> {
    // Parse: icraft_<sessionId>::<action>
    const sepIdx = data.indexOf('::');
    if (sepIdx === -1) {
      await answerCallbackQuery(callbackQueryId, 'Ungültige Daten');
      return;
    }
    const sessionId = data.slice(7, sepIdx); // skip "icraft_"
    const action = data.slice(sepIdx + 2);

    const state = activeCraftDialogs.get(chatId);
    if (!state || state.sessionId !== sessionId || Date.now() > state.expiresAt) {
      await answerCallbackQuery(callbackQueryId, 'Dialog abgelaufen');
      activeCraftDialogs.delete(chatId);
      return;
    }

    if (action === 'ja') {
      if (state.step !== 'plan_ready') {
        await answerCallbackQuery(callbackQueryId, 'Plan noch nicht bereit');
        return;
      }

      await answerCallbackQuery(callbackQueryId, 'Wird ausgeführt...');
      state.step = 'executing';

      const plan = state.currentPlan!;

      try {
        if (plan.cut_plan && (plan.format === 'reel' || plan.format === 'feed-video')) {
          // Video proposal — cut + analyze + variants + draft
          await sendTelegram(chatId, `✂️ Schneide Video (Craft-Plan)...`);
          const cutResult = await executeCutPlan(sessionId, plan.cut_plan, plan.format);

          await sendTelegram(chatId, '🔍 Analysiere Ergebnis...');
          const analysis = await analyzeVideo(cutResult.output_path);

          const submissionId = generateSubmissionId(plan.title);
          const submission: Submission = {
            id: submissionId,
            media: [{ type: 'video', path: cutResult.output_path, mimeType: 'video/mp4' }],
            context: { user_note: `Craft ${sessionId}: ${plan.title}` },
            status: 'analyzed',
            analysis,
            created: new Date().toISOString(),
          };
          await saveSubmission(submission);

          await sendTelegram(chatId, '✍️ Generiere Caption-Varianten...');
          const variants = await generateVariants(submission);
          submission.variants = variants;
          submission.status = 'generated';
          await saveSubmission(submission);

          const chosen = variants[0];
          const draft = createInstaDraft({
            caption: chosen.caption,
            hashtags: chosen.hashtags,
            mediaPath: cutResult.output_path,
            notes: `Craft ${sessionId}: ${plan.title}`,
          });

          const variantsText = formatVariantsOutput(submissionId, variants);
          await sendTelegram(chatId,
            `✅ Craft-Plan umgesetzt\n\n` +
            `🎬 Video: ${cutResult.duration_s.toFixed(1)}s, ${formatFileSize(cutResult.file_size)}\n` +
            `📝 Draft: ${draft.id}\n` +
            `📋 Submission: ${submissionId}\n\n` +
            `${variantsText}\n\n` +
            `→ /instaapprove ${submissionId} <nr> für andere Variante\n` +
            `→ /instaedit ${draft.id} zum Bearbeiten`
          );
        } else {
          // Photo proposal — use cached analysis + variants + draft
          const fileAnalysis = state.fileAnalyses?.find(fa =>
            plan.source_files.includes(fa.fileName)
          );
          const analysis = fileAnalysis?.analysis;

          const sourceFile = plan.source_files[0];
          const sourcePath = path.join(sessionDir(sessionId), 'original', sourceFile);

          const submissionId = generateSubmissionId(plan.title);
          const submission: Submission = {
            id: submissionId,
            media: [{ type: 'image', path: sourcePath, mimeType: 'image/jpeg' }],
            context: { user_note: `Craft ${sessionId}: ${plan.title}` },
            status: 'analyzed',
            analysis,
            created: new Date().toISOString(),
          };
          await saveSubmission(submission);

          await sendTelegram(chatId, '✍️ Generiere Caption-Varianten...');
          const variants = await generateVariants(submission);
          submission.variants = variants;
          submission.status = 'generated';
          await saveSubmission(submission);

          const chosen = variants[0];
          const draft = createInstaDraft({
            caption: chosen.caption,
            hashtags: chosen.hashtags,
            mediaPath: sourcePath,
            notes: `Craft ${sessionId}: ${plan.title}`,
          });

          const variantsText = formatVariantsOutput(submissionId, variants);
          await sendTelegram(chatId,
            `✅ Craft-Plan umgesetzt\n\n` +
            `📸 Foto: ${sourceFile}\n` +
            `📝 Draft: ${draft.id}\n` +
            `📋 Submission: ${submissionId}\n\n` +
            `${variantsText}\n\n` +
            `→ /instaapprove ${submissionId} <nr> für andere Variante\n` +
            `→ /instaedit ${draft.id} zum Bearbeiten`
          );
        }
      } catch (err: any) {
        api.logger.error(`[executive-agent] craft callback Fehler: ${err.message}\n${err.stack || ''}`);
        const freshSession = loadRawSession(sessionId);
        if (freshSession && freshSession.status === 'crafting') {
          freshSession.status = 'scanned';
          saveRawSession(freshSession);
        }
        await sendTelegram(chatId, `❌ Craft-Plan fehlgeschlagen: ${err.message}`);
      } finally {
        activeCraftDialogs.delete(chatId);
      }
    } else if (action === 'anpassen') {
      if (state.step !== 'plan_ready') {
        await answerCallbackQuery(callbackQueryId, 'Plan noch nicht bereit');
        return;
      }
      await answerCallbackQuery(callbackQueryId, 'Anpassung');
      state.step = 'adjusting';
      await sendTelegram(chatId, '✏️ Sende deine Anpassung (Text oder Sprachnachricht):');
    } else if (action === 'abbrechen') {
      await answerCallbackQuery(callbackQueryId, 'Abgebrochen');
      activeCraftDialogs.delete(chatId);
      const freshSession = loadRawSession(sessionId);
      if (freshSession && freshSession.status === 'crafting') {
        freshSession.status = freshSession.scan_result ? 'scanned' : 'active';
        saveRawSession(freshSession);
      }
      await sendTelegram(chatId, '❌ Craft-Dialog abgebrochen.');
    } else {
      await answerCallbackQuery(callbackQueryId, 'Unbekannte Aktion');
    }
  }

  async function runCraftPlanGeneration(
    chatId: string,
    sessionId: string,
    direction: string,
    previousPlan?: ContentProposal,
    adjustmentNote?: string,
  ): Promise<void> {
    try {
      const state = activeCraftDialogs.get(chatId);
      if (!state) return;

      // File analyses: reuse from scan_result if available, else analyze
      let fileAnalyses: FileAnalysis[];
      const session = loadRawSession(sessionId);
      if (session?.scan_result?.file_analyses?.length) {
        fileAnalyses = session.scan_result.file_analyses;
      } else {
        await sendTelegram(chatId, '🔍 Analysiere Dateien...');
        fileAnalyses = await analyzeSessionFiles(sessionId, chatId);
      }

      await sendTelegram(chatId, '🎨 Generiere Craft-Plan...');
      const plan = await generateCraftPlan(sessionId, fileAnalyses, direction, previousPlan, adjustmentNote);

      // Update state
      state.step = 'plan_ready';
      state.currentPlan = plan;
      state.fileAnalyses = fileAnalyses;

      const msg = formatCraftPlanMessage(sessionId, plan, direction);
      const keyboard = buildCraftKeyboard(sessionId);
      await sendTelegramWithKeyboard(chatId, msg, keyboard);
    } catch (err: any) {
      api.logger.error(`[executive-agent] craft plan generation Fehler: ${err.message}\n${err.stack || ''}`);
      // Cleanup state
      activeCraftDialogs.delete(chatId);
      const freshSession = loadRawSession(sessionId);
      if (freshSession && freshSession.status === 'crafting') {
        freshSession.status = freshSession.scan_result ? 'scanned' : 'active';
        saveRawSession(freshSession);
      }
      await sendTelegram(chatId, `❌ Craft-Plan-Generierung fehlgeschlagen: ${err.message}`);
    }
  }

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
        const ts = new Date(`${s.date}T03:00:00.000Z`);
        upsertEntryForDate(s.date, ts, {
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

    // ── INSTAGRAM ──
    {
      const instaLines: string[] = [];
      try {
        // Proaktiver Refresh vor Briefing-Datenabfrage
        if (instaAuthorized() && metaAppId && metaAppSecret) {
          try { await ensureInstaToken(metaAppId, metaAppSecret); } catch {}
        }

        const daysLeft = tokenDaysRemaining();
        if (daysLeft > 0 && daysLeft < 7) {
          instaLines.push(`⚠️ Token läuft in ${daysLeft} Tagen ab!`);
        }

        // Always fetch live data during briefing
        if (instaAuthorized()) {
          const t = loadInstaTokens();
          if (t?.access_token && t?.ig_business_id) {
            try {
              const insights = await fetchInsights(t.access_token, t.ig_business_id, true);
              instaLines.push(`- Follower: ${insights.followers_count.toLocaleString('de')} | Engagement: ${insights.engagement_rate}%`);
            } catch (e: any) {
              const errMsg = e?.message || String(e);
              api.logger.warn(`[executive-agent] Instagram Insights Refresh fehlgeschlagen: ${errMsg}`);
              // Token expired on Meta side — mark failed and try forced refresh
              if (errMsg.includes('Session has expired') || errMsg.includes('expired') || errMsg.includes('code":190') || errMsg.includes('code": 190')) {
                markInstaTokenFailed();
                try {
                  const refreshed = await ensureInstaToken(metaAppId, metaAppSecret, true);
                  const retryInsights = await fetchInsights(refreshed.access_token, refreshed.ig_business_id, true);
                  instaLines.push(`- Follower: ${retryInsights.followers_count.toLocaleString('de')} | Engagement: ${retryInsights.engagement_rate}%`);
                  instaLines.push(`✅ Token automatisch erneuert`);
                } catch (retryErr: any) {
                  instaLines.push(`❌ Token abgelaufen — neuer Token aus Meta Developer Portal nötig`);
                }
              } else {
                instaLines.push(`❌ API-Fehler: ${errMsg.slice(0, 120)}`);
              }
            }
          }
        } else {
          instaLines.push(`⚠️ Nicht verbunden — Token fehlt`);
        }

        const openInstaDrafts = listInstaDrafts('entwurf');
        if (openInstaDrafts.length > 0) {
          instaLines.push(`- ${openInstaDrafts.length} Draft${openInstaDrafts.length > 1 ? 's' : ''} offen`);
        }
      } catch (e: any) {
        instaLines.push(`❌ Instagram-Fehler: ${(e?.message || String(e)).slice(0, 100)}`);
      }

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

  // ── Private Equity ────────────────────────────────────────────────────────

  api.registerCommand({
    name: 'pe',
    description: 'Private-Equity-Beteiligungen anzeigen',
    handler: async () => {
      try {
        const investments = getAllInvestments();
        return { text: formatInvestmentList(investments) };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'peshow',
    acceptsArgs: true,
    description: 'Detail einer Beteiligung: /peshow <id>',
    handler: async (ctx: any) => {
      try {
        const id = String(ctx.args || '').trim();
        if (!id) return { text: '❌ Verwendung: /peshow <id>' };
        const inv = getInvestment(id);
        if (!inv) return { text: `❌ Beteiligung nicht gefunden: ${id}` };
        const history = getValuationHistory(id);
        let text = formatInvestmentDetail(inv);
        if (history.length) {
          text += '\n\n📊 Bewertungshistorie:\n';
          for (const h of history.slice(-10)) {
            const amt = h.amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            text += `   • ${h.date} — ${amt} € (${h.method || '–'})${h.notes ? ' — ' + h.notes : ''}\n`;
          }
          if (history.length > 10) text += `   ... und ${history.length - 10} weitere\n`;
        }
        return { text };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'penew',
    acceptsArgs: true,
    description: 'Neue Beteiligung: /penew <Firma> <Sektor> <Betrag> <Anteile> <Gesamt-Anteile>',
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const parts = raw.split(/\s+/);
        if (parts.length < 5) return { text: '❌ Verwendung: /penew <Firma> <Sektor> <Betrag> <Anteile> <Gesamt-Anteile>\nBeispiel: /penew TobaGrown Cannabis 50000 500 10000' };
        const [company, sector, amtStr, sharesStr, totalStr] = parts;
        const amount = Number(amtStr);
        const shares = Number(sharesStr);
        const total = Number(totalStr);
        if (!Number.isFinite(amount) || amount <= 0) return { text: '❌ Betrag muss eine positive Zahl sein.' };
        if (!Number.isFinite(shares) || shares <= 0) return { text: '❌ Anteile müssen eine positive Zahl sein.' };
        if (!Number.isFinite(total) || total <= 0) return { text: '❌ Gesamt-Anteile müssen eine positive Zahl sein.' };
        const inv = createInvestment(company, sector.replace(/-/g, ' / '), amount, shares, total);
        return { text: `✅ Beteiligung angelegt!\n\n${formatInvestmentDetail(inv)}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'peedit',
    acceptsArgs: true,
    description: 'Beteiligung bearbeiten: /peedit <id> <feld> <wert>',
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const parts = raw.split(/\s+/);
        if (parts.length < 3) return { text: '❌ Verwendung: /peedit <id> <feld> <wert>\nFelder: company, sector, status, contact, notes, shares, ownershipPct' };
        const [id, field, ...rest] = parts;
        const value = rest.join(' ');
        const inv = getInvestment(id);
        if (!inv) return { text: `❌ Beteiligung nicht gefunden: ${id}` };
        const allowed: Record<string, string> = {
          company: 'company', sector: 'sector', status: 'status',
          contact: 'contactPerson', notes: 'notes',
          shares: 'shares', ownershippct: 'ownershipPct',
        };
        const key = allowed[field.toLowerCase()];
        if (!key) return { text: `❌ Unbekanntes Feld: ${field}\nErlaubt: ${Object.keys(allowed).join(', ')}` };
        let patch: any = {};
        if (key === 'shares') {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) return { text: '❌ Anteile müssen eine Zahl sein.' };
          patch.shares = n;
        } else if (key === 'status') {
          if (!['active', 'exited', 'written-off'].includes(value)) return { text: '❌ Status: active | exited | written-off' };
          patch.status = value;
        } else {
          patch[key] = value;
        }
        const updated = updateInvestment(id, patch);
        return { text: `✅ Aktualisiert: ${field} → ${value}\n\n${formatInvestmentDetail(updated!)}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

  api.registerCommand({
    name: 'pevalue',
    acceptsArgs: true,
    description: 'Neue Bewertung: /pevalue <id> <betrag> [methode]',
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        const parts = raw.split(/\s+/);
        if (parts.length < 2) return { text: '❌ Verwendung: /pevalue <id> <betrag> [methode]' };
        const [id, amtStr, ...methodParts] = parts;
        const amount = Number(amtStr);
        if (!Number.isFinite(amount) || amount < 0) return { text: '❌ Betrag muss eine positive Zahl sein.' };
        const inv = getInvestment(id);
        if (!inv) return { text: `❌ Beteiligung nicht gefunden: ${id}` };
        const method = methodParts.length ? methodParts.join(' ') : undefined;
        addValuation(id, amount, method);
        const updated = getInvestment(id)!;
        const irr = calculateIRR(updated.investedAmount, updated.currentValuation, updated.investmentDate, updated.valuationDate);
        return { text: `✅ Bewertung aktualisiert: ${amount.toLocaleString('de-DE')} €\nIRR: ${irr.toFixed(1)}%\n\n${formatInvestmentDetail(updated)}` };
      } catch (e: any) {
        return { text: `❌ Fehler: ${e.message}` };
      }
    },
  });

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

      if (data.startsWith('icraft_')) {
        await handleCraftCallback(callbackQueryId, chatId, data);
        return;
      }

      if (data.startsWith('iscan_')) {
        await handleInstascanCallback(callbackQueryId, chatId, data);
        return;
      }

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

  // ── Location HTTP Endpoint (POST /location) ──────────────────────────────
  const locationPort = 18791;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';

  const locationServer = http.createServer(async (req: any, res: any) => {
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

    api.logger.info(`[executive-agent] Location-API: Standort gespeichert: ${label} (${lat}, ${lon})`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, label }));
  });

  locationServer.on('error', (e: any) => {
    api.logger.error(`[executive-agent] Location-Server Fehler: ${e.message}`);
  });

  locationServer.listen(locationPort, '127.0.0.1', () => {
    api.logger.info(`[executive-agent] Location-API (intern) gestartet auf Port ${locationPort}`);
  });

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
  })();
}
