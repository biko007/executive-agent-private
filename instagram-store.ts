import fs from 'fs';
import path from 'path';
import { generateDraftId } from './instagram-content-engine.js';

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
  status: 'entwurf' | 'freigegeben' | 'veröffentlicht';
  caption: string;
  hashtags: string[];
  scheduledFor?: string;    // ISO date
  planNr?: number;
  mediaPath?: string;
  notes?: string;
  published_at?: string;       // ISO 8601 — wann veröffentlicht
  instagram_post_id?: string;  // Meta Post-ID
  instagram_url?: string;      // Instagram Permalink
  publish_error?: string;      // letzter Fehler bei Veröffentlichung
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
// Token exchange must use unversioned endpoint per Meta docs
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

/** Retry wrapper: 3 attempts with exponential backoff for network/timeout errors. */
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
    // IN_PROGRESS — wait 3s then retry
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
  // 0. Rate-limit check
  await enforceRateLimit(token, igBusinessId);

  // 1. Create media container
  const container = await graphPost(`/${igBusinessId}/media`, token, {
    image_url: imageUrl,
    caption,
  });
  const containerId = container.id;

  // 2. Poll until FINISHED
  await pollContainerStatus(containerId, token, 60_000);

  // 3. Publish
  const published = await graphPost(`/${igBusinessId}/media_publish`, token, {
    creation_id: containerId,
  });
  const postId = published.id;

  // 4. Get permalink
  const post = await graphGet(`/${postId}`, token, { fields: 'permalink' });
  return { postId, permalink: post.permalink };
}

export async function publishCarousel(
  token: string,
  igBusinessId: string,
  items: Array<{ url: string; type: 'image' | 'video' }>,
  caption: string,
): Promise<{ postId: string; permalink: string }> {
  // 0. Rate-limit check
  await enforceRateLimit(token, igBusinessId);

  // 1. Create item containers
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

  // 2. Poll each item container until FINISHED
  for (let i = 0; i < childIds.length; i++) {
    const timeoutMs = items[i].type === 'video' ? 300_000 : 60_000;
    await pollContainerStatus(childIds[i], token, timeoutMs);
  }

  // 3. Create carousel container
  const carousel = await graphPost(`/${igBusinessId}/media`, token, {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption,
  });
  const carouselId = carousel.id;

  // 4. Poll carousel container
  await pollContainerStatus(carouselId, token, 60_000);

  // 5. Publish
  const published = await graphPost(`/${igBusinessId}/media_publish`, token, {
    creation_id: carouselId,
  });
  const postId = published.id;

  // 6. Get permalink
  const post = await graphGet(`/${postId}`, token, { fields: 'permalink' });
  return { postId, permalink: post.permalink };
}

export async function publishReel(
  token: string,
  igBusinessId: string,
  videoUrl: string,
  caption: string,
): Promise<{ postId: string; permalink: string }> {
  // 0. Rate-limit check
  await enforceRateLimit(token, igBusinessId);

  // 1. Create reel container
  const container = await graphPost(`/${igBusinessId}/media`, token, {
    video_url: videoUrl,
    caption,
    media_type: 'REELS',
  });
  const containerId = container.id;

  // 2. Poll until FINISHED (5 min for video processing)
  await pollContainerStatus(containerId, token, 300_000);

  // 3. Publish
  const published = await graphPost(`/${igBusinessId}/media_publish`, token, {
    creation_id: containerId,
  });
  const postId = published.id;

  // 4. Get permalink
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
 * Mark token as failed — forces refresh on next ensureFreshToken() call.
 * Call this when API returns code 190 (session expired).
 */
export function markTokenFailed(): void {
  const tokens = loadTokens();
  if (!tokens) return;
  tokens.refreshed_at = 0; // Force refresh on next call
  saveTokens(tokens);
  console.log('[instagram-store] Token als fehlgeschlagen markiert — nächster Refresh wird erzwungen');
}

/**
 * Refresh long-lived token proactively every 7 days (by age, not remaining time).
 * Meta long-lived tokens can be refreshed any time before expiry.
 * Set force=true to bypass the 7-day cooldown (e.g. after API error 190).
 */
export async function ensureFreshToken(appId: string, appSecret: string, force = false): Promise<MetaTokens> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Instagram nicht autorisiert — Token fehlt.');

  // Refresh if last refresh was > 7 days ago OR forced (e.g. after API error)
  const daysSinceRefresh = (Date.now() - (tokens.refreshed_at || 0)) / 86_400_000;
  if (!force && daysSinceRefresh < 7) return tokens;

  // Refresh via Meta token exchange (unversioned endpoint per Meta docs)
  console.log(`[instagram-store] Token-Refresh${force ? ' (erzwungen)' : ''}: ${daysSinceRefresh.toFixed(1)} Tage seit letztem Refresh, ${tokenDaysRemaining()} Tage bis Ablauf`);
  const url = new URL(`${GRAPH_OAUTH_BASE}/oauth/access_token`);
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
    // Code 190 = session expired — token is dead, can't refresh
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
  saveTokens(refreshed);

  // Persist new token to env file so service restarts keep the refreshed token
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

  console.log(`[instagram-store] Token erfolgreich erneuert — gültig bis ${new Date(refreshed.expires_at).toISOString().slice(0, 10)}`);
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

// ── Drafts ─────────────────────────────────────────────────────────────────

function draftPath(id: string): string { return path.join(DRAFTS_DIR, `${id}.json`); }

export function createDraft(data: Partial<InstaDraft> & { caption: string }): InstaDraft {
  ensureDir();
  const now = new Date().toISOString();
  const id = generateDraftId(data.caption);
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

// ── Style Profile v2 ────────────────────────────────────────────────────────

// Sub-types

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
  } catch (e: any) {
    console.error('[instagram-store] Style-Profil speichern fehlgeschlagen:', e.message);
    throw e;
  }
}

