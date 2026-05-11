import fs from 'fs';
import path from 'path';
import { generateDraftId } from './instagram-content-engine.js';
import * as audit from './src/shared/audit/index.js';
import { query as dbQuery, getClient } from './src/shared/db/index.js';

// ── Zod-style validation (Spec §3.6) ───────────────────────────────────────

interface MediaFile {
  path: string;
  type: 'image' | 'video';
  order: number;
}

const VALID_DRAFT_STATUSES = ['draft', 'review', 'approved', 'published', 'archived'] as const;
type DraftStatus = typeof VALID_DRAFT_STATUSES[number];

const VALID_MEDIA_TYPES = ['image', 'video', 'carousel', 'reel'] as const;
type MediaType = typeof VALID_MEDIA_TYPES[number];

function validateMediaFile(mf: unknown, idx: number): string | null {
  if (!mf || typeof mf !== 'object') return `media_files[${idx}]: not an object`;
  const o = mf as Record<string, unknown>;
  if (typeof o.path !== 'string' || o.path.length === 0) return `media_files[${idx}].path: must be non-empty string`;
  if (o.path.startsWith('/')) return `media_files[${idx}].path: must be relative (starts with /)`;
  if (o.path.includes('..')) return `media_files[${idx}].path: must not contain ..`;
  if (o.type !== 'image' && o.type !== 'video') return `media_files[${idx}].type: must be image|video`;
  if (typeof o.order !== 'number' || !Number.isInteger(o.order) || o.order < 0) return `media_files[${idx}].order: must be non-negative integer`;
  return null;
}

function validateDraftFields(data: {
  status?: string;
  media_type?: string;
  media_files?: unknown[];
}): void {
  if (data.status && !VALID_DRAFT_STATUSES.includes(data.status as DraftStatus)) {
    throw new Error(`Invalid status "${data.status}". Must be one of: ${VALID_DRAFT_STATUSES.join(', ')}`);
  }
  if (data.media_type && !VALID_MEDIA_TYPES.includes(data.media_type as MediaType)) {
    throw new Error(`Invalid media_type "${data.media_type}". Must be one of: ${VALID_MEDIA_TYPES.join(', ')}`);
  }
  if (data.media_files) {
    for (let i = 0; i < data.media_files.length; i++) {
      const err = validateMediaFile(data.media_files[i], i);
      if (err) throw new Error(err);
    }
  }
}

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
  media_url?: string;
  thumbnail_url?: string;
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
  status: 'draft' | 'review' | 'approved' | 'published' | 'archived';
  caption: string;
  hashtags: string[];
  media_type: string;
  media_files: MediaFile[];
  vision_analysis?: unknown;
  source_session_id?: string;
  scheduledFor?: string;    // kept for compat but not in DB
  planNr?: number;          // kept for compat but not in DB
  mediaPath?: string;       // kept for compat — not in DB, derived from media_files
  notes?: string;           // kept for compat but not in DB
  approved_at?: string;
  approved_by?: string;
  published_at?: string;
  meta_post_id?: string;
  instagram_post_id?: string;  // alias for meta_post_id
  instagram_url?: string;
  publish_error?: string;
  failed_at?: string;
  failure_reason?: string;
}

export interface ContentCalendarEntry {
  nr: number;
  date: string;             // ISO date
  topic: string;
  format: string;
  caption_idea: string;
  hashtags: string[];
  notes?: string;
}

export interface ContentCalendar {
  generated_at: string;     // ISO 8601
  entries: ContentCalendarEntry[];
}

// ── Paths (for caches that remain file-based) ───────────────────────────────

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
const GRAPH_OAUTH_BASE = 'https://graph.facebook.com';

async function graphGet(endpoint: string, token: string, params?: Record<string, string>): Promise<any> {
  return withRetry(async () => {
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
  }, `GET ${endpoint}`);
}

