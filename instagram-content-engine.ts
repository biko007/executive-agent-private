import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ANTHROPIC_MODEL } from './src/shared/utils/index.js';

// ── Paths ──────────────────────────────────────────────────────────────────

const INSTA_DIR = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal/instagram');
const INBOX_DIR = path.join(INSTA_DIR, 'inbox');
const MEDIA_DIR = path.join(INBOX_DIR, 'media');
const FRAMES_TMP = '/tmp/openclaw-frames';
const STATIC_DIR = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/.openclaw/extensions/executive-agent/artifacts/personal/instagram/static',
);
const STATIC_BASE_URL = 'https://app.bikobickel.de/static/instagram';

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface FrameAnalysis {
  timestamp_s: number;
  description: string;
  mood: string;
}

export interface SubjectBbox {
  x: number;  y: number;  w: number;  h: number;  confidence: number;
}

export interface VisionAnalysis {
  subjects: string[];
  mood: string;
  setting: string;
  composition: string;
  colors: string[];
  narrative_hooks: string[];
  visual_quality: 'high' | 'medium' | 'low';
  pillar_match: string[];
  storyboard?: FrameAnalysis[];
  subject_bbox?: SubjectBbox;
}

export interface SubmissionMedia {
  type: 'image' | 'video';
  path: string;
  mimeType: string;
  frames?: FrameAnalysis[];
}

export interface ContentVariant {
  type: 'story' | 'insight' | 'hook';
  caption: string;
  hashtags: string[];
  hook?: string;
  critique?: string;
}

export interface Submission {
  id: string;
  media: SubmissionMedia[];
  context: { user_note: string; location?: string; occasion?: string };
  status: 'received' | 'analyzed' | 'generated' | 'approved' | 'rejected';
  analysis?: VisionAnalysis;
  variants?: ContentVariant[];
  selected_variant?: number;
  created: string;
}

// ── Internal helpers ───────────────────────────────────────────────────────

// ── Sprechende ID-Generierung ──────────────────────────────────────────────

// Stoppwörter die keinen Kontext liefern
const STOP_WORDS = new Set([
  'aus', 'in', 'von', 'mit', 'fuer', 'und', 'der', 'die', 'das', 'den',
  'dem', 'ein', 'eine', 'einen', 'einem', 'einer', 'im', 'am', 'an',
  'auf', 'bei', 'nach', 'zum', 'zur', 'vom', 'des', 'the', 'a', 'an',
  'for', 'from', 'with', 'and', 'test', 'foto', 'photo', 'video', 'bild',
  'testbild', 'testvideo',
]);

function extractContext(text: string): string {
  // Normalize: lowercase, replace non-alpha with spaces, collapse whitespace
  const words = text
    .toLowerCase()
    .replace(/[^a-zäöüß\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  if (words.length === 0) return '';
  // Take first meaningful word, transliterate umlauts, strip non a-z
  let ctx = words[0]
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  ctx = ctx.replace(/[^a-z]/g, '');
  return ctx.slice(0, 12); // keep short to stay within 20 char total ID limit
}

export function generateSubmissionId(userNote: string, location?: string): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');

  const ctx = extractContext(userNote) || (location ? extractContext(location) : '');
  if (ctx) return `sub-${ctx}-${dd}${mm}`;

  const yy = String(now.getFullYear()).slice(2);
  return `sub-${dd}${mm}${yy}`;
}

export function generateDraftId(caption: string): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');

  const ctx = extractContext(caption);
  if (ctx) return `insta-${ctx}-${dd}${mm}`;

  const yy = String(now.getFullYear()).slice(2);
  return `insta-${dd}${mm}${yy}`;
}

function ensureDirs() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_TMP, { recursive: true });
}

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

// ── Storage ────────────────────────────────────────────────────────────────

