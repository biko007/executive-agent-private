import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface MetaTokens {
  access_token: string;
  expires_at: number;       // epoch ms
  refreshed_at: number;     // epoch ms
  ig_business_id: string;
  page_id: string;
}

export interface InsightsCache {
  fetched_at: number;       // epoch ms
  followers_count: number;
  media_count: number;
  engagement_rate: number;
  recent_avg_likes: number;
  recent_avg_comments: number;
}

export interface MediaItem {
  id: string;
  caption: string;
  media_type: string;       // IMAGE, VIDEO, CAROUSEL_ALBUM
  media_url?: string;       // image/video URL (IMAGE, CAROUSEL_ALBUM)
  thumbnail_url?: string;   // thumbnail URL (VIDEO only)
  permalink: string;
  timestamp: string;        // ISO 8601
  like_count: number;
  comments_count: number;
  engagement: number;       // likes + comments
}

export interface MediaCache {
  fetched_at: number;       // epoch ms
  items: MediaItem[];
}

export interface InstaDraft {
  id: string;
  createdAt: string;        // ISO 8601
  updatedAt: string;        // ISO 8601
  status: 'entwurf' | 'freigegeben';
  caption: string;
  hashtags: string[];
  scheduledFor?: string;    // ISO date
  planNr?: number;
  mediaPath?: string;
  notes?: string;
}

export interface ContentCalendarEntry {
  nr: number;
  date: string;             // ISO date
  topic: string;
  format: string;           // z.B. Reel, Karussell, Single Post
  caption_idea: string;
  hashtags: string[];
  notes?: string;
}

export interface ContentCalendar {
  generated_at: string;     // ISO 8601
  entries: ContentCalendarEntry[];
}

// ── Paths ──────────────────────────────────────────────────────────────────

const INSTA_DIR = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/instagram'
);
const DRAFTS_DIR = path.join(INSTA_DIR, 'drafts');
const TOKENS_FILE = path.join(INSTA_DIR, 'tokens.json');
const INSIGHTS_CACHE_FILE = path.join(INSTA_DIR, 'insights-cache.json');
const MEDIA_CACHE_FILE = path.join(INSTA_DIR, 'media-cache.json');
const CALENDAR_FILE = path.join(INSTA_DIR, 'content-calendar.json');

function ensureDir() {
  fs.mkdirSync(INSTA_DIR, { recursive: true });
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
}

// ── Internal: fetchWithTimeout ─────────────────────────────────────────────
// Self-contained copy (store is independent, pattern from withings-store)

async function fetchWithTimeout(url: string, init: any, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`fetch_timeout_after_${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ── Internal: Graph API wrapper ────────────────────────────────────────────

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

async function graphGet(endpoint: string, token: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${GRAPH_BASE}${endpoint}`);
  url.searchParams.set('access_token', token);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetchWithTimeout(url.toString(), { method: 'GET' }, 15000);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meta Graph API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ── Token Management ───────────────────────────────────────────────────────

export function loadTokens(): MetaTokens | null {
  if (!fs.existsSync(TOKENS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); }
  catch { return null; }
}

export function saveTokens(t: MetaTokens): void {
  ensureDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2), 'utf-8');
}

export function isAuthorized(): boolean { return loadTokens() !== null; }

export function tokenDaysRemaining(): number {
  const t = loadTokens();
  if (!t) return 0;
  return Math.max(0, Math.round((t.expires_at - Date.now()) / 86_400_000));
}

export function tokenExpiringSoon(): boolean {
  return tokenDaysRemaining() < 7;
}

/**
 * Refresh long-lived token proactively every 7 days (by age, not remaining time).
 * Meta long-lived tokens can be refreshed any time before expiry.
 */
export async function ensureFreshToken(appId: string, appSecret: string): Promise<MetaTokens> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Instagram nicht autorisiert — Token fehlt.');

  // Already expired — can't refresh, need manual re-auth
  if (tokens.expires_at <= Date.now()) {
    console.warn('[instagram-store] Token abgelaufen — manuelles Re-Auth nötig');
    return tokens;
  }

  // Refresh if last refresh was > 7 days ago (proactive renewal)
  const daysSinceRefresh = (Date.now() - (tokens.refreshed_at || 0)) / 86_400_000;
  if (daysSinceRefresh < 7) return tokens;

  // Refresh via Meta token exchange
  console.log(`[instagram-store] Token-Refresh: ${daysSinceRefresh.toFixed(1)} Tage seit letztem Refresh, ${tokenDaysRemaining()} Tage bis Ablauf`);
  const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', tokens.access_token);

  const res = await fetchWithTimeout(url.toString(), { method: 'GET' }, 15000);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Code 101 = invalid app secret — token itself may still be valid, skip refresh
    if (body.includes('"code":101') || body.includes('"code": 101')) {
      console.warn('[instagram-store] Token-Refresh übersprungen (App-Secret ungültig, Code 101) — verwende bestehenden Token');
      return tokens;
    }
    throw new Error(`Token-Refresh fehlgeschlagen: ${res.status} — ${body.slice(0, 200)}`);
  }
  const data = await res.json();

  const refreshed: MetaTokens = {
    access_token: data.access_token,
    expires_at: Date.now() + Number(data.expires_in || 5184000) * 1000,
    refreshed_at: Date.now(),
    ig_business_id: tokens.ig_business_id,
    page_id: tokens.page_id,
  };
  saveTokens(refreshed);
  return refreshed;
}

// ── Insights (cached, 24h TTL) ─────────────────────────────────────────────

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

export function loadInsightsCache(): InsightsCache | null {
  if (!fs.existsSync(INSIGHTS_CACHE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(INSIGHTS_CACHE_FILE, 'utf-8')); }
  catch { return null; }
}

