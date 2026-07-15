#!/usr/bin/env bun
/**
 * Instagram Spike Forensic Analysis v2
 * Standalone script — run via: bun run scripts/instagram-spike-forensic.ts
 *
 * Multi-spike detection across 14-day window with per-spike deep-dive,
 * extended content correlation (feed, reels, stories), demographics
 * snapshots with diff, and online-followers timezone analysis.
 */

import fs from 'fs';
import path from 'path';
import { listActiveTelegramBindings } from '../src/modules/telegram-binding/index.js';

// ── Config ──────────────────────────────────────────────────────────────────

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const HOME = process.env.HOME || '/home/biko';
const ARTIFACTS_DIR = path.join(HOME, '.openclaw/workspace/artifacts/personal/instagram');
const TOKENS_FILE = path.join(ARTIFACTS_DIR, 'tokens.json');
const SNAPSHOTS_DIR = path.join(ARTIFACTS_DIR, 'demographics-snapshots');
const TODAY = new Date().toISOString().slice(0, 10);
const OUTPUT_FILE = path.join(ARTIFACTS_DIR, `spike-forensic-v2-${TODAY}.json`);
const SPIKE_THRESHOLD_MULTIPLE = 3; // day > 3x median = spike

// ── Types ───────────────────────────────────────────────────────────────────

interface MetaTokens {
  access_token: string;
  expires_at: number;
  refreshed_at: number;
  ig_business_id: string;
  page_id: string;
}

interface DayValue { date: string; value: number }
interface ReachDay { date: string; reach: number }
interface DemoEntry { name: string; count: number }
interface DemoSnapshot {
  timestamp: string;
  cities: DemoEntry[];
  countries: DemoEntry[];
  age_gender: DemoEntry[];
}

interface MediaInfo {
  id: string;
  caption: string;
  media_type: string;
  permalink: string;
  timestamp: string;
  like_count: number;
  comments_count: number;
  engagement: number;
  reach?: number;
  saved?: number;
  shares?: number;
  plays?: number;
  video_views?: number;
  is_reel: boolean;
  viral_flag: boolean;
}

interface StoryInfo {
  id: string;
  timestamp: string;
  media_type: string;
  reach?: number;
  replies?: number;
  taps_forward?: number;
  taps_back?: number;
  exits?: number;
}