async function graphPost(
  endpoint: string,
  token: string,
  params: Record<string, string>,
): Promise<any> {
  return withRetry(async () => {
    const url = `${GRAPH_BASE}${endpoint}`;
    const body = new URLSearchParams({ access_token: token, ...params });
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, 15000);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Meta Graph API POST ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }, `POST ${endpoint}`);
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const delays = [2000, 5000, 10000];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const isNetwork = e.message?.includes('fetch_timeout') ||
        e.message?.includes('ECONNRESET') ||
        e.message?.includes('ENOTFOUND') ||
        e.message?.includes('ETIMEDOUT') ||
        e.message?.includes('socket hang up');
      if (!isNetwork || attempt === 2) throw e;
      console.log(`[instagram-store] ${label}: Netzwerkfehler (Versuch ${attempt + 1}/3), Retry in ${delays[attempt]}ms`);
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
  throw new Error('unreachable');
}

async function pollContainerStatus(
  containerId: string,
  token: string,
  maxWaitMs: number,
): Promise<{ status: string; id: string }> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const data = await graphGet(`/${containerId}`, token, { fields: 'status_code' });
    const status = data.status_code;
    if (status === 'FINISHED') return { status, id: containerId };
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Container ${containerId} failed: ${status}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Container ${containerId} timed out after ${maxWaitMs}ms`);
}

// ── Publishing ─────────────────────────────────────────────────────────────

async function enforceRateLimit(token: string, igBusinessId: string): Promise<void> {
  const { withinLimit, quota, used } = await checkPublishingLimit(token, igBusinessId);
  if (!withinLimit) {
    throw new Error(`Instagram Rate-Limit erreicht (${used}/${quota} Posts in 24h). Bitte später erneut versuchen.`);
  }
}

export async function publishSingleImage(
  token: string,
  igBusinessId: string,
  imageUrl: string,
  caption: string,
): Promise<{ postId: string; permalink: string }> {
  await enforceRateLimit(token, igBusinessId);
  const container = await graphPost(`/${igBusinessId}/media`, token, {
    image_url: imageUrl,
    caption,
  });
  const containerId = container.id;
  await pollContainerStatus(containerId, token, 60_000);
  const published = await graphPost(`/${igBusinessId}/media_publish`, token, {
    creation_id: containerId,
  });
  const postId = published.id;
  const post = await graphGet(`/${postId}`, token, { fields: 'permalink' });
  return { postId, permalink: post.permalink };
}

export async function publishCarousel(
  token: string,
  igBusinessId: string,
  items: Array<{ url: string; type: 'image' | 'video' }>,
  caption: string,
): Promise<{ postId: string; permalink: string }> {
  await enforceRateLimit(token, igBusinessId);
  const childIds: string[] = [];
  for (const item of items) {
    const params: Record<string, string> = { is_carousel_item: 'true' };
    if (item.type === 'video') {
      params.media_type = 'VIDEO';
      params.video_url = item.url;
    } else {
      params.image_url = item.url;
    }
    const child = await graphPost(`/${igBusinessId}/media`, token, params);
    childIds.push(child.id);
  }
  for (let i = 0; i < childIds.length; i++) {
    const timeoutMs = items[i].type === 'video' ? 300_000 : 60_000;
    await pollContainerStatus(childIds[i], token, timeoutMs);
  }
  const carousel = await graphPost(`/${igBusinessId}/media`, token, {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption,
  });
  const carouselId = carousel.id;
  await pollContainerStatus(carouselId, token, 60_000);
  const published = await graphPost(`/${igBusinessId}/media_publish`, token, {
    creation_id: carouselId,
  });
  const postId = published.id;
  const post = await graphGet(`/${postId}`, token, { fields: 'permalink' });
  return { postId, permalink: post.permalink };
}

export async function publishReel(
  token: string,
  igBusinessId: string,
  videoUrl: string,
  caption: string,
): Promise<{ postId: string; permalink: string }> {
  await enforceRateLimit(token, igBusinessId);
  const container = await graphPost(`/${igBusinessId}/media`, token, {
    video_url: videoUrl,
    caption,
    media_type: 'REELS',
  });
  const containerId = container.id;
  await pollContainerStatus(containerId, token, 300_000);
  const published = await graphPost(`/${igBusinessId}/media_publish`, token, {
    creation_id: containerId,
  });
  const postId = published.id;
  const post = await graphGet(`/${postId}`, token, { fields: 'permalink' });
  return { postId, permalink: post.permalink };
}

export async function checkPublishingLimit(
  token: string,
  igBusinessId: string,
): Promise<{ withinLimit: boolean; quota: number; used: number }> {
  const data = await graphGet(`/${igBusinessId}/content_publishing_limit`, token);
  const used = data.data?.[0]?.quota_usage ?? 0;
  const quota = data.data?.[0]?.config?.quota_total ?? 25;
  return { withinLimit: used < quota, quota, used };
}

// ── Token Management (DB-backed) ──────────────────────────────────────────

/** Load active token from DB. Falls back to JSON file for migration compat. */
export function loadTokens(): MetaTokens | null {
  // Sync wrapper — try DB first, fall back to file
  // Note: DB operations are async. For sync callers, we cache.
  return _tokenCache;
}

let _tokenCache: MetaTokens | null = null;

/** Async token loader from DB. */
export async function loadTokensAsync(): Promise<MetaTokens | null> {
  try {
    const { rows } = await dbQuery<{
      access_token: string;
      expires_at: Date;
      rotated_at: Date;
    }>('SELECT access_token, expires_at, rotated_at FROM insta_tokens WHERE active = true LIMIT 1');
    if (rows.length === 0) {
      // Fallback to JSON file (pre-migration)
      return _loadTokensFromFile();
    }
    const row = rows[0];
    // We need ig_business_id and page_id from env or JSON file
    const fileFallback = _loadTokensFromFile();
    const t: MetaTokens = {
      access_token: row.access_token,
      expires_at: new Date(row.expires_at).getTime(),
      refreshed_at: new Date(row.rotated_at).getTime(),
      ig_business_id: fileFallback?.ig_business_id || process.env.IG_BUSINESS_ID || '',
      page_id: fileFallback?.page_id || process.env.IG_PAGE_ID || '',
    };
    _tokenCache = t;
    return t;
  } catch {
    return _loadTokensFromFile();
  }
}

function _loadTokensFromFile(): MetaTokens | null {
  if (!fs.existsSync(TOKENS_FILE)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    _tokenCache = t;
    return t;
  } catch { return null; }
}

// Initialize cache on load
_loadTokensFromFile();

export function saveTokens(t: MetaTokens): void {
  _tokenCache = t;
  ensureDir();
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2), 'utf-8');
}

/** Save token to DB (new row with active=true, deactivate old). */
export async function saveTokensToDb(t: MetaTokens): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE insta_tokens SET active = false WHERE active = true');
    await client.query(
      'INSERT INTO insta_tokens (access_token, expires_at, active, rotated_at) VALUES ($1, $2, true, now())',
      [t.access_token, new Date(t.expires_at)],
    );
    await client.query('COMMIT');
    _tokenCache = t;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // Also save to JSON file for backward compat
  saveTokens(t);
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

export function markTokenFailed(): void {
  const tokens = loadTokens();
  if (!tokens) return;
  tokens.refreshed_at = 0;
  saveTokens(tokens);
  console.log('[instagram-store] Token als fehlgeschlagen markiert — nächster Refresh wird erzwungen');
}

export async function ensureFreshToken(appId: string, appSecret: string, force = false): Promise<MetaTokens> {
  const tokens = await loadTokensAsync() || loadTokens();
  if (!tokens) throw new Error('Instagram nicht autorisiert — Token fehlt.');

  const daysSinceRefresh = (Date.now() - (tokens.refreshed_at || 0)) / 86_400_000;
  if (!force && daysSinceRefresh < 7) return tokens;

  console.log(`[instagram-store] Token-Refresh${force ? ' (erzwungen)' : ''}: ${daysSinceRefresh.toFixed(1)} Tage seit letztem Refresh, ${tokenDaysRemaining()} Tage bis Ablauf`);
  const url = new URL(`${GRAPH_OAUTH_BASE}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', tokens.access_token);

  const res = await fetchWithTimeout(url.toString(), { method: 'GET' }, 15000);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (body.includes('"code":101') || body.includes('"code": 101')) {
      console.warn('[instagram-store] Token-Refresh übersprungen (App-Secret ungültig, Code 101) — verwende bestehenden Token');
      return tokens;
    }
    if (body.includes('"code":190') || body.includes('"code": 190')) {
      console.error('[instagram-store] Token auf Meta-Seite abgelaufen (Code 190) — neuer Token aus Meta Developer Portal nötig');
      throw new Error('Instagram Token abgelaufen (Code 190) — neuer Token aus Meta Developer Portal nötig');
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

  // Save to both DB and file
  try {
    await saveTokensToDb(refreshed);
  } catch {
    saveTokens(refreshed); // DB not ready yet? save file only
  }

  // Update env file
  try {
    const envPath = path.join(process.env.HOME || '/root', '.config/openclaw/env');
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const updatedEnv = envContent.replace(
      /^INSTAGRAM_ACCESS_TOKEN=.*$/m,
      `INSTAGRAM_ACCESS_TOKEN=${data.access_token}`
    );
    if (updatedEnv !== envContent) {
      fs.writeFileSync(envPath, updatedEnv);
      console.log('[instagram-store] Token in ~/.config/openclaw/env aktualisiert');
    }
  } catch (envErr: any) {
    console.warn(`[instagram-store] Env-Update fehlgeschlagen (Token nur in tokens.json): ${envErr.message}`);
  }

  audit.log({ module: 'auth', action: 'auth.token_rotated', entityType: 'token', entityId: 'meta_instagram', after: { expires_at: new Date(refreshed.expires_at).toISOString().slice(0, 10), forced: force } }).catch(() => {});
  console.log(`[instagram-store] Token erfolgreich erneuert — gültig bis ${new Date(refreshed.expires_at).toISOString().slice(0, 10)}`);
  return refreshed;
}