export async function saveSubmission(submission: Submission): Promise<void> {
  ensureDirs();
  const filePath = path.join(INBOX_DIR, `${submission.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(submission, null, 2), 'utf-8');
}

export async function loadSubmission(id: string): Promise<Submission> {
  const filePath = path.join(INBOX_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Submission ${id} nicht gefunden`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// ── Vision Analysis ────────────────────────────────────────────────────────

function roundBbox(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function isValidBbox(x: number, y: number, w: number, h: number, confidence: number): boolean {
  return x >= 0 && x <= 1 && y >= 0 && y <= 1
    && w >= 0.05 && w <= 1 && h >= 0.05 && h <= 1
    && x + w <= 1.01 && y + h <= 1.01
    && confidence >= 0 && confidence <= 1;
}

export { roundBbox, isValidBbox };

async function callVision(base64: string, mimeType: string, retry = true, includeBbox = false): Promise<VisionAnalysis> {
  const apiKey = readAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt (in ~/.config/openclaw/env eintragen)');

  const model = process.env.ANTHROPIC_VISION_MODEL || ANTHROPIC_MODEL;

  const bboxInstruction = includeBbox
    ? '\nZusaetzlich: Bestimme die Bounding Box des Hauptsubjekts als relative Koordinaten (0-1):\n' +
      '"subject_bbox": { "x": <left>, "y": <top>, "w": <width>, "h": <height>, "confidence": <0-1> }\n' +
      'x,y = obere linke Ecke relativ zur Bildgroesse. confidence = wie sicher du dir bist.\n'
    : '';

  const bboxField = includeBbox ? ',\n  "subject_bbox": { "x": number, "y": number, "w": number, "h": number, "confidence": number }' : '';

  const userPrompt =
    'Analysiere dieses Bild und gib ein JSON-Objekt zurueck:\n' +
    '{ "subjects": string[], "mood": string, "setting": string, "composition": string,\n' +
    '  "colors": string[], "narrative_hooks": string[], "visual_quality": "high"|"medium"|"low",\n' +
    '  "pillar_match": string[]' + bboxField + ' }\n' +
    'pillar_match: Welche dieser Felder passen? culture, technology, style, health, freedom\n' +
    bboxInstruction +
    'Antworte NUR mit dem JSON-Objekt, kein Markdown, keine Erklaerungen.';

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
        model,
        max_tokens: 1000,
        system: 'Du bist ein Instagram-Content-Analyst fuer eine Personal Brand. Antworte ausschliesslich mit JSON, kein Markdown, keine Erklaerungen. Sprache: Englisch.',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64 },
            },
            { type: 'text', text: userPrompt },
          ],
        }],
      }),
    },
    60000,
  );

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Vision API ${res.status}: ${err.slice(0, 300)}`);
  }

  const data: any = await res.json();
  const text: string = data?.content?.[0]?.text || '';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    if (retry) return callVision(base64, mimeType, false, includeBbox);
    throw new Error(`Vision: kein JSON in Antwort — ${text.slice(0, 200)}`);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    let subject_bbox: SubjectBbox | undefined;
    if (includeBbox && parsed.subject_bbox) {
      const bb = parsed.subject_bbox;
      const x = roundBbox(Number(bb.x)), y = roundBbox(Number(bb.y));
      const w = roundBbox(Number(bb.w)), h = roundBbox(Number(bb.h));
      const confidence = roundBbox(Number(bb.confidence));
      if (isValidBbox(x, y, w, h, confidence)) {
        subject_bbox = { x, y, w, h, confidence };
      }
    }

    return {
      subjects: Array.isArray(parsed.subjects) ? parsed.subjects.map(String).slice(0, 5) : [],
      mood: String(parsed.mood || ''),
      setting: String(parsed.setting || ''),
      composition: String(parsed.composition || ''),
      colors: Array.isArray(parsed.colors) ? parsed.colors.map(String) : [],
      narrative_hooks: Array.isArray(parsed.narrative_hooks) ? parsed.narrative_hooks.map(String) : [],
      visual_quality: ['high', 'medium', 'low'].includes(parsed.visual_quality) ? parsed.visual_quality : 'medium',
      pillar_match: Array.isArray(parsed.pillar_match) ? parsed.pillar_match.map(String) : [],
      subject_bbox,
    };
  } catch (e: any) {
    if (retry) return callVision(base64, mimeType, false, includeBbox);
    throw new Error(`Vision: JSON parse fehlgeschlagen — ${e.message}`);
  }
}

export async function analyzeImage(imagePath: string, options?: { includeBbox?: boolean }): Promise<VisionAnalysis> {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Bilddatei nicht gefunden: ${imagePath}`);
  }
  const data = fs.readFileSync(imagePath);
  const base64 = data.toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  };
  const mimeType = mimeMap[ext] || 'image/jpeg';
  return callVision(base64, mimeType, true, options?.includeBbox ?? false);
}

