/**
 * instagram module — commands, engines, and message handlers.
 * Extracted from index.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import {
  loadTokens as loadInstaTokens, saveTokensToDb as saveInstaTokensToDb,
  isAuthorized as instaAuthorized, ensureFreshToken as ensureInstaToken,
  tokenDaysRemaining, tokenExpiringSoon, markTokenFailed as markInstaTokenFailed,
  fetchInsights, fetchMedia, loadInsightsCache, loadMediaCache,
  saveDraft as saveInstaDraft, loadDraft as loadInstaDraft,
  listDrafts as listInstaDrafts, createDraft as createInstaDraft,
  publish as publishDraftValidation,
  loadCalendar, saveCalendar,
  loadStyleProfile, saveStyleProfile, validateStyleProfile, getStyleProfileSummary,
  publishSingleImage, publishCarousel, publishReel, checkPublishingLimit,
} from './store.js';
import type { InstaDraft, ContentCalendarEntry, StyleProfile } from './store.js';
import {
  saveSubmission, loadSubmission, analyzeImage, analyzeVideo,
  formatAnalysisSummary, getMediaDir, generateSubmissionId, generateDraftId,
  getTopPerformerContext, generateVariants,
  stageAllMedia, cleanupStagedMedia,
} from '../../../instagram-content-engine.js';
import type { Submission, ContentVariant, VisionAnalysis } from '../../../instagram-content-engine.js';
import {
  preFlightInstagram, formatPreFlightFailure,
} from '../../../system-health.js';
import { fetchWithTimeout, readAnthropicKey, readOpenAIKey, ANTHROPIC_MODEL } from '../../shared/utils/index.js';
import { parseCallbackEvent } from '../../shared/telegram-callback/index.js';
import * as audit from '../../shared/audit/index.js';
import type {
  CutSegment, CutPlan, InstaFormat, CutResult, VideoProbe,
  FileAnalysis, ContentProposal, ScanResult, CraftDialogState,
  RawSessionFile, RawSession,
} from './types.js';

// ── DI ──────────────────────────────────────────────────────────────────────

export interface InstagramDeps {
  sendTelegram: (chatId: string, text: string) => Promise<any>;
  sendTelegramWithKeyboard: (chatId: string, text: string, keyboard: any[][]) => Promise<any>;
  answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
  telegramBotToken: string;
  metaAppId: string;
  metaAppSecret: string;
  igBusinessId: string;
}

let deps: InstagramDeps;
let _log: { info(m: string): void; warn(m: string): void; error(m: string): void } = {
  info() {}, warn() {}, error() {},
};

export function initInstagramCommands(d: InstagramDeps): void {
  deps = d;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

export async function bootstrapInstagramToken(api: any): Promise<void> {
  const { metaAppId, igBusinessId } = deps;
  if (process.env.INSTAGRAM_ACCESS_TOKEN) {
    try {
      const stored = loadInstaTokens();
      if (!stored) {
        await saveInstaTokensToDb({
          access_token: process.env.INSTAGRAM_ACCESS_TOKEN,
          expires_at: Date.now() + 60 * 24 * 60 * 60 * 1000,
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
}

// ── Module-level state (exported for command-guard in index.ts) ─────────

export const instaSubmitActive = new Set<string>();
export let instaSubmitLastActivatedAt = 0;
export function setInstaSubmitLastActivatedAt(ts: number): void { instaSubmitLastActivatedAt = ts; }
export const pendingInstaSubmits = new Map<string, { expiresAt: number; note: string }>();
export const activeRawSessions = new Map<string, string>();
export const activeCraftDialogs = new Map<string, CraftDialogState>();


// ── Paths ───────────────────────────────────────────────────────────────

const GATEWAY_MEDIA_DIR = path.join(process.env.HOME || '/root', '.openclaw/media/inbound');
const RAW_DIR = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal/instagram/raw');

// ── Raw Session Helpers (module level — no api dependency) ─────────────

function generateRawSessionId(context?: string): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  let base = 'jb';
  if (context) {
    const slug = context.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 12);
    if (slug) base = `jb-${slug}`;
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

export { detectMediaType, formatFileSize, loadRawSession, saveRawSession, createRawSession, generateRawSessionId, sessionDir, listRawSessions };

// ── Voice / Audio helpers (module level — uses _log) ─────────────────────

/** Find the most recent audio file in the gateway's inbound media dir (max 60s old). */
export function findRecentAudioFile(): { path: string; name: string } | null {
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
      _log.info(`[executive-agent] findRecentAudioFile: ${f.name} (${Math.round((now - f.mtime) / 1000)}s alt)`);
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
export async function transcribeVoice(audioPath: string): Promise<string> {
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
        _log.info(`[executive-agent] transcribeVoice: local whisper erfolgreich (${parsed.text.length} Zeichen)`);
        return parsed.text;
      }
      if (parsed.error) {
        _log.warn(`[executive-agent] transcribeVoice: local whisper Fehler: ${parsed.error}`);
      }
    }
  } catch (e: any) {
    _log.warn(`[executive-agent] transcribeVoice: local whisper fehlgeschlagen: ${e.message?.slice(0, 200)}`);
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
            _log.info(`[executive-agent] transcribeVoice: ${backend.name} erfolgreich`);
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


// ── Register Commands ───────────────────────────────────────────────────────

export function registerInstagramCommands(api: any): void {
  _log = api.logger;
  const { sendTelegram, sendTelegramWithKeyboard, telegramBotToken, metaAppId, metaAppSecret, igBusinessId } = deps;

  // Module-level state (inside registerInstagramCommands for api access)
  const instaScanActive = new Set<string>();
  const pendingScanResponse = new Map<string, { sessionId: string; expiresAt: number }>();

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
            model: ANTHROPIC_MODEL,
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
            model: ANTHROPIC_MODEL,
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
            `Einen Draft erstellen:\n\`/instadraft <nr>\``,
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
        if (!input) return { text: '❌ Nutzung: `/instadraft <plan-nr>` oder `/instadraft <freitext>`' };

        const planNr = parseInt(input);
        if (!isNaN(planNr)) {
          // Draft aus Content-Kalender
          const cal = loadCalendar();
          if (!cal) return { text: '❌ Kein Content-Kalender vorhanden. Zuerst `/instaplan` ausführen.' };
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
              model: ANTHROPIC_MODEL,
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

          const draft = await createInstaDraft({
            caption,
            hashtags: entry.hashtags,
            scheduledFor: entry.date,
            planNr: entry.nr,
            notes: `Aus Content-Kalender #${entry.nr}: ${entry.topic}`,
          });
          audit.log({ module: 'instagram', action: 'instagram.draft_created', entityType: 'draft', entityId: draft.id, after: { status: draft.status, planNr: entry.nr, source: 'calendar' } }).catch(() => {});

          return {
            text: `✅ *Draft erstellt*\n\n` +
              `🆔 ${draft.id}\n📅 Geplant: ${entry.date}\n📝 Format: ${entry.format}\n\n` +
              `Caption:\n${caption.slice(0, 300)}${caption.length > 300 ? '…' : ''}\n\n` +
              `#️⃣ ${entry.hashtags.map((h: string) => '#' + h).join(' ')}\n\n` +
              `Bearbeiten: \`/instaedit ${draft.id}\``,
          };
        } else {
          // Freitext-Draft
          const draft = await createInstaDraft({ caption: input });
          audit.log({ module: 'instagram', action: 'instagram.draft_created', entityType: 'draft', entityId: draft.id, after: { status: draft.status, source: 'freetext' } }).catch(() => {});
          return {
            text: `✅ *Draft erstellt*\n\n🆔 ${draft.id}\n📝 "${input.slice(0, 100)}${input.length > 100 ? '…' : ''}"\n\n` +
              `Bearbeiten: \`/instaedit ${draft.id}\``,
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
        const drafts = await listInstaDrafts();
        if (!drafts.length) return { text: '📝 Keine Instagram-Drafts vorhanden.' };
        const icons: Record<string, string> = { draft: '📝', review: '🔍', approved: '✅', published: '📸', archived: '📦' };
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
        if (!id) return { text: '❌ Nutzung: `/instaedit <id> [caption=...|status=...|hashtags=...|cover_frame=<sec>]`' };

        // ── cover_frame= override: session-based, skip draft lookup (E4b) ──
        const hasCoverFrame = parts.slice(1).some(p => p.startsWith('cover_frame='));
        if (hasCoverFrame) {
          const cfPart = parts.slice(1).find(p => p.startsWith('cover_frame='))!;
          const positionSec = parseFloat(cfPart.split('=')[1]);
          if (isNaN(positionSec) || positionSec < 0) {
            return { text: '❌ cover_frame muss eine Zahl >= 0 sein (Sekunden).' };
          }

          // id = session_id for cover_frame override
          const sessionId = id;
          const { getClient: getDbClient } = await import('../../shared/db/index.js');
          const client = await getDbClient();
          try {
            const { rows: origRows } = await client.query<{
              media_index: number; source_path: string; sha256_original: string; source: string;
            }>(
              `SELECT media_index, source_path, sha256_original, source
               FROM insta_media_edits
               WHERE session_id = $1 AND variant = 'original' AND status != 'deleted'
               ORDER BY media_index`,
              [sessionId],
            );
            if (origRows.length === 0) {
              return { text: `❌ Session "${sessionId}" nicht gefunden oder keine Dateien.` };
            }

            // Find first video file
            const videoRow = origRows.find(r =>
              r.source_path.endsWith('.mp4') || r.source_path.endsWith('.mov'),
            );
            if (!videoRow) {
              return { text: `❌ Keine Videodatei in Session "${sessionId}" gefunden.` };
            }

            const absSourcePath = path.join(RAW_DIR, videoRow.source_path);
            const { probeVideo, computeVideoParamsHash } = await import('./video-edit.js');
            const probe = await probeVideo(absSourcePath);

            if (positionSec > probe.duration_s) {
              return { text: `❌ Position ${positionSec}s > Video-Dauer ${probe.duration_s.toFixed(1)}s.` };
            }

            const { softDeleteVariant, insertEditVariant } = await import('./session-helper.js');
            const { submitJob: submitEditJob } = await import('./edit-queue.js');

            const deleted = await softDeleteVariant({
              sessionId, mediaIndex: videoRow.media_index, variant: 'cover_frame',
            });

            const paramsHash = computeVideoParamsHash('cover_frame', positionSec);
            const newEditId = await insertEditVariant({
              sessionId, mediaIndex: videoRow.media_index, variant: 'cover_frame',
              sourcePath: videoRow.source_path, sha256Original: videoRow.sha256_original,
              paramsHash, source: videoRow.source as any,
            });

            if (newEditId > 0) {
              await submitEditJob({
                editId: newEditId, jobType: 'cover_frame',
                sessionId, mediaIndex: videoRow.media_index,
                sourcePath: videoRow.source_path,
                params: { positionSec },
              });
            }

            audit.log({
              module: 'instagram', action: 'media.cover_frame_override',
              entityType: 'media_edit', entityId: String(newEditId),
              after: { session_id: sessionId, media_index: videoRow.media_index,
                       position_sec: positionSec, deleted_count: deleted },
            }).catch(() => {});

            return {
              text: `✅ Cover Frame Override für Session ${sessionId}:\n` +
                `Position: ${positionSec}s\n` +
                (deleted > 0 ? `${deleted} alte(r) Cover Frame(s) gelöscht\n` : '') +
                `Neuer Job eingereicht (Edit #${newEditId})`,
            };
          } finally {
            client.release();
          }
        }

        // ── Standard draft edit logic ──────────────────────────────────────
        const draft = await loadInstaDraft(id);
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
              if (val === 'draft' || val === 'review' || val === 'approved') {
                draft.status = val as any;
                updates.push(`Status → ${val}`);
              } else {
                return { text: '❌ Status muss "draft", "review" oder "approved" sein.' };
              }
              break;
            case 'hashtags':
              draft.hashtags = val.split(',').map(h => h.trim().replace(/^#/, ''));
              updates.push(`Hashtags → ${draft.hashtags.length} Tags`);
              break;
            default:
              return { text: `❌ Unbekannter Key "${key}". Erlaubt: caption, status, hashtags, cover_frame` };
          }
        }
        await saveInstaDraft(draft);
        audit.log({ module: 'instagram', action: 'instagram.draft_edited', entityType: 'draft', entityId: id, after: { updates } }).catch(() => {});
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

  // 4.9 /instapost — Draft auf Instagram veröffentlichen
  api.registerCommand({
    name: 'instapost',
    description: 'Instagram Post veröffentlichen: /instapost <draft-id>',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      try {
        const draftId = String(ctx.args || '').trim();
        if (!draftId) return { text: '❌ Nutzung: `/instapost <draft-id>`' };

        // Approval-Hard-Rule (spec §17.2): publish() validates approval, throws if missing
        let draft;
        try {
          draft = await publishDraftValidation(draftId);
        } catch (valErr: any) {
          if (valErr.message === 'approval required') {
            const d = await loadInstaDraft(draftId);
            audit.log({ module: 'instagram', action: 'instagram.post_failed', entityType: 'draft', entityId: draftId, after: { error: 'approval required', status: d?.status } }).catch(() => {});
            return { text: `❌ Draft "${draftId}" hat Status "${d?.status}" — nur "approved" kann veröffentlicht werden.\n\nStatus ändern: \`/instaedit ${draftId} status=approved\`` };
          }
          if (valErr.message === 'already published') {
            const d = await loadInstaDraft(draftId);
            return { text: `ℹ️ Draft "${draftId}" wurde bereits veröffentlicht.\n📸 ${d?.instagram_url || '(kein Link)'}` };
          }
          return { text: `❌ ${valErr.message}` };
        }

        // Token
        if (!instaAuthorized()) return { text: '❌ Instagram nicht verbunden. Bitte Tokens in env setzen.' };
        const tokens = await ensureInstaToken(metaAppId, metaAppSecret);

        // Resolve media files from draft
        const mediaFiles: Array<{ path: string; type: 'image' | 'video' }> = [];
        if (draft.mediaPath) {
          if (!fs.existsSync(draft.mediaPath)) {
            return { text: `❌ Media-Pfad nicht gefunden: ${draft.mediaPath}` };
          }
          const stat = fs.statSync(draft.mediaPath);
          if (stat.isDirectory()) {
            const entries = fs.readdirSync(draft.mediaPath).filter(f => !f.startsWith('.')).sort();
            for (const name of entries) {
              const t = detectMediaType(name);
              if (t === 'image' || t === 'video') {
                mediaFiles.push({ path: path.join(draft.mediaPath, name), type: t });
              }
            }
          } else {
            const t = detectMediaType(draft.mediaPath);
            if (t === 'image' || t === 'video') {
              mediaFiles.push({ path: draft.mediaPath, type: t });
            }
          }
        }
        // Fallback: check submission reference in notes
        if (mediaFiles.length === 0 && draft.notes) {
          const match = draft.notes.match(/Submission ([\w-]+)/i);
          if (match) {
            try {
              const sub = await loadSubmission(match[1]);
              for (const m of sub.media || []) {
                if ((m.type === 'image' || m.type === 'video') && fs.existsSync(m.path)) {
                  mediaFiles.push({ path: m.path, type: m.type });
                }
              }
            } catch { /* submission not found — continue */ }
          }
        }
        if (mediaFiles.length === 0) {
          return { text: `❌ Keine Mediendateien für Draft "${draftId}" gefunden.\n\nMedia zuweisen: \`/instaedit ${draftId} media=/pfad/zur/datei\`` };
        }

        // Caption + Hashtags
        const fullCaption = draft.hashtags.length > 0
          ? `${draft.caption}\n\n${draft.hashtags.map(h => '#' + h).join(' ')}`
          : draft.caption;

        // Stage media for public URLs
        const staged = stageAllMedia(
          mediaFiles.map(f => ({ path: f.path })),
          draftId,
        );

        try {
          // Publish with token-refresh retry on code 190 (session expired)
          async function doPublish(accessToken: string, igId: string) {
            if (mediaFiles.length === 1 && mediaFiles[0].type === 'video') {
              return publishReel(accessToken, igId, staged[0].publicUrl, fullCaption);
            } else if (mediaFiles.length === 1) {
              return publishSingleImage(accessToken, igId, staged[0].publicUrl, fullCaption);
            } else {
              const items = staged.map((s, i) => ({ url: s.publicUrl, type: mediaFiles[i].type }));
              return publishCarousel(accessToken, igId, items, fullCaption);
            }
          }

          let result: { postId: string; permalink: string };
          try {
            result = await doPublish(tokens.access_token, tokens.ig_business_id);
          } catch (pubErr: any) {
            // Token expired (code 190) → refresh + retry once
            if (pubErr.message?.includes('"code":190') || pubErr.message?.includes('"code": 190')) {
              api.logger.warn('[executive-agent] /instapost: Token expired (code 190), refreshing...');
              await markInstaTokenFailed();
              const refreshed = await ensureInstaToken(metaAppId, metaAppSecret, true);
              result = await doPublish(refreshed.access_token, refreshed.ig_business_id);
            } else {
              throw pubErr;
            }
          }

          // Update draft
          draft.status = 'published';
          draft.published_at = new Date().toISOString();
          draft.instagram_post_id = result.postId;
          draft.instagram_url = result.permalink;
          draft.publish_error = undefined;
          await saveInstaDraft(draft);
          audit.log({ module: 'instagram', action: 'instagram.post_published', entityType: 'draft', entityId: draft.id, before: { status: 'approved' }, after: { status: 'published', instagram_post_id: result.postId, format: mediaFiles.length > 1 ? 'carousel' : mediaFiles[0].type } }).catch(() => {});

          const format = mediaFiles.length > 1 ? 'Karussell' : mediaFiles[0].type === 'video' ? 'Reel' : 'Einzelbild';
          return {
            text: `✅ *Gepostet!*\n\n` +
              `🆔 ${draft.id}\n` +
              `📸 ${result.permalink}\n` +
              `📋 Format: ${format} (${mediaFiles.length} Datei${mediaFiles.length > 1 ? 'en' : ''})\n\n` +
              `Caption: ${draft.caption.slice(0, 150)}${draft.caption.length > 150 ? '…' : ''}`,
          };
        } finally {
          cleanupStagedMedia(draftId);
        }
      } catch (e: any) {
        // Save error to draft
        const draftId = String(ctx.args || '').trim();
        if (draftId) {
          try {
            const d = await loadInstaDraft(draftId);
            if (d && d.status !== 'published') {
              d.publish_error = e.message;
              await saveInstaDraft(d);
            }
          } catch { /* ignore */ }
          audit.log({ module: 'instagram', action: 'instagram.post_failed', entityType: 'draft', entityId: draftId, after: { error: String(e.message).slice(0, 200) } }).catch(() => {});
        }
        return { text: `❌ /instapost Fehler: ${e.message}` };
      }
    },
  });

  // 4.9b /instaposts — Veröffentlichte Posts auflisten
  api.registerCommand({
    name: 'instaposts',
    description: 'Veröffentlichte Instagram Posts auflisten: /instaposts',
    handler: async () => {
      try {
        const drafts = await listInstaDrafts('published', 50);
        if (!drafts.length) return { text: '📸 Noch keine veröffentlichten Posts.' };

        const lines = drafts.map(d => {
          const date = d.published_at ? d.published_at.slice(0, 10) : d.updatedAt.slice(0, 10);
          const preview = d.caption.length > 40 ? d.caption.slice(0, 40) + '…' : d.caption;
          const link = d.instagram_url || '(kein Link)';
          return `📸 ${date} | ${d.id}\n   ${link}\n   "${preview}"`;
        });
        return { text: `📸 *Veröffentlichte Posts* (${drafts.length})\n\n${lines.join('\n\n')}` };
      } catch (e: any) {
        return { text: `❌ /instaposts Fehler: ${e.message}` };
      }
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
        if (!id) return { text: '❌ Nutzung: `/instavariants <submission-id>`\nBeispiel: `/instavariants sub-bvcw-0605`' };

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
          return { text: '❌ Nutzung: `/instaapprove <submission-id> <1|2|3>`\nBeispiel: `/instaapprove sub-bvcw-0605 2`' };
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
          return { text: `❌ Submission ${id} hat keine Varianten. Zuerst \`/instavariants ${id}\` ausfuehren.` };
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
        audit.log({ module: 'instagram', action: 'instagram.draft_approved', entityType: 'submission', entityId: id, before: { status: 'generated' }, after: { status: 'approved', selected_variant: variantNr, variant_type: chosen.type } }).catch(() => {});

        // Create draft from chosen variant
        const draft = await createInstaDraft({
          caption: chosen.caption,
          hashtags: chosen.hashtags,
          notes: `Aus Submission ${id}, Variante ${variantNr} (${chosen.type})`,
        });
        audit.log({ module: 'instagram', action: 'instagram.draft_created', entityType: 'draft', entityId: draft.id, after: { status: draft.status, source: 'approval', submission_id: id } }).catch(() => {});

        api.logger.info(`[executive-agent] /instaapprove: Variante ${variantNr} (${chosen.type}) gewaehlt fuer ${id} → Draft ${draft.id}`);

        return {
          text: `✅ Variante ${variantNr} (${chosen.type}) uebernommen\n\n` +
            `Submission: ${id} → Status: approved\n` +
            `Draft: ${draft.id}\n\n` +
            `Caption:\n${chosen.caption.slice(0, 300)}${chosen.caption.length > 300 ? '…' : ''}\n\n` +
            `Tags: ${chosen.hashtags.map(h => '#' + h).join(' ')}\n\n` +
            `Bearbeiten: \`/instaedit ${draft.id}\``,
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

    lines.push(`Antwort: \`/instaapprove ${submissionId} <1|2|3>\``);
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
          const profile = await loadStyleProfile();
          const error = validateStyleProfile(profile);
          if (error) {
            return { text: `Validierung fehlgeschlagen: ${error}` };
          }
          return { text: `Style-Profil v${profile.version} geladen und validiert.\n${profile.pillars.length} Pillars | ${profile.dos.length} Dos | ${profile.donts.length} Donts | ${profile.formats.length} Formate` };
        }

        // /instastyle pillar <id>
        if (arg.startsWith('pillar ')) {
          const pillarId = arg.slice(7).trim();
          const profile = await loadStyleProfile();
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
          const profile = await loadStyleProfile();
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
          const profile = await loadStyleProfile();
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
            text: 'Style-Profil bearbeiten:\n\nEdit via VS Code Remote SSH unter\nartifacts/personal/instagram/style-profile.json\n\nDanach: `/instastyle reload`',
          };
        }

        // /instastyle set — deactivated
        if (arg.startsWith('set')) {
          return {
            text: 'Inline-Edit deaktiviert. Pflege erfolgt per Datei-Edit.\n\nSiehe: `/instastyle edit`',
          };
        }

        // /instastyle — overview
        return { text: await getStyleProfileSummary() };
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

  /** Run Vision Analysis pipeline on a media file. Sends results/errors via Telegram. */
  async function runInstaSubmitPipeline(
    chatId: string, userNote: string, mediaFile: { path: string; type: 'image' | 'video' },
    overrideSubmissionId?: string,
    sourceSessionId?: string,
  ): Promise<void> {
    const submissionId = overrideSubmissionId || generateSubmissionId(userNote);
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
        `✅ Analyse abgeschlossen\n\n${summary}\n\nSubmission-ID: \`${submissionId}\`\n\nNaechste Schritte:\n\`/instavariants ${submissionId}\``,
      );
      api.logger.info(`[executive-agent] instasubmit pipeline DONE: ${submissionId}`);
    } catch (analysisErr: any) {
      api.logger.error(`[executive-agent] instasubmit Vision-Fehler: ${analysisErr.message}\n${analysisErr.stack || ''}`);
      await sendTelegram(
        chatId,
        `❌ Vision-Analyse fehlgeschlagen: ${analysisErr.message}\n\nSubmission-ID: \`${submissionId}\` (Status: received)\nBitte erneut versuchen mit \`/instasubmit${sourceSessionId ? ' ' + sourceSessionId : ''}\``,
      );
    }
  }

  // ── Carousel Submit Pipeline (single submission for all session files) ───
  async function runCarouselSubmitPipeline(
    chatId: string,
    sessionId: string,
    mediaFiles: Array<{ path: string; type: 'image' | 'video'; name: string }>,
    userNote: string,
  ): Promise<void> {
    const submissionId = generateSubmissionId(sessionId);
    api.logger.info(`[executive-agent] carousel pipeline START: id=${submissionId} session=${sessionId} files=${mediaFiles.length}`);

    // Copy all media files to submission directory
    const mediaDir = getMediaDir(submissionId);
    const submissionMedia: Array<{ type: 'image' | 'video'; path: string; mimeType: string }> = [];
    for (const mf of mediaFiles) {
      try {
        const destPath = path.join(mediaDir, mf.name);
        fs.copyFileSync(mf.path, destPath);
        submissionMedia.push({
          type: mf.type,
          path: destPath,
          mimeType: mf.type === 'image' ? 'image/jpeg' : 'video/mp4',
        });
      } catch (cpErr: any) {
        api.logger.error(`[executive-agent] carousel: Kopie fehlgeschlagen fuer ${mf.name}: ${cpErr.message}`);
        await sendTelegram(chatId, `❌ Kopie fehlgeschlagen: ${mf.name} — ${cpErr.message}`);
        return;
      }
    }

    // Analyze each file individually
    const allAnalyses: VisionAnalysis[] = [];
    for (let i = 0; i < submissionMedia.length; i++) {
      const sm = submissionMedia[i];
      const fileLabel = mediaFiles[i].name;
      try {
        await sendTelegram(chatId, `🔍 Analyse ${i + 1}/${submissionMedia.length}: ${fileLabel}...`);
        const analysis = sm.type === 'image'
          ? await analyzeImage(sm.path)
          : await analyzeVideo(sm.path);
        allAnalyses.push(analysis);
        api.logger.info(`[executive-agent] carousel: Analyse ${i + 1}/${submissionMedia.length} OK — subjects=${analysis.subjects?.join(',')}`);
      } catch (err: any) {
        api.logger.error(`[executive-agent] carousel: Analyse fehlgeschlagen fuer ${fileLabel}: ${err.message}`);
        await sendTelegram(chatId, `❌ Analyse fehlgeschlagen: ${fileLabel} — ${err.message}`);
        return;
      }
    }

    // Aggregate analyses (same pattern as analyzeVideo in instagram-content-engine.ts)
    const moodCounts = new Map<string, number>();
    const settingCounts = new Map<string, number>();
    const allColors = new Set<string>();
    const allHooks = new Set<string>();
    const allPillars = new Set<string>();
    const subjectCounts = new Map<string, number>();
    const compositions: string[] = [];
    let bestQuality: 'high' | 'medium' | 'low' = 'low';
    const qualityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };

    for (const a of allAnalyses) {
      moodCounts.set(a.mood, (moodCounts.get(a.mood) || 0) + 1);
      settingCounts.set(a.setting, (settingCounts.get(a.setting) || 0) + 1);
      a.colors.forEach(c => allColors.add(c));
      a.narrative_hooks.forEach(h => allHooks.add(h));
      a.pillar_match.forEach(p => allPillars.add(p));
      a.subjects.forEach(s => subjectCounts.set(s, (subjectCounts.get(s) || 0) + 1));
      if (a.composition && !compositions.includes(a.composition)) compositions.push(a.composition);
      if (qualityOrder[a.visual_quality] > qualityOrder[bestQuality]) {
        bestQuality = a.visual_quality;
      }
    }

    const dominant = (m: Map<string, number>) => {
      let best = ''; let max = 0;
      for (const [k, v] of m) { if (v > max) { max = v; best = k; } }
      return best;
    };

    const topSubjects = [...subjectCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s]) => s);

    const aggregatedAnalysis: VisionAnalysis = {
      subjects: topSubjects,
      mood: dominant(moodCounts),
      setting: dominant(settingCounts),
      composition: compositions.join(', '),
      colors: [...allColors].slice(0, 8),
      narrative_hooks: [...allHooks].slice(0, 6),
      visual_quality: bestQuality,
      pillar_match: [...allPillars],
    };

    // Save submission with all media and aggregated analysis
    const submission: Submission = {
      id: submissionId,
      media: submissionMedia,
      context: { user_note: `Karussell (${mediaFiles.length} Medien): ${userNote}` },
      status: 'analyzed',
      analysis: aggregatedAnalysis,
      created: new Date().toISOString(),
    };
    await saveSubmission(submission);
    api.logger.info(`[executive-agent] carousel: Submission gespeichert: ${submissionId} (${submissionMedia.length} Medien)`);

    // Generate variants
    try {
      await sendTelegram(chatId, `🎨 Karussell-Analyse abgeschlossen — generiere Varianten...`);
      const variants = await generateVariants(submission);
      submission.variants = variants;
      submission.status = 'generated';
      await saveSubmission(submission);

      const output = formatVariantsOutput(submissionId, variants);
      const fileList = mediaFiles.map(f => f.name).join(', ');
      await sendTelegram(
        chatId,
        `🎠 Karussell-Submission erstellt\n${mediaFiles.length} Dateien: ${fileList}\n\n${output}\n\nBearbeiten: \`/instaedit ${submissionId}\``,
      );
      api.logger.info(`[executive-agent] carousel pipeline DONE: ${submissionId}`);
    } catch (varErr: any) {
      api.logger.error(`[executive-agent] carousel: Varianten-Fehler: ${varErr.message}`);
      const summary = formatAnalysisSummary(aggregatedAnalysis, 'image');
      await sendTelegram(
        chatId,
        `✅ Karussell-Analyse abgeschlossen\n\n${summary}\n\nSubmission-ID: \`${submissionId}\`\n\nVarianten manuell generieren:\n\`/instavariants ${submissionId}\``,
      );
    }

    // Create draft
    try {
      const fileList = mediaFiles.map(f => f.name).join(', ');
      const chosen = submission.variants?.[0];
      if (chosen) {
        const draft = await createInstaDraft({
          caption: chosen.caption,
          hashtags: chosen.hashtags,
          mediaPath: path.join(sessionDir(sessionId), 'original'),
          notes: `Karussell: ${fileList}`,
        });
        audit.log({ module: 'instagram', action: 'instagram.draft_created', entityType: 'draft', entityId: draft.id, after: { status: draft.status, source: 'carousel' } }).catch(() => {});
        api.logger.info(`[executive-agent] carousel: Draft erstellt: ${draft.id}`);
      }
    } catch (draftErr: any) {
      api.logger.error(`[executive-agent] carousel: Draft-Erstellung fehlgeschlagen: ${draftErr.message}`);
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

      // Check if note references a session (e.g. "jb-0905", "raw-0905", "jb-strand-0509")
      const rawSessionMatch = note.match(/\b((?:jb|raw)-[a-z0-9-]+)\b/i);
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

            // Carousel detection: "karussell" or "carousel" in note
            const isCarousel = /karussell|carousel/i.test(note);
            if (isCarousel && sessionMediaFiles.length > 1) {
              api.logger.info(`[executive-agent] /instasubmit: Karussell-Modus — ${sessionMediaFiles.length} Dateien`);
              sendTelegram(chatId, `🎠 Karussell-Modus: ${sessionMediaFiles.length} Dateien aus Session ${refSessionId}. Analyse laeuft...`).catch(() => {});

              (async () => {
                try {
                  await runCarouselSubmitPipeline(chatId, refSessionId, sessionMediaFiles, note);
                } catch (err: any) {
                  api.logger.error(`[executive-agent] /instasubmit carousel CRASH: ${err?.message}\n${err?.stack || ''}`);
                  sendTelegram(chatId, `❌ Karussell-Pipeline-Fehler: ${err?.message}`).catch(() => {});
                } finally {
                  instaSubmitActive.delete(senderId);
                }
              })();

              return {
                text: `🎠 Karussell: ${sessionMediaFiles.length} Dateien aus Session ${refSessionId} — Analyse + Varianten werden generiert. Ergebnisse folgen per Telegram.`,
              };
            } else if (isCarousel && sessionMediaFiles.length <= 1) {
              api.logger.info(`[executive-agent] /instasubmit: Karussell angefordert aber nur ${sessionMediaFiles.length} Datei — Fallback auf per-file`);
              sendTelegram(chatId, `⚠️ Karussell braucht mindestens 2 Dateien — fahre mit Einzel-Analyse fort.`).catch(() => {});
            }

            sendTelegram(chatId, `📥 Session ${refSessionId}: ${sessionMediaFiles.length} Datei(en) gefunden. Analyse laeuft...`).catch(() => {});

            // Generate unique submission IDs per file — prevent overwrites
            const baseSubId = generateSubmissionId(refSessionId);

            // Run pipeline for each media file sequentially
            (async () => {
              let ok = 0;
              let fail = 0;
              try {
                for (let i = 0; i < sessionMediaFiles.length; i++) {
                  const mf = sessionMediaFiles[i];
                  const subId = sessionMediaFiles.length === 1
                    ? baseSubId
                    : `${baseSubId}-${String(i + 1).padStart(2, '0')}`;
                  try {
                    await runInstaSubmitPipeline(chatId, note, { path: mf.path, type: mf.type }, subId, refSessionId);
                    ok++;
                  } catch (fileErr: any) {
                    fail++;
                    api.logger.error(`[executive-agent] /instasubmit session-pipeline Datei ${i + 1} CRASH: ${fileErr?.message}`);
                    sendTelegram(chatId, `❌ Datei ${i + 1}/${sessionMediaFiles.length} fehlgeschlagen: ${fileErr?.message}`).catch(() => {});
                  }
                }
                // Summary
                if (ok > 0) {
                  const summary = fail > 0
                    ? `📊 Session ${refSessionId}: ${ok}/${sessionMediaFiles.length} analysiert, ${fail} fehlgeschlagen.`
                    : `✅ Session ${refSessionId}: alle ${ok} Dateien analysiert.`;
                  sendTelegram(chatId, summary).catch(() => {});
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
        text: '📷 Kein Foto/Video gefunden — sende jetzt ein Foto oder Video.\n\nTipp: Foto direkt mit Caption senden:\n`/instasubmit <text>`\n\nOder Session-basiert:\n`/instasubmit jb-<session-id>`',
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
        if (!id) return { text: '❌ Bitte Session-ID angeben: `/instaraw del <id>`' };
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
      if (sessions.length === 0) return { text: '📁 Keine Raw-Sessions vorhanden.\n\nErstelle eine neue: `/instaraw new [kontext]`' };

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
          return { text: '📁 Keine scanbaren Sessions vorhanden.\n\nErstelle eine Session: `/instaraw new [kontext]`\nDann sende Fotos/Videos.' };
        }
        const lines = sessions.map(s => {
          const mediaFiles = s.files.filter(f => f.type === 'image' || f.type === 'video');
          const scanTag = s.status === 'scanned' ? ' ✅ gescannt' : '';
          return `📁 ${s.id} [${s.status}]${scanTag}\n   ${mediaFiles.length} Medien-Datei(en)`;
        });
        const keyboard = sessions.map(s => ([
          { text: `🔍 ${s.id}`, callback_data: `iscan_go_${s.id}`.slice(0, 64) },
        ]));
        await sendTelegramWithKeyboard(chatId, `📁 Scanbare Sessions:\n\n${lines.join('\n\n')}`, keyboard);
        return { text: '' };
      }

      const sessionId = args;

      // Concurrency guard
      if (instaScanActive.has(chatId)) {
        return { text: '⏳ Ein Scan läuft bereits. Bitte warten.' };
      }

      const session = loadRawSession(sessionId);
      if (!session) {
        return { text: `❌ Session "${sessionId}" nicht gefunden.\n\nAlle Sessions: \`/instaraw\`` };
      }

      // If already scanned with results — show proposals again without re-scanning
      if (session.status === 'scanned' && session.scan_result?.proposals?.length) {
        const msg = formatProposalMessage(sessionId, session.scan_result.proposals);
        const keyboard = buildProposalKeyboard(sessionId, session.scan_result.proposals);
        keyboard.push([{ text: '🎤 Eigene Richtung (Text/Sprache senden)', callback_data: `iscan_dir_${sessionId}`.slice(0, 64) }]);
        await sendTelegramWithKeyboard(chatId, msg, keyboard);
        pendingScanResponse.set(chatId, { sessionId, expiresAt: Date.now() + 10 * 60_000 });
        return { text: '' };
      }

      // Check for media files
      const mediaFiles = session.files.filter(f => f.type === 'image' || f.type === 'video');
      if (mediaFiles.length === 0) {
        return { text: `❌ Session "${sessionId}" hat keine Medien-Dateien.\n\nSende Fotos/Videos in die Session.` };
      }

      // Ask user: own direction or auto-proposals?
      const keyboard = [
        [
          { text: '🎯 Ja, eigene Richtung', callback_data: `iscan_ask_${sessionId}::craft`.slice(0, 64) },
          { text: '💡 Nein, Vorschläge', callback_data: `iscan_ask_${sessionId}::scan`.slice(0, 64) },
        ],
      ];
      await sendTelegramWithKeyboard(
        chatId,
        `📁 Session ${sessionId} — ${mediaFiles.length} Medien-Datei(en)\n\nHast du eine konkrete Vorstellung, was daraus werden soll?`,
        keyboard,
      );
      return { text: '' };
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
          return { text: '📁 Keine craftbaren Sessions vorhanden.\n\nErstelle eine Session: `/instaraw new [kontext]`\nDann sende Fotos/Videos.' };
        }
        const lines = sessions.map(s => {
          const mediaFiles = s.files.filter(f => f.type === 'image' || f.type === 'video');
          const scanTag = s.status === 'scanned' ? ' ✅ gescannt' : '';
          return `📁 ${s.id} [${s.status}]${scanTag}\n   ${mediaFiles.length} Medien-Datei(en)`;
        });
        const keyboard = sessions.map(s => ([
          { text: `🎨 ${s.id}`, callback_data: `icraft_go_${s.id}`.slice(0, 64) },
        ]));
        await sendTelegramWithKeyboard(chatId, `🎨 Craftbare Sessions:\n\n${lines.join('\n\n')}`, keyboard);
        return { text: '' };
      }

      // Parse: first word = session-id, rest = direction
      const spaceIdx = args.indexOf(' ');
      const sessionId = spaceIdx > 0 ? args.slice(0, spaceIdx) : args;
      const direction = spaceIdx > 0 ? args.slice(spaceIdx + 1).trim() : '';

      // Guard: active dialog already running
      const existing = activeCraftDialogs.get(chatId);
      if (existing && Date.now() < existing.expiresAt) {
        return { text: `⏳ Craft-Dialog bereits aktiv (Session: ${existing.sessionId}, Step: ${existing.step}).\n\nAbbrechen: \`/instacraft cancel\`` };
      }

      const session = loadRawSession(sessionId);
      if (!session) {
        return { text: `❌ Session "${sessionId}" nicht gefunden.\n\nAlle Sessions: \`/instaraw\`` };
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

  // Hook: scan response — text input triggers craft with direction
  api.on('message_received', async (event: any) => {
    try {
      const content: string = event?.content ?? '';
      if (!content || content.startsWith('/') || content.includes('<media:')) return;

      const senderId = String(event?.metadata?.senderId || '');
      if (!senderId) return;

      const pending = pendingScanResponse.get(senderId);
      if (!pending || Date.now() > pending.expiresAt) return;

      pendingScanResponse.delete(senderId);
      const chatId = senderId;
      const { sessionId } = pending;

      api.logger.info(`[executive-agent] scan-response: Text von ${senderId} als Richtung für ${sessionId}: "${content.slice(0, 50)}"`);

      // Start craft workflow with the text as direction
      const session = loadRawSession(sessionId);
      if (!session) {
        await sendTelegram(chatId, `❌ Session "${sessionId}" nicht mehr vorhanden.`);
        return;
      }

      const fileAnalyses = session.scan_result?.file_analyses || [];
      const state: CraftDialogState = {
        sessionId,
        direction: content,
        fileAnalyses,
        step: 'generating',
        expiresAt: Date.now() + 15 * 60_000,
      };
      activeCraftDialogs.set(chatId, state);

      runCraftPlanGeneration(chatId, sessionId, content).catch(err => {
        api.logger.error(`[executive-agent] scan-response craft CRASH: ${err?.message}`);
        sendTelegram(chatId, `❌ Craft-Plan fehlgeschlagen: ${err?.message}`).catch(() => {});
        activeCraftDialogs.delete(chatId);
      });
    } catch (e: any) {
      api.logger.error(`[executive-agent] scan-response-handler Fehler: ${e?.message}`);
    }
  });

  // Hook: scan response — voice input triggers craft with transcribed direction
  api.on('message_received', async (event: any) => {
    try {
      const content: string = event?.content ?? '';
      if (!content.includes('<media:audio>')) return;

      const senderId = String(event?.metadata?.senderId || '');
      if (!senderId) return;

      const pending = pendingScanResponse.get(senderId);
      if (!pending || Date.now() > pending.expiresAt) return;

      pendingScanResponse.delete(senderId);
      const chatId = senderId;
      const { sessionId } = pending;

      const audioFile = findRecentAudioFile();
      if (!audioFile) {
        await sendTelegram(chatId, '❌ Audio-Datei nicht gefunden.');
        return;
      }

      await sendTelegram(chatId, '🎤 Transkribiere Sprachnachricht...');
      const transcription = await transcribeVoice(audioFile.path);
      await sendTelegram(chatId, `🎤 "${transcription}"`);

      api.logger.info(`[executive-agent] scan-response: Voice von ${senderId} als Richtung für ${sessionId}: "${transcription.slice(0, 50)}"`);

      const session = loadRawSession(sessionId);
      if (!session) {
        await sendTelegram(chatId, `❌ Session "${sessionId}" nicht mehr vorhanden.`);
        return;
      }

      const fileAnalyses = session.scan_result?.file_analyses || [];
      const state: CraftDialogState = {
        sessionId,
        direction: transcription,
        fileAnalyses,
        step: 'generating',
        expiresAt: Date.now() + 15 * 60_000,
      };
      activeCraftDialogs.set(chatId, state);

      runCraftPlanGeneration(chatId, sessionId, transcription).catch(err => {
        api.logger.error(`[executive-agent] scan-response voice craft CRASH: ${err?.message}`);
        sendTelegram(chatId, `❌ Craft-Plan fehlgeschlagen: ${err?.message}`).catch(() => {});
        activeCraftDialogs.delete(chatId);
      });
    } catch (e: any) {
      api.logger.error(`[executive-agent] scan-response-voice-handler Fehler: ${e?.message}`);
    }
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
        await sendTelegram(chatId, '❌ Mediendatei nicht gefunden.\n\nBitte erneut senden: Foto direkt mit Caption `\/instasubmit <text>`');
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
          analysis = await analyzeImage(filePath, { includeBbox: true });
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
    const styleContext = await getStyleProfileSummary();
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
        model: ANTHROPIC_MODEL,
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

  async function handleInstasubmitCallback(chatId: string, sessionId: string): Promise<void> {
    const session = loadRawSession(sessionId);
    if (!session) {
      await sendTelegram(chatId, `❌ Session "${sessionId}" nicht gefunden.`);
      return;
    }

    const origDir = path.join(sessionDir(sessionId), 'original');
    if (!fs.existsSync(origDir)) {
      await sendTelegram(chatId, `❌ Keine Dateien in Session "${sessionId}".`);
      return;
    }

    const mediaFiles = fs.readdirSync(origDir)
      .filter(f => !f.startsWith('.'))
      .map(f => ({
        path: path.join(origDir, f),
        type: detectMediaType(f) as 'image' | 'video',
      }))
      .filter(f => f.type === 'image' || f.type === 'video');

    if (mediaFiles.length === 0) {
      await sendTelegram(chatId, `❌ Keine Bild/Video-Dateien in Session "${sessionId}".`);
      return;
    }

    const senderId = chatId;
    instaSubmitActive.add(senderId);
    instaSubmitLastActivatedAt = Date.now();

    await sendTelegram(chatId, `📥 Session ${sessionId}: ${mediaFiles.length} Datei(en) — Analyse laeuft...`);

    const baseSubId = generateSubmissionId(sessionId);
    let ok = 0;
    let fail = 0;
    try {
      for (let i = 0; i < mediaFiles.length; i++) {
        const mf = mediaFiles[i];
        const subId = mediaFiles.length === 1
          ? baseSubId
          : `${baseSubId}-${String(i + 1).padStart(2, '0')}`;
        try {
          await runInstaSubmitPipeline(chatId, sessionId, mf, subId, sessionId);
          ok++;
        } catch (fileErr: any) {
          fail++;
          api.logger.error(`[executive-agent] instasubmit callback Datei ${i + 1} CRASH: ${fileErr?.message}`);
          sendTelegram(chatId, `❌ Datei ${i + 1}/${mediaFiles.length} fehlgeschlagen: ${fileErr?.message}`).catch(() => {});
        }
      }
      if (ok > 0) {
        const summary = fail > 0
          ? `📊 Session ${sessionId}: ${ok}/${mediaFiles.length} analysiert, ${fail} fehlgeschlagen.`
          : `✅ Session ${sessionId}: alle ${ok} Dateien analysiert.`;
        sendTelegram(chatId, summary).catch(() => {});
      }
    } catch (err: any) {
      api.logger.error(`[executive-agent] instasubmit callback CRASH: ${err?.message}\n${err?.stack || ''}`);
      sendTelegram(chatId, `❌ Pipeline-Fehler: ${err?.message}`).catch(() => {});
    } finally {
      instaSubmitActive.delete(senderId);
    }
  }

  function buildProposalKeyboard(sessionId: string, proposals: ContentProposal[]): Array<Array<{ text: string; callback_data: string }>> {
    return proposals.map(p => {
      const formatLabel = p.format === 'reel' ? 'Reel' : p.format === 'feed-video' ? 'Feed' : 'Foto';
      // callback_data max 64 bytes — use compact format
      const cbData = `iscan_${sessionId}::${p.id}`;
      return [{ text: `${p.id}: ${formatLabel} — ${p.title.slice(0, 25)}`, callback_data: cbData.slice(0, 64) }];
    });
  }

  async function handleInstascanCallback(chatId: string, args: string[]): Promise<void> {
    // args = ['<sessionId>', '<proposalId>']
    if (args.length < 2) {
      await sendTelegram(chatId, '❌ Ungültige Callback-Daten.');
      return;
    }
    const sessionId = args[0];
    const proposalId = args[1];

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
        const draft = await createInstaDraft({
          caption: chosen.caption,
          hashtags: chosen.hashtags,
          mediaPath: cutResult.output_path,
          notes: `Scan ${sessionId} → Vorschlag ${proposalId}: ${proposal.title}`,
        });
        audit.log({ module: 'instagram', action: 'instagram.draft_created', entityType: 'draft', entityId: draft.id, after: { status: draft.status, source: 'scan' } }).catch(() => {});

        const variantsText = formatVariantsOutput(submissionId, variants);
        await sendTelegram(chatId,
          `✅ Vorschlag ${proposalId} umgesetzt\n\n` +
          `🎬 Video: ${cutResult.duration_s.toFixed(1)}s, ${formatFileSize(cutResult.file_size)}\n` +
          `📝 Draft: ${draft.id}\n` +
          `📋 Submission: ${submissionId}\n\n` +
          `${variantsText}\n\n` +
          `Andere Variante: \`/instaapprove ${submissionId} <nr>\`\n` +
          `Bearbeiten: \`/instaedit ${draft.id}\``
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
        const draft = await createInstaDraft({
          caption: chosen.caption,
          hashtags: chosen.hashtags,
          mediaPath: sourcePath,
          notes: `Scan ${sessionId} → Vorschlag ${proposalId}: ${proposal.title}`,
        });
        audit.log({ module: 'instagram', action: 'instagram.draft_created', entityType: 'draft', entityId: draft.id, after: { status: draft.status, source: 'scan' } }).catch(() => {});

        const variantsText = formatVariantsOutput(submissionId, variants);
        await sendTelegram(chatId,
          `✅ Vorschlag ${proposalId} umgesetzt\n\n` +
          `📸 Foto: ${sourceFile}\n` +
          `📝 Draft: ${draft.id}\n` +
          `📋 Submission: ${submissionId}\n\n` +
          `${variantsText}\n\n` +
          `Andere Variante: \`/instaapprove ${submissionId} <nr>\`\n` +
          `Bearbeiten: \`/instaedit ${draft.id}\``
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
      keyboard.push([{ text: '🎤 Eigene Richtung (Text/Sprache senden)', callback_data: `iscan_dir_${sessionId}`.slice(0, 64) }]);
      await sendTelegramWithKeyboard(chatId, msg, keyboard);
      pendingScanResponse.set(chatId, { sessionId, expiresAt: Date.now() + 10 * 60_000 });
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
    const styleContext = await getStyleProfileSummary();
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

    const videoFiles = fileAnalyses.filter(fa => fa.type === 'video');
    const imageFiles = fileAnalyses.filter(fa => fa.type === 'image');
    const mediaHint = videoFiles.length > 0
      ? `\n\nWICHTIG: Es sind ${videoFiles.length} Video-Datei(en) und ${imageFiles.length} Foto(s) verfügbar. Berücksichtige ALLE Medientypen. Wenn Videos vorhanden sind, bevorzuge ein Video-Format (reel/feed-video) mit cut_plan, das die Videos einbezieht. source_files muss ALLE verwendeten Dateien enthalten — sowohl Videos als auch Fotos.`
      : '';

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
- "source_files": ALLE verwendeten Dateien (Videos UND Fotos) — muss existierende Dateinamen sein
- "estimated_duration_s": geschätzte Dauer (nur bei Video)
- "cut_plan": nur bei Video — Objekt mit "output_file" (string) und "segments" (Array von {"source": Dateiname, "start_s": number, "end_s": number})

Regeln für cut_plan:
- source_files müssen existierende Dateinamen sein
- start_s/end_s müssen innerhalb der Datei-Dauer liegen
- Reel max 90s, Feed-Video max 60s
- output_file: "<format>-${sessionId}.mp4"
- Bei Foto-Vorschlägen: kein cut_plan
- Wenn Video-Dateien verfügbar sind: bevorzuge Video-Format und verwende die Videos im cut_plan${mediaHint}

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
        model: ANTHROPIC_MODEL,
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

  async function handleCraftCallback(chatId: string, args: string[]): Promise<void> {
    // args = ['<sessionId>', '<action>']
    if (args.length < 2) {
      await sendTelegram(chatId, '❌ Ungültige Callback-Daten.');
      return;
    }
    const sessionId = args[0];
    const action = args[1];

    const state = activeCraftDialogs.get(chatId);
    if (!state || state.sessionId !== sessionId || Date.now() > state.expiresAt) {
      activeCraftDialogs.delete(chatId);
      return;
    }

    if (action === 'ja') {
      if (state.step !== 'plan_ready') {
        return;
      }

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
          const draft = await createInstaDraft({
            caption: chosen.caption,
            hashtags: chosen.hashtags,
            mediaPath: cutResult.output_path,
            notes: `Craft ${sessionId}: ${plan.title}`,
          });
          audit.log({ module: 'instagram', action: 'instagram.draft_created', entityType: 'draft', entityId: draft.id, after: { status: draft.status, source: 'craft' } }).catch(() => {});

          const variantsText = formatVariantsOutput(submissionId, variants);
          await sendTelegram(chatId,
            `✅ Craft-Plan umgesetzt\n\n` +
            `🎬 Video: ${cutResult.duration_s.toFixed(1)}s, ${formatFileSize(cutResult.file_size)}\n` +
            `📝 Draft: ${draft.id}\n` +
            `📋 Submission: ${submissionId}\n\n` +
            `${variantsText}\n\n` +
            `Andere Variante: \`/instaapprove ${submissionId} <nr>\`\n` +
            `Bearbeiten: \`/instaedit ${draft.id}\``
          );
        } else {
          // Photo proposal — use cached analysis + variants + draft
          const fileAnalysis = state.fileAnalyses?.find(fa =>
            plan.source_files.includes(fa.fileName)
          );
          const analysis = fileAnalysis?.analysis;

          const sourceFile = plan.source_files[0];
          const sourcePath = path.join(sessionDir(sessionId), 'original', sourceFile);

          // ── Vision-aware 4:5 re-crop (E5) ──────────────────────────────
          let mediaPathForDraft = sourcePath;
          let visionCropTag = '';

          if (analysis?.subject_bbox) {
            try {
              const bbox = analysis.subject_bbox;
              const { computeFileSha256: computeSha } = await import('./session-helper.js');
              const sha256Original = computeSha(sourcePath);

              // Determine mediaIndex from DB
              const { getClient: getDbClient } = await import('../../shared/db/index.js');
              const dbClient = await getDbClient();
              let mediaIndex = 1;
              try {
                const { rows: origRows } = await dbClient.query<{ media_index: number }>(
                  `SELECT media_index FROM insta_media_edits
                   WHERE session_id = $1 AND variant = 'original' AND status != 'deleted'
                   ORDER BY media_index LIMIT 1`,
                  [sessionId],
                );
                if (origRows.length > 0) mediaIndex = origRows[0].media_index;
              } finally {
                dbClient.release();
              }

              // Idempotency check
              const {
                computeVisionParamsHash, findExistingVisionCrop,
                recordVisionCropVariant, softDeleteVariant,
              } = await import('./session-helper.js');
              const paramsHash = computeVisionParamsHash(bbox);

              const existing = await findExistingVisionCrop({
                sessionId, mediaIndex, sha256Original,
              });

              if (existing && existing.paramsHash === paramsHash && fs.existsSync(existing.outputPath)) {
                // Reuse existing vision crop
                mediaPathForDraft = existing.outputPath;
                visionCropTag = ' 🎯 vision_4x5 (cached)';
              } else {
                // Soft-delete old vision_4x5 if different params
                if (existing) {
                  await softDeleteVariant({ sessionId, mediaIndex, variant: 'vision_4x5' });
                }

                const { subjectAwareCrop4x5 } = await import('./image-edit.js');
                const cropResult = await subjectAwareCrop4x5({
                  sessionId, mediaIndex, sourcePath,
                  mediaName: sourceFile, bbox,
                });

                // Determine source from original row
                const srcClient = await getDbClient();
                let source: 'telegram' | 'ios_shortcut' | 'dashboard' = 'telegram';
                try {
                  const { rows: srcRows } = await srcClient.query<{ source: string }>(
                    `SELECT source FROM insta_media_edits
                     WHERE session_id = $1 AND variant = 'original' AND status != 'deleted'
                     LIMIT 1`,
                    [sessionId],
                  );
                  if (srcRows.length > 0) source = srcRows[0].source as typeof source;
                } finally {
                  srcClient.release();
                }

                const model = process.env.ANTHROPIC_VISION_MODEL || ANTHROPIC_MODEL;
                await recordVisionCropVariant({
                  sessionId, mediaIndex,
                  sourcePath: `${sessionId}/original/${sourceFile}`,
                  outputPath: cropResult.relativePath,
                  sha256Original, sha256Output: cropResult.sha256Output,
                  paramsHash, source,
                  visionMetadata: {
                    model, schema_version: 'v1',
                    source_hash: sha256Original,
                    subject_bbox: bbox,
                    confidence: bbox.confidence,
                    cached_at: new Date().toISOString(),
                  },
                });
                audit.log({ module: 'instagram', action: 'media.vision_4x5', entityType: 'session', entityId: sessionId, after: { mediaIndex, bbox, paramsHash } }).catch(() => {});

                mediaPathForDraft = cropResult.outputPath;
                visionCropTag = ' 🎯 vision_4x5';
              }
            } catch (visionErr: any) {
              api.logger.warn(`[executive-agent] vision crop failed, using fallback: ${visionErr.message}`);
              // Fallback: try center_4x5 if it exists
              const baseName = sourceFile.replace(/\.[^.]+$/, '');
              const centerPath = path.join(sessionDir(sessionId), 'edited', `${baseName}-center_4x5.jpg`);
              if (fs.existsSync(centerPath)) {
                mediaPathForDraft = centerPath;
              }
            }
          } else {
            // No bbox — fallback to center_4x5 if it exists
            const baseName = sourceFile.replace(/\.[^.]+$/, '');
            const centerPath = path.join(sessionDir(sessionId), 'edited', `${baseName}-center_4x5.jpg`);
            if (fs.existsSync(centerPath)) {
              mediaPathForDraft = centerPath;
            }
          }

          const submissionId = generateSubmissionId(plan.title);
          const submission: Submission = {
            id: submissionId,
            media: [{ type: 'image', path: mediaPathForDraft, mimeType: 'image/jpeg' }],
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
          const draft = await createInstaDraft({
            caption: chosen.caption,
            hashtags: chosen.hashtags,
            mediaPath: mediaPathForDraft,
            notes: `Craft ${sessionId}: ${plan.title}`,
          });
          audit.log({ module: 'instagram', action: 'instagram.draft_created', entityType: 'draft', entityId: draft.id, after: { status: draft.status, source: 'craft' } }).catch(() => {});

          const variantsText = formatVariantsOutput(submissionId, variants);
          await sendTelegram(chatId,
            `✅ Craft-Plan umgesetzt\n\n` +
            `📸 Foto: ${sourceFile}${visionCropTag}\n` +
            `📝 Draft: ${draft.id}\n` +
            `📋 Submission: ${submissionId}\n\n` +
            `${variantsText}\n\n` +
            `Andere Variante: \`/instaapprove ${submissionId} <nr>\`\n` +
            `Bearbeiten: \`/instaedit ${draft.id}\``
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
        return;
      }
      state.step = 'adjusting';
      await sendTelegram(chatId, '✏️ Sende deine Anpassung (Text oder Sprachnachricht):');
    } else if (action === 'abbrechen') {
      activeCraftDialogs.delete(chatId);
      const freshSession = loadRawSession(sessionId);
      if (freshSession && freshSession.status === 'crafting') {
        freshSession.status = freshSession.scan_result ? 'scanned' : 'active';
        saveRawSession(freshSession);
      }
      await sendTelegram(chatId, '❌ Craft-Dialog abgebrochen.');
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


  // ── Instagram Callback Dispatcher ───────────────────────────────────────
  api.on('message_received', async (event: any) => {
    try {
      // ── icraft_ callbacks ──
      const icraftCb = parseCallbackEvent(event, 'icraft');
      if (icraftCb) {
        const chatId = icraftCb.senderId;
        if (icraftCb.payload.startsWith('go_')) {
          // icraft_go_<sessionId> → launch craft mode
          const sessionId = icraftCb.payload.slice(3);
          await sendTelegram(chatId, `🎨 Craft-Modus für ${sessionId} — sende deine kreative Richtung als nächste Nachricht.\n\nOder direkt:\n\`/instacraft ${sessionId} <richtung>\``);
          return;
        }
        // icraft_<sessionId>::<action>
        await handleCraftCallback(chatId, icraftCb.args);
        return;
      }

      // ── iscan_ callbacks ──
      const iscanCb = parseCallbackEvent(event, 'iscan');
      if (iscanCb) {
        const chatId = iscanCb.senderId;
        if (iscanCb.payload.startsWith('ask_')) {
          // iscan_ask_<sessionId>::<action>
          if (iscanCb.args.length < 2) return;
          // args[0] = 'ask_<sessionId>', extract sessionId
          const askSessionId = iscanCb.args[0].slice(4);
          const askAction = iscanCb.args[1];
          if (askAction === 'craft') {
            pendingScanResponse.set(chatId, { sessionId: askSessionId, expiresAt: Date.now() + 10 * 60_000 });
            await sendTelegram(chatId, `🎯 Sende deine Vorstellung als Text oder Sprachnachricht für Session ${askSessionId}.`);
          } else {
            if (instaScanActive.has(chatId)) return;
            instaScanActive.add(chatId);
            runInstascanPipeline(askSessionId, chatId).catch(err => {
              api.logger.error(`[executive-agent] iscan_ask scan CRASH: ${err?.message}`);
            });
          }
          return;
        }
        if (iscanCb.payload.startsWith('dir_')) {
          // iscan_dir_<sessionId>
          const sessionId = iscanCb.payload.slice(4);
          pendingScanResponse.set(chatId, { sessionId, expiresAt: Date.now() + 10 * 60_000 });
          await sendTelegram(chatId, `🎤 Sende deine kreative Richtung für Session ${sessionId} als Text oder Sprachnachricht.`);
          return;
        }
        if (iscanCb.payload.startsWith('go_')) {
          // iscan_go_<sessionId>
          const sessionId = iscanCb.payload.slice(3);
          if (instaScanActive.has(chatId)) return;
          instaScanActive.add(chatId);
          runInstascanPipeline(sessionId, chatId).catch(err => {
            api.logger.error(`[executive-agent] iscan_go callback CRASH: ${err?.message}`);
          });
          return;
        }
        // iscan_<sessionId>::<proposalId>
        await handleInstascanCallback(chatId, iscanCb.args);
        return;
      }

      // ── isub_ callbacks ──
      const isubCb = parseCallbackEvent(event, 'isub');
      if (isubCb) {
        const chatId = isubCb.senderId;
        const sessionId = isubCb.args[0];
        handleInstasubmitCallback(chatId, sessionId).catch(err => {
          api.logger.error(`[executive-agent] isub callback CRASH: ${err?.message}`);
        });
        return;
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] instagram callback Fehler: ${e?.message}`);
    }
  });

} // end registerInstagramCommands

// ── Briefing Helper ─────────────────────────────────────────────────────────

export async function getInstagramBriefingLines(metaAppId: string, metaAppSecret: string): Promise<string[]> {
  const instaLines: string[] = [];
  try {
    if (instaAuthorized() && metaAppId && metaAppSecret) {
      try { await ensureInstaToken(metaAppId, metaAppSecret); } catch {}
    }

    const daysLeft = tokenDaysRemaining();
    if (daysLeft > 0 && daysLeft < 7) {
      instaLines.push(`⚠️ Token läuft in ${daysLeft} Tagen ab!`);
    }

    if (instaAuthorized()) {
      const t = loadInstaTokens();
      if (t?.access_token && t?.ig_business_id) {
        try {
          const insights = await fetchInsights(t.access_token, t.ig_business_id, true);
          instaLines.push(`- Follower: ${insights.followers_count.toLocaleString('de')} | Engagement: ${insights.engagement_rate}%`);
        } catch (e: any) {
          const errMsg = e?.message || String(e);
          if (errMsg.includes('Session has expired') || errMsg.includes('expired') || errMsg.includes('code":190') || errMsg.includes('code": 190')) {
            await markInstaTokenFailed();
            try {
              const refreshed = await ensureInstaToken(metaAppId, metaAppSecret, true);
              const retryInsights = await fetchInsights(refreshed.access_token, refreshed.ig_business_id, true);
              instaLines.push(`- Follower: ${retryInsights.followers_count.toLocaleString('de')} | Engagement: ${retryInsights.engagement_rate}%`);
              instaLines.push(`✅ Token automatisch erneuert`);
            } catch {
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

    const openInstaDrafts = await listInstaDrafts('draft');
    if (openInstaDrafts.length > 0) {
      instaLines.push(`- ${openInstaDrafts.length} Draft${openInstaDrafts.length > 1 ? 's' : ''} offen`);
    }
  } catch (e: any) {
    instaLines.push(`❌ Instagram-Fehler: ${(e?.message || String(e)).slice(0, 100)}`);
  }
  return instaLines;
}