// ── Token Health (for endpoints) ──────────────────────────────────────────

export async function getTokenHealth(): Promise<{
  expires_at: string;
  days_remaining: number;
  status: 'ok' | 'warn' | 'critical';
}> {
  const tokens = await loadTokensAsync() || loadTokens();
  if (!tokens) return { expires_at: '', days_remaining: 0, status: 'critical' };
  const daysRemaining = Math.max(0, Math.round((tokens.expires_at - Date.now()) / 86_400_000));
  let status: 'ok' | 'warn' | 'critical' = 'ok';
  if (daysRemaining <= 0) status = 'critical';
  else if (daysRemaining <= 7) status = 'warn';
  return {
    expires_at: new Date(tokens.expires_at).toISOString(),
    days_remaining: daysRemaining,
    status,
  };
}

// ── Insights (cached, 24h TTL, FILE-BASED) ──────────────────────────────────

const CACHE_TTL = 24 * 60 * 60 * 1000;

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

  const profile = await graphGet(`/${igId}`, token, {
    fields: 'followers_count,media_count',
  });

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

// ── Media (cached, 24h TTL, FILE-BASED) ──────────────────────────────────

export function loadMediaCache(): MediaCache | null {
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

// ── Drafts (DB-backed) ──────────────────────────────────────────────────────

function rowToDraft(row: any): InstaDraft {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    status: row.status,
    caption: row.caption || '',
    hashtags: row.hashtags || [],
    media_type: row.media_type || 'image',
    media_files: typeof row.media_files === 'string' ? JSON.parse(row.media_files) : (row.media_files || []),
    vision_analysis: row.vision_analysis || undefined,
    source_session_id: row.source_session_id || undefined,
    approved_at: row.approved_at ? new Date(row.approved_at).toISOString() : undefined,
    approved_by: row.approved_by || undefined,
    published_at: row.published_at ? new Date(row.published_at).toISOString() : undefined,
    meta_post_id: row.meta_post_id || undefined,
    instagram_post_id: row.meta_post_id || undefined,
    failed_at: row.failed_at ? new Date(row.failed_at).toISOString() : undefined,
    failure_reason: row.failure_reason || undefined,
  };
}