export async function analyzeVideo(videoPath: string): Promise<VisionAnalysis> {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Videodatei nicht gefunden: ${videoPath}`);
  }

  // Check ffmpeg
  try {
    execSync('which ffmpeg', { stdio: 'ignore' });
  } catch {
    throw new Error('ffmpeg nicht installiert, bitte `sudo apt-get install ffmpeg` ausfuehren');
  }

  // Extract frames
  const frameDir = path.join(FRAMES_TMP, `frames_${Date.now()}`);
  fs.mkdirSync(frameDir, { recursive: true });

  try {
    execSync(
      `ffmpeg -i "${videoPath}" -vf fps=0.5 -frames:v 8 "${frameDir}/frame_%02d.jpg" -y`,
      { stdio: 'ignore', timeout: 30000 },
    );
  } catch (e: any) {
    throw new Error(`ffmpeg Frame-Extraktion fehlgeschlagen: ${e.message}`);
  }

  // Collect extracted frames
  const frameFiles = fs.readdirSync(frameDir)
    .filter(f => f.endsWith('.jpg'))
    .sort();

  if (frameFiles.length === 0) {
    throw new Error('ffmpeg hat keine Frames extrahiert');
  }

  // Analyze each frame
  const storyboard: FrameAnalysis[] = [];
  const allAnalyses: VisionAnalysis[] = [];

  for (let i = 0; i < frameFiles.length; i++) {
    const framePath = path.join(frameDir, frameFiles[i]);
    const analysis = await analyzeImage(framePath);
    allAnalyses.push(analysis);
    storyboard.push({
      timestamp_s: i * 2,
      description: analysis.subjects.join(', ') || analysis.setting,
      mood: analysis.mood,
    });
  }

  // Cleanup temp frames
  try {
    fs.rmSync(frameDir, { recursive: true, force: true });
  } catch {}

  // Aggregate analysis from all frames
  const moodCounts = new Map<string, number>();
  const settingCounts = new Map<string, number>();
  const allColors = new Set<string>();
  const allHooks = new Set<string>();
  const allPillars = new Set<string>();
  const subjectCounts = new Map<string, number>();
  let bestQuality: 'high' | 'medium' | 'low' = 'low';
  const qualityOrder = { high: 3, medium: 2, low: 1 };

  for (const a of allAnalyses) {
    moodCounts.set(a.mood, (moodCounts.get(a.mood) || 0) + 1);
    settingCounts.set(a.setting, (settingCounts.get(a.setting) || 0) + 1);
    a.colors.forEach(c => allColors.add(c));
    a.narrative_hooks.forEach(h => allHooks.add(h));
    a.pillar_match.forEach(p => allPillars.add(p));
    a.subjects.forEach(s => subjectCounts.set(s, (subjectCounts.get(s) || 0) + 1));
    if (qualityOrder[a.visual_quality] > qualityOrder[bestQuality]) {
      bestQuality = a.visual_quality;
    }
  }

  const dominant = (m: Map<string, number>) => {
    let best = ''; let max = 0;
    for (const [k, v] of m) { if (v > max) { max = v; best = k; } }
    return best;
  };

  // Top 5 subjects by frequency across all frames
  const topSubjects = [...subjectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([s]) => s);

  return {
    subjects: topSubjects,
    mood: dominant(moodCounts),
    setting: dominant(settingCounts),
    composition: allAnalyses[0]?.composition || '',
    colors: [...allColors].slice(0, 8),
    narrative_hooks: [...allHooks].slice(0, 6),
    visual_quality: bestQuality,
    pillar_match: [...allPillars],
    storyboard,
  };
}

// ── Summary Formatter ──────────────────────────────────────────────────────

export function formatAnalysisSummary(analysis: VisionAnalysis, mediaType: 'image' | 'video'): string {
  const lines: string[] = [];
  lines.push(`Typ: ${mediaType === 'image' ? 'Bild' : 'Video'}`);
  lines.push(`Mood: ${analysis.mood}`);
  lines.push(`Setting: ${analysis.setting}`);
  lines.push(`Subjects: ${analysis.subjects.join(', ')}`);
  lines.push(`Qualitaet: ${analysis.visual_quality}`);
  lines.push(`Pillar-Match: ${analysis.pillar_match.join(', ') || 'keine'}`);
  lines.push(`Narrative Hooks: ${analysis.narrative_hooks.slice(0, 2).join(', ') || 'keine'}`);
  if (mediaType === 'video' && analysis.storyboard) {
    lines.push(`Storyboard-Frames: ${analysis.storyboard.length}`);
  }
  return lines.join('\n');
}

// ── Media directory helper ─────────────────────────────────────────────────

export function getMediaDir(submissionId: string): string {
  const dir = path.join(MEDIA_DIR, submissionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Pass 2: Top-Performer-Kontext ─────────────────────────────────────────

const MEDIA_CACHE_FILE = path.join(INSTA_DIR, 'media-cache.json');
const INSIGHTS_CACHE_FILE = path.join(INSTA_DIR, 'insights-cache.json');

export async function getTopPerformerContext(): Promise<string> {
  try {
    if (!fs.existsSync(MEDIA_CACHE_FILE) || !fs.existsSync(INSIGHTS_CACHE_FILE)) return '';

    const mediaCache = JSON.parse(fs.readFileSync(MEDIA_CACHE_FILE, 'utf-8'));
    const insightsCache = JSON.parse(fs.readFileSync(INSIGHTS_CACHE_FILE, 'utf-8'));
    const items: any[] = mediaCache?.items;
    const followers: number = insightsCache?.followers_count;
    if (!Array.isArray(items) || items.length === 0 || !followers || followers <= 0) return '';

    // Filter to last 90 days
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const recent = items.filter((item: any) => {
      const ts = item.timestamp ? new Date(item.timestamp).getTime() : 0;
      return ts > cutoff;
    });
    if (recent.length === 0) return '';

    // Calculate engagement rate per post: (likes + comments) / followers * 100
    const scored = recent.map((item: any) => {
      const likes = item.like_count || 0;
      const comments = item.comments_count || 0;
      const er = ((likes + comments) / followers) * 100;
      return { ...item, er };
    });

    // Sort by engagement rate descending, take top 8
    scored.sort((a: any, b: any) => b.er - a.er);
    const top = scored.slice(0, 8);

    const lines = top.map((item: any, i: number) => {
      const captionSnippet = (item.caption || '').replace(/\n/g, ' ').slice(0, 80);
      const type = item.media_type === 'VIDEO' ? 'Reel' : item.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Image';
      const reach = item.like_count + item.comments_count;
      return `${i + 1}. [${captionSnippet}] | ER: ${item.er.toFixed(1)}% | reach: ${reach} | type: ${type}`;
    });

    return 'Top performing posts (by engagement rate):\n' + lines.join('\n');
  } catch {
    return '';
  }
}

// ── Pass 3: Varianten-Generierung ─────────────────────────────────────────

const STYLE_PROFILE_FILE = path.join(INSTA_DIR, 'style-profile.json');

function loadStyleProfileDirect(): any {
  if (!fs.existsSync(STYLE_PROFILE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STYLE_PROFILE_FILE, 'utf-8')); }
  catch { return null; }
}

export async function generateVariants(submission: Submission): Promise<ContentVariant[]> {
  const apiKey = readAnthropicKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');

  const sp = loadStyleProfileDirect();
  if (!sp) throw new Error('Style-Profil nicht gefunden (style-profile.json)');

  const analysis = submission.analysis;
  if (!analysis) throw new Error('Submission hat keine Vision-Analyse');

  const topPerformerContext = await getTopPerformerContext();

  // Build system prompt from style profile
  const systemPrompt = [
    'Du bist ein Instagram-Content-Autor fuer diese Personal Brand:',
    '',
    'MARKENKERN:',
    sp.meta?.principle || '',
    '',
    'BIO: ' + (sp.positioning?.bio_recommended?.en || ''),
    '',
    'STIMME: ' + (sp.voice?.core_adjectives?.join(', ') || ''),
    'TONALITAET: ' + (sp.voice?.extended_tone?.join(', ') || ''),
    '',
    'HAUPTFORMEL: Post passt wenn mindestens 2 von 5 Feldern beruehrt:',
    (sp.main_formula?.fields?.join(', ') || ''),
    '',
    'SIGNATURE PHRASES (EN): ' + (sp.signature_phrases?.en?.map((p: any) => p.phrase).join(' | ') || ''),
    'SIGNATURE PHRASES (DE): ' + (sp.signature_phrases?.de?.map((p: any) => p.phrase).join(' | ') || ''),
    '',
    'DO: ' + (sp.dos?.map((d: any) => d.rule).join(' | ') || ''),
    '',
    "DON'T: " + (sp.donts?.map((d: any) => d.title).join(' | ') || ''),
    '',
    'CAPTION-STRUKTUR: Hook als erste Zeile. Max 2200 Zeichen.',
    'Keine Coach-Sprache. Keine Hype-Sprache. Klar, gelassen, neugierig.',
    '',
    topPerformerContext ? 'TOP PERFORMING POSTS (Few-Shot):\n' + topPerformerContext : '',
    '',
    'Antworte AUSSCHLIESSLICH mit JSON-Array, kein Markdown, keine Erklaerungen.',
  ].join('\n');

  // Build user prompt from analysis + context
  const userPrompt = [
    'Bild-Analyse:',
    `Mood: ${analysis.mood}`,
    `Setting: ${analysis.setting}`,
    `Subjects: ${analysis.subjects.join(', ')}`,
    `Narrative Hooks: ${analysis.narrative_hooks.join(', ')}`,
    `Pillar-Match: ${analysis.pillar_match.join(', ')}`,
    `Visual Quality: ${analysis.visual_quality}`,
    '',
    `User-Kontext: ${submission.context.user_note}`,
    submission.context.location ? `Ort: ${submission.context.location}` : '',
    submission.context.occasion ? `Anlass: ${submission.context.occasion}` : '',
    '',
    'Erstelle 3 Caption-Varianten als JSON-Array:',
    '[',
    '  {',
    '    "type": "story",',
    '    "caption": "...",',
    '    "hashtags": ["...", "..."],',
    '    "hook": "erste Zeile der Caption"',
    '  },',
    '  {',
    '    "type": "insight",',
    '    "caption": "...",',
    '    "hashtags": ["...", "..."],',
    '    "hook": "erste Zeile der Caption"',
    '  },',
    '  {',
    '    "type": "hook",',
    '    "caption": "...",',
    '    "hashtags": ["...", "..."],',
    '    "hook": "erste Zeile der Caption"',
    '  }',
    ']',
    '',
    'Varianten-Definitionen:',
    '- story: persoenliche Erzaehlung aus Ich-Perspektive, Moment beschreiben, einordnen was er bedeutet',
    '- insight: Beobachtung/Lehre die das Bild ausloest, forward-looking, nicht rueckwaertsgewandt',
    '- hook: starke erste Zeile die Engagement triggert (Frage oder Aussage), dann kurze Einordnung',
    '',
    'Hashtags: 3-8 pro Variante, Mix aus pools in style-profile',
    '(culture/technology/style/health/freedom je nach Pillar-Match).',
    'Sprache: EN wenn international/lifestyle, DE wenn Politik/gesellschaftlich.',
  ].filter(Boolean).join('\n');

  const model = process.env.ANTHROPIC_VISION_MODEL || ANTHROPIC_MODEL;

  const callApi = async (retry: boolean): Promise<ContentVariant[]> => {
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
          model,
          max_tokens: 2000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      },
      90000, // 90s timeout for longer generation
    );

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${err.slice(0, 300)}`);
    }

    const data: any = await res.json();
    const text: string = data?.content?.[0]?.text || '';

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      if (retry) return callApi(false);
      throw new Error(`Varianten: kein JSON-Array in Antwort — ${text.slice(0, 200)}`);
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        if (retry) return callApi(false);
        throw new Error('Varianten: leeres Array');
      }

      return parsed.map((v: any) => ({
        type: ['story', 'insight', 'hook'].includes(v.type) ? v.type : 'story',
        caption: String(v.caption || ''),
        hashtags: Array.isArray(v.hashtags) ? v.hashtags.map(String) : [],
        hook: String(v.hook || ''),
      }));
    } catch (e: any) {
      if (retry) return callApi(false);
      throw new Error(`Varianten: JSON parse fehlgeschlagen — ${e.message}`);
    }
  };

  const variants = await callApi(true);

  // Update submission
  submission.variants = variants;
  submission.status = 'generated';
  await saveSubmission(submission);

  return variants;
}