export function validateStyleProfile(data: any): string | null {
  if (!data || typeof data !== 'object') return 'JSON muss ein Objekt sein';
  if (data.schema_version !== 2) return `schema_version muss 2 sein (gefunden: ${data.schema_version ?? 'fehlt'})`;

  // Required top-level fields
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

  // meta
  if (!data.meta?.name) return 'meta.name fehlt';
  if (!data.meta?.principle) return 'meta.principle fehlt';

  // voice
  if (!Array.isArray(data.voice?.core_adjectives) || data.voice.core_adjectives.length === 0) {
    return 'voice.core_adjectives muss ein nicht-leeres Array sein';
  }

  // pillars: exactly 5 with correct ids
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

  // dos: exactly 8
  if (!Array.isArray(data.dos)) return 'dos muss ein Array sein';
  if (data.dos.length !== 8) return `dos: genau 8 Eintraege erwartet, ${data.dos.length} gefunden`;
  for (let i = 0; i < data.dos.length; i++) {
    const d = data.dos[i];
    if (!d.title) return `dos[${i}].title fehlt`;
    if (!d.rule) return `dos[${i}].rule fehlt`;
  }

  // donts: exactly 8
  if (!Array.isArray(data.donts)) return 'donts muss ein Array sein';
  if (data.donts.length !== 8) return `donts: genau 8 Eintraege erwartet, ${data.donts.length} gefunden`;
  for (let i = 0; i < data.donts.length; i++) {
    const d = data.donts[i];
    if (!d.title) return `donts[${i}].title fehlt`;
    if (!d.alternative) return `donts[${i}].alternative fehlt`;
  }

  // formats: at least 5
  if (!Array.isArray(data.formats)) return 'formats muss ein Array sein';
  if (data.formats.length < 5) return `formats: mindestens 5 erwartet, ${data.formats.length} gefunden`;

  // language
  if (!data.language?.primary) return 'language.primary fehlt';
  if (!Array.isArray(data.language?.available)) return 'language.available fehlt';

  // hashtag_strategy
  if (!Array.isArray(data.hashtag_strategy?.count_per_post)) return 'hashtag_strategy.count_per_post fehlt';
  if (!data.hashtag_strategy?.pools) return 'hashtag_strategy.pools fehlt';

  return null;
}

export function getStyleProfileSummary(): string {
  const p = loadStyleProfile();
  const lines: string[] = [];

  // Header
  lines.push(`Style-Profil: ${p.meta.name}`);
  lines.push(`Version ${p.version} | Stand: ${p.updated?.slice(0, 10) || '?'}`);
  lines.push('');

  // Voice
  lines.push('Voice');
  lines.push(p.voice.core_adjectives.join(' | '));
  if (p.voice.extended_tone?.length) {
    lines.push(p.voice.extended_tone.slice(0, 4).join(' | '));
  }
  lines.push('');

  // Pillars
  lines.push('Pillars');
  lines.push(p.pillars.map(pi => pi.name).join(' | '));
  lines.push('');

  // Cannabis
  lines.push('Cannabis-Anteil');
  lines.push(`Ziel: ${p.cannabis_rules.share_target_percent}%`);
  lines.push('');

  // Dos
  lines.push(`Dos (${p.dos.length})`);
  lines.push(p.dos.slice(0, 3).map(d => d.title).join(' | '));
  if (p.dos.length > 3) lines.push(`... +${p.dos.length - 3} weitere`);
  lines.push('');

  // Donts
  lines.push(`Donts (${p.donts.length})`);
  lines.push(p.donts.slice(0, 3).map(d => d.title).join(' | '));
  if (p.donts.length > 3) lines.push(`... +${p.donts.length - 3} weitere`);
  lines.push('');

  // Language
  lines.push('Sprachen');
  lines.push(p.language.available.join(' | '));
  lines.push('');

  // Hashtag Strategy
  const hs = p.hashtag_strategy;
  const poolCount = Object.keys(hs.pools || {}).length;
  lines.push('Hashtag-Strategie');
  lines.push(`${hs.count_per_post[0]}-${hs.count_per_post[1]} pro Post | ${poolCount} Pools`);
  lines.push('');

  // Reference Accounts
  if (p.reference_accounts?.length) {
    lines.push('Reference Accounts');
    lines.push(p.reference_accounts.map(r => r.name).join(' | '));
    lines.push('');
  }

  // Commands hint
  lines.push('Befehle: /instastyle pillar <id> | dos | donts | export | reload');
  lines.push('Edit via VS Code Remote SSH, dann /instastyle reload');

  const result = lines.join('\n');
  return result.length > 3500 ? result.slice(0, 3497) + '...' : result;
}