export function createDraft(data: Partial<InstaDraft> & { caption: string }): InstaDraft {
  const now = new Date().toISOString();
  const id = generateDraftId(data.caption);
  const status: DraftStatus = 'draft';
  const media_type = data.media_type || 'image';
  const media_files = data.media_files || [];

  validateDraftFields({ status, media_type, media_files });

  const draft: InstaDraft = {
    id,
    createdAt: now,
    updatedAt: now,
    status,
    caption: data.caption,
    hashtags: data.hashtags || [],
    media_type,
    media_files,
  };

  // Always write to file synchronously (backward compat + sync callers)
  ensureDir();
  fs.writeFileSync(path.join(DRAFTS_DIR, `${id}.json`), JSON.stringify(draft, null, 2), 'utf-8');

  // Async DB insert — fire and forget
  dbQuery(
    `INSERT INTO insta_drafts (id, status, caption, hashtags, media_type, media_files, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (id) DO NOTHING`,
    [id, status, data.caption, data.hashtags || [], media_type, JSON.stringify(media_files), now],
  ).catch(err => {
    console.error(`[instagram-store] DB insert draft failed: ${err.message}`);
  });

  return draft;
}

export function loadDraft(id: string): InstaDraft | null {
  // Sync: try file first for backward compat during migration
  const p = path.join(DRAFTS_DIR, `${id}.json`);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch { /* fall through to DB */ }
  }
  return null;
}