// ── Media Staging (copy to public static URL for Meta Graph API) ──────────

export interface StagedMedia {
  localPath: string;   // absolute path in static dir
  publicUrl: string;   // https://app.bikobickel.de/static/instagram/<file>
  filename: string;    // filename only
}

/**
 * Copy a single media file to the nginx static directory and return its public URL.
 * Filename format: <submissionId>-<index>.<ext> to avoid collisions.
 */
export function stageMediaFile(
  sourcePath: string,
  submissionId: string,
  index: number,
): StagedMedia {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Quelldatei nicht gefunden: ${sourcePath}`);
  }
  fs.mkdirSync(STATIC_DIR, { recursive: true });

  const ext = path.extname(sourcePath).toLowerCase() || '.jpg';
  const filename = `${submissionId}-${String(index).padStart(2, '0')}${ext}`;
  const destPath = path.join(STATIC_DIR, filename);
  fs.copyFileSync(sourcePath, destPath);

  return {
    localPath: destPath,
    publicUrl: `${STATIC_BASE_URL}/${filename}`,
    filename,
  };
}

/**
 * Stage multiple media files for a submission. Returns array of staged media in order.
 */
export function stageAllMedia(
  files: Array<{ path: string }>,
  submissionId: string,
): StagedMedia[] {
  return files.map((f, i) => stageMediaFile(f.path, submissionId, i + 1));
}

/**
 * Remove staged files for a submission (cleanup after publish or failure).
 */
export function cleanupStagedMedia(submissionId: string): number {
  if (!fs.existsSync(STATIC_DIR)) return 0;
  const prefix = `${submissionId}-`;
  const files = fs.readdirSync(STATIC_DIR).filter(f => f.startsWith(prefix));
  for (const f of files) {
    try { fs.unlinkSync(path.join(STATIC_DIR, f)); } catch {}
  }
  return files.length;
}