interface SpikeAnalysis {
  date: string;
  delta_followers: number;
  multiple_of_median: string;
  reach_on_day: number;
  reach_ratio: string;
  reach_pm1: { before: number; day: number; after: number };
  classification: 'ORGANISCH' | 'VERDAECHTIG' | 'UNKLAR';
  reasoning: string[];
  content_window: MediaInfo[];
  stories_window: StoryInfo[];
  viral_content: MediaInfo[];
  top_content: MediaInfo[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadTokens(): MetaTokens | null {
  if (!fs.existsSync(TOKENS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); }
  catch { return null; }
}

function loadTelegramBotToken(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const env = loadEnv();
  if (env.TELEGRAM_BOT_TOKEN) return env.TELEGRAM_BOT_TOKEN;
  try {
    const cfgPath = path.join(HOME, '.openclaw/openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const raw = cfg?.channels?.telegram?.botToken;
    if (typeof raw === 'string') return raw;
    if (raw?.source === 'env' && raw?.id) return env[raw.id] || '';
    return '';
  } catch { return ''; }
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = fs.readFileSync(path.join(HOME, '.config/openclaw/env'), 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {}
  return env;
}

async function graphGet(endpoint: string, token: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${GRAPH_BASE}${endpoint}`);
  url.searchParams.set('access_token', token);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph API ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

async function sendTelegram(botToken: string, text: string): Promise<boolean> {
  if (!botToken) {
    console.log('[forensic] Kein Bot-Token — nur Konsole');
    console.log(text);
    return false;
  }
  const env = loadEnv();
  process.env.POSTGRES_URL ||= env.POSTGRES_URL;
  const targets = await listActiveTelegramBindings('dev');
  if (targets.length === 0) {
    console.log('[forensic] Kein dev-Telegram-Binding — nur Konsole');
    console.log(text);
    return false;
  }
  try {
    let ok = false;
    for (const target of targets) {
      if (!target.telegramChatId) continue;
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: target.telegramChatId, text, parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.log(`[forensic] Telegram HTML failed (${res.status}), retrying plain...`);
        const res2 = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: target.telegramChatId, text: text.replace(/<[^>]+>/g, '') }),
          signal: AbortSignal.timeout(10_000),
        });
        ok = res2.ok || ok;
      } else {
        ok = true;
      }
    }
    return ok;
  } catch (e: any) {
    console.log(`[forensic] Telegram error: ${e.message}`);
    return false;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function die(msg: string): never {
  console.error(`[forensic] FEHLER: ${msg}`);
  process.exit(1);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function dateShift(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseDemoBreakdown(data: any): DemoEntry[] {
  const results: DemoEntry[] = [];
  if (!data?.data) return results;
  for (const metric of data.data) {
    const breakdowns = metric.total_value?.breakdowns || [];
    for (const breakdown of breakdowns) {
      for (const result of breakdown.results || []) {
        const dims = result.dimension_values || [];
        results.push({ name: dims.join(', '), count: result.value ?? 0 });
      }
    }
  }
  return results.sort((a, b) => b.count - a.count);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[forensic] Instagram Spike Forensic v2 — ${TODAY}`);

  // ── 1. Auth ──
  const tokens = loadTokens();
  if (!tokens) die('Kein Instagram-Token gefunden.');

  const daysRemaining = Math.max(0, Math.round((tokens.expires_at - Date.now()) / 86_400_000));
  if (daysRemaining <= 0) {
    die(`Token abgelaufen (${new Date(tokens.expires_at).toISOString().slice(0, 10)}). Neuer Token noetig.`);
  }
  console.log(`[forensic] Token gueltig (${daysRemaining} Tage)`);

  const { access_token: token, ig_business_id: igId } = tokens;
  const botToken = loadTelegramBotToken();
  const env = loadEnv();

  // Token refresh if needed
  if (daysRemaining < 7 && env.META_APP_ID && env.META_APP_SECRET) {
    try {
      const url = new URL(`${GRAPH_BASE}/oauth/access_token`);
      url.searchParams.set('grant_type', 'fb_exchange_token');
      url.searchParams.set('client_id', env.META_APP_ID);
      url.searchParams.set('client_secret', env.META_APP_SECRET);
      url.searchParams.set('fb_exchange_token', token);
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const data = await res.json();
        const refreshed: MetaTokens = {
          access_token: data.access_token,
          expires_at: Date.now() + Number(data.expires_in || 5184000) * 1000,
          refreshed_at: Date.now(),
          ig_business_id: tokens.ig_business_id,
          page_id: tokens.page_id,
        };
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(refreshed, null, 2), 'utf-8');
        console.log(`[forensic] Token erneuert bis ${new Date(refreshed.expires_at).toISOString().slice(0, 10)}`);
      }
    } catch (e: any) {
      console.log(`[forensic] Token-Refresh fehlgeschlagen: ${e.message}`);
    }
  }

  // ── 2. Fetch base data ──

  // Profile
  console.log('[forensic] Lade Account-Profil...');
  let profile: any;
  try {
    profile = await graphGet(`/${igId}`, token, {
      fields: 'followers_count,media_count,username,name',
    });
  } catch (e: any) {
    die(`Profil-Fehler: ${e.message}`);
  }
  console.log(`[forensic] @${profile.username} — ${profile.followers_count} Follower`);

  const nowEpoch = Math.floor(Date.now() / 1000);
  const since14d = nowEpoch - 14 * 86400;

  // Follower count (daily, 14d)
  console.log('[forensic] Lade Follower-Insights (14 Tage)...');
  let followerDaily: DayValue[] = [];
  try {
    const data = await graphGet(`/${igId}/insights`, token, {
      metric: 'follower_count',
      period: 'day',
      since: String(since14d),
      until: String(nowEpoch),
    });
    for (const metric of data?.data || []) {
      if (metric.name === 'follower_count') {
        for (const v of metric.values || []) {
          followerDaily.push({ date: v.end_time?.slice(0, 10) || '', value: v.value ?? 0 });
        }
      }
    }
  } catch (e: any) {
    console.log(`[forensic] Follower-Insights Fehler: ${e.message}`);
  }

  // Reach (daily, 14d)
  console.log('[forensic] Lade Reach (14 Tage)...');
  let reachDaily: ReachDay[] = [];
  try {
    const data = await graphGet(`/${igId}/insights`, token, {
      metric: 'reach',
      period: 'day',
      since: String(since14d),
      until: String(nowEpoch),
    });
    const reachMetric = data?.data?.find((d: any) => d.name === 'reach');
    for (const v of reachMetric?.values || []) {
      reachDaily.push({ date: v.end_time?.slice(0, 10) || '', reach: v.value ?? 0 });
    }
  } catch (e: any) {
    console.log(`[forensic] Reach Fehler: ${e.message}`);
  }

  // Online followers (hourly distribution — lifetime period)
  console.log('[forensic] Lade Online-Followers-Pattern...');
  let onlineFollowers: any = null;
  try {
    onlineFollowers = await graphGet(`/${igId}/insights`, token, {
      metric: 'online_followers',
      period: 'lifetime',
    });
  } catch (e: any) {
    console.log(`[forensic] Online-Followers Fehler: ${e.message}`);
  }

  // ── 3. Demographics ──

  console.log('[forensic] Lade Follower-Demografie...');
  let demoCities: DemoEntry[] = [];
  let demoCountries: DemoEntry[] = [];
  let demoAgeGender: DemoEntry[] = [];

  try {
    const data = await graphGet(`/${igId}/insights`, token, {
      metric: 'follower_demographics',
      period: 'lifetime',
      metric_type: 'total_value',
      breakdown: 'city',
    });
    demoCities = parseDemoBreakdown(data);
  } catch (e: any) {
    console.log(`[forensic] Demo Staedte Fehler: ${e.message}`);
  }

  try {
    const data = await graphGet(`/${igId}/insights`, token, {
      metric: 'follower_demographics',
      period: 'lifetime',
      metric_type: 'total_value',
      breakdown: 'country',
    });
    demoCountries = parseDemoBreakdown(data);
  } catch (e: any) {
    console.log(`[forensic] Demo Laender Fehler: ${e.message}`);
  }

  try {
    const data = await graphGet(`/${igId}/insights`, token, {
      metric: 'follower_demographics',
      period: 'lifetime',
      metric_type: 'total_value',
      breakdown: 'age',
    });
    demoAgeGender = parseDemoBreakdown(data);
  } catch (e: any) {
    console.log(`[forensic] Demo Alter Fehler: ${e.message}`);
  }

  // Save demographics snapshot
  const currentSnapshot: DemoSnapshot = {
    timestamp: new Date().toISOString(),
    cities: demoCities.slice(0, 20),
    countries: demoCountries.slice(0, 20),
    age_gender: demoAgeGender.slice(0, 20),
  };
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshotFile = path.join(SNAPSHOTS_DIR, `snapshot-${TODAY}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify(currentSnapshot, null, 2), 'utf-8');
  console.log(`[forensic] Demographics-Snapshot gespeichert: ${snapshotFile}`);

  // Load previous snapshot for diff
  let demoDiff: { countries: Array<{ name: string; current: number; previous: number; delta: number }>; cities: Array<{ name: string; current: number; previous: number; delta: number }> } | null = null;
  try {
    const snapFiles = fs.readdirSync(SNAPSHOTS_DIR)
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json') && f !== `snapshot-${TODAY}.json`)
      .sort()
      .reverse();
    if (snapFiles.length > 0) {
      const prevSnapshot: DemoSnapshot = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, snapFiles[0]), 'utf-8'));
      console.log(`[forensic] Vorheriger Snapshot: ${snapFiles[0]}`);

      const diffCountries = computeDemoDiff(prevSnapshot.countries, demoCountries);
      const diffCities = computeDemoDiff(prevSnapshot.cities, demoCities);
      demoDiff = { countries: diffCountries, cities: diffCities };
    }
  } catch (e: any) {
    console.log(`[forensic] Snapshot-Diff Fehler: ${e.message}`);
  }

  // ── 4. Media + per-post insights ──

  console.log('[forensic] Lade letzte 50 Posts...');
  let rawMedia: any[] = [];
  try {
    const res = await graphGet(`/${igId}/media`, token, {
      fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
      limit: '50',
    });
    rawMedia = res.data || [];
  } catch (e: any) {
    console.log(`[forensic] Media Fehler: ${e.message}`);
  }

  // Per-post insights for posts in last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const allMedia: MediaInfo[] = [];
  console.log(`[forensic] Lade Post-Insights...`);
  for (const m of rawMedia) {
    const isRecent = (m.timestamp || '') >= thirtyDaysAgo;
    const isReel = m.media_type === 'VIDEO';
    const item: MediaInfo = {
      id: m.id,
      caption: (m.caption || '').slice(0, 150),
      media_type: m.media_type,
      permalink: m.permalink || '',
      timestamp: m.timestamp || '',
      like_count: m.like_count ?? 0,
      comments_count: m.comments_count ?? 0,
      engagement: (m.like_count ?? 0) + (m.comments_count ?? 0),
      is_reel: isReel,
      viral_flag: false,
    };

    if (isRecent) {
      try {
        // Fetch metrics: reach + saved + shares for all; plays for reels
        const metrics = isReel
          ? 'reach,saved,shares,plays'
          : 'reach,saved,shares';
        const insights = await graphGet(`/${m.id}/insights`, token, { metric: metrics });
        for (const met of insights.data || []) {
          const val = met.values?.[0]?.value ?? 0;
          if (met.name === 'reach') item.reach = val;
          if (met.name === 'saved') item.saved = val;
          if (met.name === 'shares') item.shares = val;
          if (met.name === 'plays') item.plays = val;
        }
      } catch {
        // Not all media types support all metrics
      }
    }
    allMedia.push(item);
  }

  // Compute median reach for viral detection
  const reachValues = allMedia.filter(m => m.reach != null && m.reach > 0).map(m => m.reach!);
  const medianReach = median(reachValues);
  for (const m of allMedia) {
    if (m.reach != null && medianReach > 0 && m.reach > medianReach * 5) {
      m.viral_flag = true;
    }
  }

  // ── 5. Stories ──

  console.log('[forensic] Lade Stories...');
  let stories: StoryInfo[] = [];
  try {
    const res = await graphGet(`/${igId}/stories`, token, {
      fields: 'id,timestamp,media_type',
    });
    const storyItems = res.data || [];
    for (const s of storyItems) {
      const info: StoryInfo = {
        id: s.id,
        timestamp: s.timestamp || '',
        media_type: s.media_type || '',
      };
      try {
        const insights = await graphGet(`/${s.id}/insights`, token, {
          metric: 'reach,replies,taps_forward,taps_back,exits',
        });
        for (const met of insights.data || []) {
          const val = met.values?.[0]?.value ?? 0;
          if (met.name === 'reach') info.reach = val;
          if (met.name === 'replies') info.replies = val;
          if (met.name === 'taps_forward') info.taps_forward = val;
          if (met.name === 'taps_back') info.taps_back = val;
          if (met.name === 'exits') info.exits = val;
        }
      } catch {}
      stories.push(info);
    }
    console.log(`[forensic] ${stories.length} aktive Stories geladen`);
  } catch (e: any) {
    console.log(`[forensic] Stories Fehler (evtl. keine aktiven): ${e.message}`);
  }

  // ── 6. Multi-Spike Detection ──

  console.log('[forensic] Erkenne Spikes...');
  const followerValues = followerDaily.filter(d => d.value > 0).map(d => d.value);
  const followerMedian = median(followerValues);
  const threshold = followerMedian * SPIKE_THRESHOLD_MULTIPLE;

  const spikeDates = followerDaily
    .filter(d => d.value > threshold)
    .sort((a, b) => b.value - a.value);

  console.log(`[forensic] Median: ${followerMedian}/Tag, Threshold (${SPIKE_THRESHOLD_MULTIPLE}x): ${threshold}`);
  console.log(`[forensic] ${spikeDates.length} Spike(s) erkannt: ${spikeDates.map(s => `${s.date} (+${s.value})`).join(', ') || 'keine'}`);

  // Baseline for reach (non-spike days)
  const spikeDateSet = new Set(spikeDates.map(s => s.date));
  const nonSpikeReach = reachDaily.filter(d => !spikeDateSet.has(d.date) && d.reach > 0);
  const avgReach = nonSpikeReach.length > 0
    ? Math.round(nonSpikeReach.reduce((s, d) => s + d.reach, 0) / nonSpikeReach.length)
    : 0;

  // Avg engagement for reference
  const recentPosts = allMedia.slice(0, 25);
  const avgEngagement = recentPosts.length > 0
    ? recentPosts.reduce((s, m) => s + m.engagement, 0) / recentPosts.length
    : 0;

  // ── 7. Per-Spike Deep Dive ──

  const spikeAnalyses: SpikeAnalysis[] = [];

  for (const spike of spikeDates) {
    console.log(`[forensic] Deep-Dive: ${spike.date} (+${spike.value})...`);
    const spikeDate = spike.date;

    // Reach on spike day +/- 1
    const reachOnDay = reachDaily.find(d => d.date === spikeDate)?.reach ?? 0;
    const reachBefore = reachDaily.find(d => d.date === dateShift(spikeDate, -1))?.reach ?? 0;
    const reachAfter = reachDaily.find(d => d.date === dateShift(spikeDate, 1))?.reach ?? 0;
    const reachRatio = avgReach > 0 ? reachOnDay / avgReach : 0;
    // Also check if reach in the +/-1 window was elevated
    const maxReachPm1 = Math.max(reachBefore, reachOnDay, reachAfter);
    const reachPm1Ratio = avgReach > 0 ? maxReachPm1 / avgReach : 0;

    // Content window: -7 days to spike day
    const windowStart = dateShift(spikeDate, -7);
    const contentWindow = allMedia.filter(m => {
      const d = m.timestamp?.slice(0, 10) || '';
      return d >= windowStart && d <= spikeDate;
    });

    // Stories in window (stories only have active/recent ones, so filter by timestamp)
    const storiesWindow = stories.filter(s => {
      const d = s.timestamp?.slice(0, 10) || '';
      return d >= windowStart && d <= spikeDate;
    });

    // Viral content in window
    const viralContent = contentWindow.filter(m => m.viral_flag);

    // Top content by reach (max 2)
    const topContent = [...contentWindow]
      .filter(m => m.reach != null)
      .sort((a, b) => (b.reach ?? 0) - (a.reach ?? 0))
      .slice(0, 2);

    // ── Per-spike classification ──
    const reasons: string[] = [];
    let classification: 'ORGANISCH' | 'VERDAECHTIG' | 'UNKLAR' = 'UNKLAR';

    const mult = followerMedian > 0 ? spike.value / followerMedian : 0;
    reasons.push(`+${spike.value} Follower (${mult.toFixed(1)}x Median)`);

    // Reach correlation
    if (reachPm1Ratio > 2) {
      reasons.push(`Reach im +/-1 Fenster ${reachPm1Ratio.toFixed(1)}x Baseline — starke Korrelation`);
    } else if (reachPm1Ratio > 1.3) {
      reasons.push(`Reach im +/-1 Fenster ${reachPm1Ratio.toFixed(1)}x Baseline — leicht erhoeht`);
    } else if (reachOnDay > 0) {
      reasons.push(`Reach am Tag nur ${reachRatio.toFixed(1)}x Baseline — keine Korrelation`);
    } else {
      reasons.push('Keine Reach-Daten fuer diesen Tag');
    }

    // Content presence
    if (viralContent.length > 0) {
      const topViral = viralContent[0];
      reasons.push(`Viraler Content: ${topViral.reach} Reach (${topViral.media_type}) — ${topViral.caption.slice(0, 50)}...`);
    } else if (contentWindow.length > 0) {
      reasons.push(`${contentWindow.length} Posts im 7-Tage-Window, aber kein viraler Outlier`);
    } else {
      reasons.push('Kein Content im 7-Tage-Window');
    }

    // Can viral content explain the spike?
    // Heuristic: if top content reach > spike followers * 2, it likely explains the growth
    const topReach = topContent.length > 0 ? (topContent[0].reach ?? 0) : 0;
    const reachExplainsSpike = topReach > spike.value * 2;

    if (reachExplainsSpike && viralContent.length > 0) {
      classification = 'ORGANISCH';
      reasons.push('FAZIT: Viraler Content mit hoher Reach erklaert Follower-Zuwachs');
    } else if (reachPm1Ratio > 1.5 && contentWindow.length > 0) {
      classification = 'ORGANISCH';
      reasons.push('FAZIT: Erhoehte Reach + Content im Window sprechen fuer organisch');
    } else if (mult > 10 && reachPm1Ratio < 1.2 && viralContent.length === 0) {
      classification = 'VERDAECHTIG';
      reasons.push('FAZIT: Extremer Zuwachs ohne Reach/Content-Korrelation — verdaechtig');
    } else if (mult > 3 && contentWindow.length === 0) {
      classification = 'VERDAECHTIG';
      reasons.push('FAZIT: Spike ohne Content im Window — verdaechtig');
    } else {
      classification = 'UNKLAR';
      reasons.push('FAZIT: Gemischte Signale — manuelle Pruefung empfohlen');
    }

    spikeAnalyses.push({
      date: spikeDate,
      delta_followers: spike.value,
      multiple_of_median: mult.toFixed(1),
      reach_on_day: reachOnDay,
      reach_ratio: reachRatio.toFixed(2),
      reach_pm1: { before: reachBefore, day: reachOnDay, after: reachAfter },
      classification,
      reasoning: reasons,
      content_window: contentWindow,
      stories_window: storiesWindow,
      viral_content: viralContent,
      top_content: topContent,
    });
  }

  // ── 8. Online Followers Pattern ──

  let onlinePattern: Record<string, number> | null = null;
  if (onlineFollowers?.data) {
    for (const metric of onlineFollowers.data) {
      if (metric.name === 'online_followers') {
        // v21.0: values is an array of { end_time, value: { "0": N, "1": N, ... } }
        // Use last entry (most recent day), or aggregate if multiple
        if (metric.values?.length > 0) {
          const latest = metric.values[metric.values.length - 1];
          if (latest?.value && typeof latest.value === 'object' && Object.keys(latest.value).length > 0) {
            onlinePattern = latest.value;
          }
        }
        // Fallback: total_value for lifetime
        if (!onlinePattern && metric.total_value?.value && typeof metric.total_value.value === 'object') {
          onlinePattern = metric.total_value.value;
        }
        if (onlinePattern && Object.keys(onlinePattern).length > 0) {
          console.log(`[forensic] Online-Followers: ${Object.keys(onlinePattern).length} Stunden-Slots geladen`);
        } else {
          console.log('[forensic] Online-Followers: Datenformat leer oder unbekannt');
        }
      }
    }
  }

  let timezoneClusters: string[] = [];
  if (onlinePattern) {
    const hours = Object.entries(onlinePattern)
      .map(([h, count]) => ({ hour: parseInt(h), count: count as number }))
      .sort((a, b) => b.count - a.count);
    const peakHours = hours.slice(0, 3).map(h => h.hour);
    // Interpret timezone clusters
    // Peak at 12-15 UTC = Europe (CET afternoon)
    // Peak at 17-21 UTC = Americas (EST afternoon)
    // Peak at 0-6 UTC = Asia/Pacific
    const euPeak = peakHours.some(h => h >= 10 && h <= 15);
    const usPeak = peakHours.some(h => h >= 17 && h <= 22);
    const asiaPeak = peakHours.some(h => h <= 6 || h >= 23);
    if (euPeak) timezoneClusters.push('Europa');
    if (usPeak) timezoneClusters.push('Americas');
    if (asiaPeak) timezoneClusters.push('Asien/Pazifik');
  }

  // ── 9. Build report ──

  const engagementRate = profile.followers_count > 0
    ? ((avgEngagement / profile.followers_count) * 100).toFixed(2)
    : '0';

  const report = {
    version: 'v2',
    analysis_date: TODAY,
    analysis_timestamp: new Date().toISOString(),
    account: {
      username: profile.username,
      followers_current: profile.followers_count,
      media_count: profile.media_count,
    },
    window: {
      days: 14,
      follower_median: followerMedian,
      spike_threshold: `${SPIKE_THRESHOLD_MULTIPLE}x median (>${threshold})`,
      spikes_detected: spikeDates.length,
      follower_daily: followerDaily,
      reach_daily: reachDaily,
    },
    spikes: spikeAnalyses,
    engagement: {
      rate_percent: engagementRate,
      avg_per_post: Math.round(avgEngagement),
      median_reach: medianReach,
    },
    demographics: {
      snapshot_file: snapshotFile,
      top_countries: demoCountries.slice(0, 10),
      top_cities: demoCities.slice(0, 10),
      age_gender: demoAgeGender.slice(0, 10),
      diff: demoDiff,
    },
    online_followers: {
      hourly_pattern: onlinePattern,
      timezone_clusters: timezoneClusters,
    },
    stories: stories,
    all_media: allMedia,
  };

  // Save JSON
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[forensic] JSON-Dump: ${OUTPUT_FILE}`);

  // ── 10. Telegram Report ──

  const lines: string[] = [];
  lines.push(`<b>Forensik 14 Tage — ${spikeDates.length} Spike${spikeDates.length !== 1 ? 's' : ''} erkannt</b>`);
  lines.push(`@${esc(profile.username)} | ${profile.followers_count} Follower`);
  lines.push(`Median: +${followerMedian}/Tag | Threshold: ${SPIKE_THRESHOLD_MULTIPLE}x`);
  lines.push('');

  // Follower timeline
  lines.push('<b>Follower-Zeitreihe</b>');
  lines.push('<pre>');
  for (const d of followerDaily) {
    const marker = spikeDateSet.has(d.date) ? ' SPIKE' : '';
    const bar = d.value > 0 ? '#'.repeat(Math.min(Math.ceil(d.value / Math.max(followerMedian, 1)), 30)) : '';
    lines.push(`${d.date}: +${String(d.value).padStart(5)} ${bar}${marker}`);
  }
  lines.push('</pre>');
  lines.push('');

  // Per-spike blocks
  for (const spike of spikeAnalyses) {
    lines.push(`<b>Spike ${spike.date}: +${spike.delta_followers} (${spike.multiple_of_median}x)</b>`);
    lines.push(`Klassifikation: <b>${spike.classification}</b>`);
    lines.push(`Reach: ${spike.reach_on_day} (${spike.reach_ratio}x Baseline ${avgReach})`);

    if (spike.top_content.length > 0) {
      lines.push('Top-Content:');
      for (const c of spike.top_content) {
        const tag = c.viral_flag ? ' [VIRAL]' : '';
        const type = c.is_reel ? 'Reel' : c.media_type;
        lines.push(`  ${esc(type)} | R:${c.reach ?? '?'} E:${c.engagement}${tag}`);
        lines.push(`  ${esc(c.caption.slice(0, 60).replace(/\n/g, ' '))}...`);
      }
    } else {
      lines.push('  Kein Content im 7-Tage-Window');
    }

    // One-sentence assessment
    const fazit = spike.reasoning.find(r => r.startsWith('FAZIT:'));
    if (fazit) lines.push(esc(fazit.replace('FAZIT: ', '')));
    lines.push('');
  }

  // Engagement
  lines.push(`<b>Engagement</b>`);
  lines.push(`Rate: ${engagementRate}% | Avg: ${Math.round(avgEngagement)}/Post | Median Reach: ${medianReach}`);
  lines.push('');

  // Online followers timezone
  if (timezoneClusters.length > 0) {
    lines.push(`<b>Zeitzonen-Cluster</b>`);
    lines.push(`Aktive Follower: ${timezoneClusters.join(', ')}`);
    if (onlinePattern) {
      const top3 = Object.entries(onlinePattern)
        .map(([h, c]) => ({ h: parseInt(h), c: c as number }))
        .sort((a, b) => b.c - a.c)
        .slice(0, 3);
      lines.push(`Peak: ${top3.map(t => `${t.h}:00 UTC (${t.c})`).join(', ')}`);
    }
    lines.push('');
  }

  // Demographics footer
  if (demoDiff) {
    const topGrowing = demoDiff.countries
      .filter(d => d.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 3);
    if (topGrowing.length > 0) {
      lines.push('<b>Geo-Veraenderung (vs. letzter Snapshot)</b>');
      for (const c of topGrowing) {
        lines.push(`  ${esc(c.name)}: ${c.previous} -> ${c.current} (+${c.delta})`);
      }
    }
  } else {
    lines.push('Erster Demographics-Snapshot gespeichert');
  }

  const telegramText = lines.join('\n');
  const truncated = telegramText.length > 4000
    ? telegramText.slice(0, 3990) + '\n...(gekuerzt)'
    : telegramText;
  await sendTelegram(botToken, truncated);
  console.log('[forensic] Telegram-Report gesendet');

  // ── Summary ──
  console.log('\n=== ERGEBNIS ===');
  console.log(`Spikes erkannt: ${spikeAnalyses.length}`);
  for (const s of spikeAnalyses) {
    const viral = s.viral_content.length > 0 ? `Content-Outlier: JA (${s.viral_content.length})` : 'Content-Outlier: NEIN';
    console.log(`  ${s.date}: +${s.delta_followers} | ${s.classification} | ${viral}`);
  }
  console.log(`JSON: ${OUTPUT_FILE}`);
  console.log(`Demographics-Snapshot: ${snapshotFile}`);
}

// ── Demographics Diff ───────────────────────────────────────────────────────

function computeDemoDiff(
  previous: DemoEntry[],
  current: DemoEntry[],
): Array<{ name: string; current: number; previous: number; delta: number }> {
  const prevMap = new Map(previous.map(e => [e.name, e.count]));
  const curMap = new Map(current.map(e => [e.name, e.count]));
  const allNames = new Set([...prevMap.keys(), ...curMap.keys()]);
  const diff: Array<{ name: string; current: number; previous: number; delta: number }> = [];
  for (const name of allNames) {
    const prev = prevMap.get(name) ?? 0;
    const cur = curMap.get(name) ?? 0;
    if (prev !== cur) {
      diff.push({ name, current: cur, previous: prev, delta: cur - prev });
    }
  }
  return diff.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

main().catch(e => {
  console.error(`[forensic] Fataler Fehler: ${e.message || e}`);
  process.exit(1);
});