/** Async draft loader from DB. */
export async function loadDraftAsync(id: string): Promise<InstaDraft | null> {
  try {
    const { rows } = await dbQuery('SELECT * FROM insta_drafts WHERE id = $1', [id]);
    if (rows.length > 0) return rowToDraft(rows[0]);
  } catch { /* DB not ready, fallback */ }
  return loadDraft(id);
}

/**
 * Validate that a draft is approved for publishing.
 * Throws 'approval required' if draft status is not 'approved'.
 * This is the Approval-Hard-Rule per spec §17.2.
 */
export function validateDraftApproval(draft: InstaDraft): void {
  if (draft.status !== 'approved') {
    throw new Error('approval required');
  }
}

/**
 * Load a draft and validate approval. Throws on missing draft or missing approval.
 * Used by /instapost command and tested by approval-hard-rule test (spec §17.2).
 */
export async function publish(draftId: string): Promise<InstaDraft> {
  const draft = await loadDraftAsync(draftId) || loadDraft(draftId);
  if (!draft) throw new Error(`Draft "${draftId}" not found`);
  if (draft.status === 'published') throw new Error('already published');
  validateDraftApproval(draft);
  return draft;
}

export function saveDraft(d: InstaDraft): void {
  d.updatedAt = new Date().toISOString();
  // Async DB update
  dbQuery(
    `UPDATE insta_drafts SET
      status=$2, caption=$3, hashtags=$4, media_type=$5, media_files=$6,
      vision_analysis=$7, source_session_id=$8,
      approved_at=$9, approved_by=$10, published_at=$11, meta_post_id=$12,
      failed_at=$13, failure_reason=$14, updated_at=$15
     WHERE id=$1`,
    [
      d.id, d.status, d.caption, d.hashtags, d.media_type || 'image',
      JSON.stringify(d.media_files || []),
      d.vision_analysis ? JSON.stringify(d.vision_analysis) : null,
      d.source_session_id || null,
      d.approved_at || null, d.approved_by || null,
      d.published_at || null, d.meta_post_id || d.instagram_post_id || null,
      d.failed_at || null, d.failure_reason || d.publish_error || null,
      d.updatedAt,
    ],
  ).catch(err => {
    console.error(`[instagram-store] DB update draft failed: ${err.message}`);
  });

  // Also write to file for backward compat
  ensureDir();
  fs.writeFileSync(path.join(DRAFTS_DIR, `${d.id}.json`), JSON.stringify(d, null, 2), 'utf-8');
}

export function listDrafts(status?: InstaDraft['status'], limit = 20): InstaDraft[] {
  // Sync: read from files (DB is async, this stays sync for backward compat)
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
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out.slice(0, limit);
}