function saveInsightsCache(c: InsightsCache): void {
  ensureDir();
  fs.writeFileSync(INSIGHTS_CACHE_FILE, JSON.stringify(c, null, 2), 'utf-8');
}

export async function fetchInsights(token: string, igId: string, force = false): Promise<InsightsCache> {
  if (!force) {
    const cached = loadInsightsCache();
    if (cached && Date.now() - cached.fetched_at < CACHE_TTL) return cached;
  }

  // Basic account info
  const profile = await graphGet(`/${igId}`, token, {
    fields: 'followers_count,media_count',
  });

  // Recent media for engagement calculation
  const media = await graphGet(`/${igId}/media`, token, {
    fields: 'like_count,comments_count',
    limit: '25',
  });

  const items: Array<{ likes: number; comments: number }> = [];
  for (const m of media.data || []) {
    items.push({
      likes: m.like_count ?? 0,
      comments: m.comments_count ?? 0,
    });
  }

  const totalLikes = items.reduce((s, i) => s + i.likes, 0);
  const totalComments = items.reduce((s, i) => s + i.comments, 0);
  const avgLikes = items.length ? Math.round(totalLikes / items.length) : 0;
  const avgComments = items.length ? Math.round(totalComments / items.length * 10) / 10 : 0;
  const followers = profile.followers_count ?? 0;
  const engagementRate = followers > 0 && items.length > 0
    ? Math.round((totalLikes + totalComments) / items.length / followers * 10000) / 100
    : 0;

  const cache: InsightsCache = {
    fetched_at: Date.now(),
    followers_count: followers,
    media_count: profile.media_count ?? 0,
    engagement_rate: engagementRate,
    recent_avg_likes: avgLikes,
    recent_avg_comments: avgComments,
  };
  saveInsightsCache(cache);
  return cache;
}

// ── Media (cached, 24h TTL) ────────────────────────────────────────────────

function loadMediaCache(): MediaCache | null {
  if (!fs.existsSync(MEDIA_CACHE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(MEDIA_CACHE_FILE, 'utf-8')); }
  catch { return null; }
}

function saveMediaCache(c: MediaCache): void {
  ensureDir();
  fs.writeFileSync(MEDIA_CACHE_FILE, JSON.stringify(c, null, 2), 'utf-8');
}

export async function fetchMedia(token: string, igId: string, force = false): Promise<MediaItem[]> {
  if (!force) {
    const cached = loadMediaCache();
    if (cached && Date.now() - cached.fetched_at < CACHE_TTL) return cached.items;
  }

  const res = await graphGet(`/${igId}/media`, token, {
    fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
    limit: '50',
  });

  const items: MediaItem[] = [];
  for (const m of res.data || []) {
    const likes = m.like_count ?? 0;
    const comments = m.comments_count ?? 0;
    items.push({
      id: m.id,
      caption: m.caption || '',
      media_type: m.media_type || 'IMAGE',
      media_url: m.media_url || undefined,
      thumbnail_url: m.thumbnail_url || undefined,
      permalink: m.permalink || '',
      timestamp: m.timestamp || '',
      like_count: likes,
      comments_count: comments,
      engagement: likes + comments,
    });
  }

  saveMediaCache({ fetched_at: Date.now(), items });
  return items;
}

// ── Drafts ─────────────────────────────────────────────────────────────────

function draftPath(id: string): string { return path.join(DRAFTS_DIR, `${id}.json`); }

export function createDraft(data: Partial<InstaDraft> & { caption: string }): InstaDraft {
  ensureDir();
  const now = new Date().toISOString();
  const id = `insta-${Date.now().toString(36)}`;
  const draft: InstaDraft = {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'entwurf',
    caption: data.caption,
    hashtags: data.hashtags || [],
    scheduledFor: data.scheduledFor,
    planNr: data.planNr,
    mediaPath: data.mediaPath,
    notes: data.notes,
  };
  fs.writeFileSync(draftPath(id), JSON.stringify(draft, null, 2), 'utf-8');
  return draft;
}

export function loadDraft(id: string): InstaDraft | null {
  const p = draftPath(id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { return null; }
}

export function saveDraft(d: InstaDraft): void {
  ensureDir();
  d.updatedAt = new Date().toISOString();
  fs.writeFileSync(draftPath(d.id), JSON.stringify(d, null, 2), 'utf-8');
}

export function listDrafts(status?: InstaDraft['status'], limit = 20): InstaDraft[] {
  ensureDir();
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  const files = fs.readdirSync(DRAFTS_DIR).filter(f => f.endsWith('.json'));
  const out: InstaDraft[] = [];
  for (const f of files) {
    try {
      const d: InstaDraft = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf-8'));
      if (!d?.id || !d?.status) continue;
      if (status && d.status !== status) continue;
      out.push(d);
    } catch { /* ignore broken draft file */ }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out.slice(0, limit);
}

// ── Content Calendar ───────────────────────────────────────────────────────

export function loadCalendar(): ContentCalendar | null {
  if (!fs.existsSync(CALENDAR_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf-8')); }
  catch { return null; }
}

export function saveCalendar(cal: ContentCalendar): void {
  ensureDir();
  fs.writeFileSync(CALENDAR_FILE, JSON.stringify(cal, null, 2), 'utf-8');
}

// ── Phase 2 Stubs (Publishing) ─────────────────────────────────────────────
// TODO Phase 2: Auto-Posting
// export async function publishDraft(draft: InstaDraft, token: string, igId: string): Promise<string> { ... }
// export async function uploadMedia(imagePath: string, token: string, igId: string, caption: string): Promise<string> { ... }