/** Async draft lister from DB. */
export async function listDraftsAsync(status?: string, limit = 20): Promise<InstaDraft[]> {
  try {
    const params: unknown[] = [];
    let sql = 'SELECT * FROM insta_drafts';
    if (status) {
      sql += ' WHERE status = $1';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC';
    if (limit > 0) {
      sql += ` LIMIT ${limit}`;
    }
    const { rows } = await dbQuery(sql, params);
    return rows.map(rowToDraft);
  } catch {
    return listDrafts(status as any, limit);
  }
}

// ── Content Calendar (FILE-BASED) ────────────────────────────────────────────

export function loadCalendar(): ContentCalendar | null {
  if (!fs.existsSync(CALENDAR_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf-8')); }
  catch { return null; }
}

export function saveCalendar(cal: ContentCalendar): void {
  ensureDir();
  fs.writeFileSync(CALENDAR_FILE, JSON.stringify(cal, null, 2), 'utf-8');
}

// ── Style Profile v2 (DB-backed with file fallback) ────────────────────────

// Sub-types (unchanged)

export interface PillarContentIdea {
  format: string;
  idea: string;
}

export interface Pillar {
  id: 'culture' | 'technology' | 'style' | 'health' | 'freedom';
  name: string;
  description: string;
  good_examples: string[];
  bad_examples: string[];
  content_ideas: PillarContentIdea[];
  example_caption: string;
}

export interface DoRule {
  id: number;
  title: string;
  rule: string;
  good_example: string;
  bad_example?: string;
  rationale: string;
  subtitle_format?: Record<string, any>;
}

export interface DontRule {
  id: number;
  title: string;
  bad_examples: string[];
  alternative: string;
  rationale: string;
}

export interface SignaturePhrase {
  phrase: string;
  tone: string;
  use_case: string;
}

export interface ContentFormat {
  id: string;
  name: string;
  purpose: string;
  structure: string[];
  example: string;
}

export interface CaptionTemplate {
  id: string;
  name: string;
  structure: string;
  example: string;
}

export interface StoryFormat {
  id: string;
  name: string;
  example: string;
}

export interface ReferenceAccount {
  name: string;
  relevance: string;
  patterns: string[];
  lessons: string[];
}

export interface ContentExample {
  category: string;
  hook: string;
  caption: string;
  hashtags: string[];
}

export interface StyleProfile {
  version: string;
  schema_version: number;
  updated: string;
  meta: {
    name: string;
    stylebook_version: string;
    owner: string;
    principle: string;
  };
  positioning: {
    bio_recommended: Record<string, string>;
    brand_core: Record<string, string>;
    perception_goals: string[];
    non_positioning: string[];
  };
  voice: {
    core_adjectives: string[];
    extended_tone: string[];
    good_examples: string[];
    bad_examples: string[];
  };
  main_formula: {
    rule: string;
    fields: string[];
    min_match_count: number;
  };
  pillars: Pillar[];
  signature_phrases: {
    en: SignaturePhrase[];
    de: SignaturePhrase[];
  };
  cannabis_rules: {
    share_target_percent: number;
    role_includes: string[];
    role_excludes: string[];
    good_angles: string[];
    bad_angles: string[];
  };
  dos: DoRule[];
  donts: DontRule[];
  visual_identity: {
    style_summary: string;
    look_principles: string[];
    primary_colors: string[];
    accent_colors: Array<{ color: string; use: string }>;
    fonts_primary: string[];
    fonts_fallback: string[];
    fonts_avoid: string[];
    good_motifs: string[];
    bad_motifs: string[];
  };
  language: {
    primary: string;
    available: string[];
    topic_language_map: Record<string, string[]>;
    subtitle_default: string;
    subtitle_rule: string;
  };
  posting_rhythm: {
    frequency: Record<string, any>;
    content_mix_percent: Record<string, any>;
    timing_test_windows: Record<string, string>;
    timing_rule: string;
  };
  weekly_structure: Array<{ day: string; format: string; topic: string; effort: string }>;
  weekly_redaction_rule: string[];
  formats: ContentFormat[];
  caption_templates: CaptionTemplate[];
  reel_rules: {
    length_seconds: Record<string, any>;
    structure: string[];
  };
  story_rules: {
    purpose: string[];
    tone_note: string;
    formats: StoryFormat[];
  };
  hashtag_strategy: {
    count_per_post: [number, number];
    placement: string;
    structure_per_post: Record<string, any>;
    pools: Record<string, string[]>;
  };
  interaction_rules: {
    comments: Record<string, any>;
    dms: Record<string, any>;
  };
  manychat: {
    principle: string;
    triggers: Array<{ keyword: string; response: string | null }>;
    no_gos: string[];
    default_phrasing: string;
  };
  kpis: {
    primary: Array<{ name: string; meaning: string }>;
    anti_goals: string[];
    real_goals: string[];
  };
  content_examples: ContentExample[];
  reference_accounts: ReferenceAccount[];
  checklist: string[];
  traffic_light: {
    green: string[];
    yellow: string[];
    red: string[];
  };
  ai_generator_prompt: string;
}

const STYLE_PROFILE_FILE = path.join(INSTA_DIR, 'style-profile.json');

const REQUIRED_PILLAR_IDS = ['culture', 'technology', 'style', 'health', 'freedom'] as const;

export function loadStyleProfile(): StyleProfile {
  // Always load from file — DB stores it as JSONB but file is source of truth for now
  if (!fs.existsSync(STYLE_PROFILE_FILE)) {
    throw new Error('Style-Profil nicht gefunden. Datei anlegen unter: artifacts/personal/instagram/style-profile.json');
  }
  try {
    const data = JSON.parse(fs.readFileSync(STYLE_PROFILE_FILE, 'utf-8'));
    const sv = data?.schema_version;
    if (sv !== 2) {
      throw new Error(`Style-Profil v2 erwartet, gefunden v${sv ?? '1 (legacy)'}. Bitte Datei auf schema_version: 2 migrieren.`);
    }
    return data as StyleProfile;
  } catch (e: any) {
    if (e.message.includes('v2 erwartet') || e.message.includes('nicht gefunden')) throw e;
    throw new Error(`Style-Profil laden fehlgeschlagen: ${e.message}`);
  }
}

export function saveStyleProfile(profile: StyleProfile): void {
  try {
    ensureDir();
    profile.updated = new Date().toISOString();
    fs.writeFileSync(STYLE_PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf-8');
    // Also update DB
    dbQuery(
      `UPDATE insta_style_profile SET profile = $1, updated_at = now() WHERE active = true`,
      [JSON.stringify(profile)],
    ).catch(() => {});
  } catch (e: any) {
    console.error('[instagram-store] Style-Profil speichern fehlgeschlagen:', e.message);
    throw e;
  }
}

export function validateStyleProfile(data: any): string | null {
  if (!data || typeof data !== 'object') return 'JSON muss ein Objekt sein';
  if (data.schema_version !== 2) return `schema_version muss 2 sein (gefunden: ${data.schema_version ?? 'fehlt'})`;

  const requiredFields = [
    'version', 'schema_version', 'meta', 'positioning', 'voice',
    'main_formula', 'pillars', 'signature_phrases', 'cannabis_rules',
    'dos', 'donts', 'visual_identity', 'language', 'posting_rhythm',
    'weekly_structure', 'weekly_redaction_rule', 'formats',
    'caption_templates', 'reel_rules', 'story_rules', 'hashtag_strategy',
    'interaction_rules', 'manychat', 'kpis', 'content_examples',
    'reference_accounts', 'checklist', 'traffic_light', 'ai_generator_prompt',
  ];
  for (const f of requiredFields) {
    if (data[f] === undefined || data[f] === null) return `Pflichtfeld fehlt: ${f}`;
  }

  if (!data.meta?.name) return 'meta.name fehlt';
  if (!data.meta?.principle) return 'meta.principle fehlt';

  if (!Array.isArray(data.voice?.core_adjectives) || data.voice.core_adjectives.length === 0) {
    return 'voice.core_adjectives muss ein nicht-leeres Array sein';
  }

  if (!Array.isArray(data.pillars)) return 'pillars muss ein Array sein';
  if (data.pillars.length !== 5) return `pillars: genau 5 Eintraege erwartet, ${data.pillars.length} gefunden`;
  for (let i = 0; i < REQUIRED_PILLAR_IDS.length; i++) {
    const expected = REQUIRED_PILLAR_IDS[i];
    const pillar = data.pillars.find((p: any) => p.id === expected);
    if (!pillar) return `pillars: Eintrag mit id "${expected}" fehlt`;
    if (!pillar.name) return `pillars[${expected}].name fehlt`;
    if (!pillar.description) return `pillars[${expected}].description fehlt`;
    if (!Array.isArray(pillar.content_ideas)) return `pillars[${expected}].content_ideas fehlt`;
    if (!pillar.example_caption) return `pillars[${expected}].example_caption fehlt`;
  }

  if (!Array.isArray(data.dos)) return 'dos muss ein Array sein';
  if (data.dos.length !== 8) return `dos: genau 8 Eintraege erwartet, ${data.dos.length} gefunden`;
  for (let i = 0; i < data.dos.length; i++) {
    const d = data.dos[i];
    if (!d.title) return `dos[${i}].title fehlt`;
    if (!d.rule) return `dos[${i}].rule fehlt`;
  }

  if (!Array.isArray(data.donts)) return 'donts muss ein Array sein';
  if (data.donts.length !== 8) return `donts: genau 8 Eintraege erwartet, ${data.donts.length} gefunden`;
  for (let i = 0; i < data.donts.length; i++) {
    const d = data.donts[i];
    if (!d.title) return `donts[${i}].title fehlt`;
    if (!d.alternative) return `donts[${i}].alternative fehlt`;
  }

  if (!Array.isArray(data.formats)) return 'formats muss ein Array sein';
  if (data.formats.length < 5) return `formats: mindestens 5 erwartet, ${data.formats.length} gefunden`;

  if (!data.language?.primary) return 'language.primary fehlt';
  if (!Array.isArray(data.language?.available)) return 'language.available fehlt';

  if (!Array.isArray(data.hashtag_strategy?.count_per_post)) return 'hashtag_strategy.count_per_post fehlt';
  if (!data.hashtag_strategy?.pools) return 'hashtag_strategy.pools fehlt';

  return null;
}

export function getStyleProfileSummary(): string {
  const p = loadStyleProfile();
  const lines: string[] = [];

  lines.push(`Style-Profil: ${p.meta.name}`);
  lines.push(`Version ${p.version} | Stand: ${p.updated?.slice(0, 10) || '?'}`);
  lines.push('');

  lines.push('Voice');
  lines.push(p.voice.core_adjectives.join(' | '));
  if (p.voice.extended_tone?.length) {
    lines.push(p.voice.extended_tone.slice(0, 4).join(' | '));
  }
  lines.push('');

  lines.push('Pillars');
  lines.push(p.pillars.map(pi => pi.name).join(' | '));
  lines.push('');

  lines.push('Cannabis-Anteil');
  lines.push(`Ziel: ${p.cannabis_rules.share_target_percent}%`);
  lines.push('');

  lines.push(`Dos (${p.dos.length})`);
  lines.push(p.dos.slice(0, 3).map(d => d.title).join(' | '));
  if (p.dos.length > 3) lines.push(`... +${p.dos.length - 3} weitere`);
  lines.push('');

  lines.push(`Donts (${p.donts.length})`);
  lines.push(p.donts.slice(0, 3).map(d => d.title).join(' | '));
  if (p.donts.length > 3) lines.push(`... +${p.donts.length - 3} weitere`);
  lines.push('');

  lines.push('Sprachen');
  lines.push(p.language.available.join(' | '));
  lines.push('');

  const hs = p.hashtag_strategy;
  const poolCount = Object.keys(hs.pools || {}).length;
  lines.push('Hashtag-Strategie');
  lines.push(`${hs.count_per_post[0]}-${hs.count_per_post[1]} pro Post | ${poolCount} Pools`);
  lines.push('');

  if (p.reference_accounts?.length) {
    lines.push('Reference Accounts');
    lines.push(p.reference_accounts.map(r => r.name).join(' | '));
    lines.push('');
  }

  lines.push('Befehle: /instastyle pillar <id> | dos | donts | export | reload');
  lines.push('Edit via VS Code Remote SSH, dann /instastyle reload');

  const result = lines.join('\n');
  return result.length > 3500 ? result.slice(0, 3497) + '...' : result;
}
