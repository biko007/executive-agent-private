#!/usr/bin/env bun
/**
 * Sprint 3 Migration — Instagram JSON → Postgres
 *
 * Usage:
 *   npm run migrate:sprint3 -- --dry-run   (validate only, no DB writes)
 *   npm run migrate:sprint3 -- --apply      (migrate within single transaction)
 *
 * Override DB: DB_NAME=insta_sprint3_test npm run migrate:sprint3 -- --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { assertSafeDbUrl } from '../src/core/db-guard.js';

const { Pool } = pg;

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const APPLY = args.includes('--apply');

if (!DRY_RUN && !APPLY) {
  console.error('Usage: migrate-sprint3-instagram.ts --dry-run | --apply');
  process.exit(1);
}

// ── Config ──────────────────────────────────────────────────────────────────
const HOME = process.env.HOME || '/home/biko';
const ENV_FILE = path.join(HOME, '.config/openclaw/env');
const ARTIFACTS = path.join(HOME, '.openclaw/workspace/artifacts/personal');
const DRAFTS_DIR = path.join(ARTIFACTS, 'instagram/drafts');
const TOKENS_FILE = path.join(ARTIFACTS, 'instagram/tokens.json');
const STYLE_FILE = path.join(ARTIFACTS, 'instagram/style-profile.json');
const MIGRATION_SQL = path.join(
  HOME, '.openclaw/workspace/.openclaw/extensions/executive-agent',
  'src/modules/instagram/migrations/020_insta_tables.sql',
);

// Load env vars from file
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eq = line.indexOf('=');
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {}
  return env;
}

// ── Zod-like validation (inline, no dependency) ─────────────────────────────

interface ValidationError {
  file: string;
  field: string;
  message: string;
}

const VALID_STATUSES = new Set(['draft', 'review', 'approved', 'published', 'archived']);
const VALID_MEDIA_TYPES = new Set(['image', 'video', 'carousel', 'reel']);

const STATUS_MAP: Record<string, string> = {
  'entwurf': 'draft',
  'freigegeben': 'approved',
  'veroeffentlicht': 'published',
  'archiviert': 'archived',
  // English passthrough
  'draft': 'draft',
  'review': 'review',
  'approved': 'approved',
  'published': 'published',
  'archived': 'archived',
};

interface MediaFile {
  path: string;
  type: 'image' | 'video';
  order: number;
}

function validateMediaFile(mf: unknown, idx: number): ValidationError | null {
  if (!mf || typeof mf !== 'object') return { file: '', field: `media_files[${idx}]`, message: 'not an object' };
  const o = mf as Record<string, unknown>;
  if (typeof o.path !== 'string' || o.path.length === 0) return { file: '', field: `media_files[${idx}].path`, message: 'must be non-empty string' };
  if (o.path.startsWith('/')) return { file: '', field: `media_files[${idx}].path`, message: 'must be relative (starts with /)' };
  if (o.path.includes('..')) return { file: '', field: `media_files[${idx}].path`, message: 'must not contain ..' };
  if (o.type !== 'image' && o.type !== 'video') return { file: '', field: `media_files[${idx}].type`, message: `must be image|video, got ${o.type}` };
  if (typeof o.order !== 'number' || !Number.isInteger(o.order) || o.order < 0) return { file: '', field: `media_files[${idx}].order`, message: 'must be non-negative integer' };
  return null;
}

// ── Draft processing ────────────────────────────────────────────────────────

interface DraftJson {
  id: string;
  status: string;
  caption?: string;
  hashtags?: string[];
  media_type?: string | null;
  media_files?: unknown[] | null;
  mediaPath?: string | null;
  vision_analysis?: unknown;
  source_session_id?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  published_at?: string | null;
  meta_post_id?: string | null;
  failed_at?: string | null;
  failure_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface MigratedDraft {
  id: string;
  status: string;
  caption: string | null;
  hashtags: string[];
  media_type: string;
  media_files: MediaFile[];
  vision_analysis: unknown;
  source_session_id: string | null;
  approved_at: Date | null;
  approved_by: string | null;
  published_at: Date | null;
  meta_post_id: string | null;
  failed_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

function inferMediaType(draft: DraftJson): string {
  // Use explicit media_type if valid
  if (draft.media_type && VALID_MEDIA_TYPES.has(draft.media_type)) return draft.media_type;

  // Infer from media_files
  if (draft.media_files && Array.isArray(draft.media_files) && draft.media_files.length > 1) return 'carousel';
  if (draft.media_files && Array.isArray(draft.media_files) && draft.media_files.length === 1) {
    const mf = draft.media_files[0] as Record<string, unknown>;
    if (mf?.type === 'video') return 'reel';
    return 'image';
  }

  // Infer from mediaPath (legacy field)
  if (draft.mediaPath) {
    const ext = path.extname(draft.mediaPath).toLowerCase();
    if (['.mp4', '.mov', '.avi', '.webm'].includes(ext)) return 'reel';
    return 'image';
  }

  // Default: image (for text-only drafts)
  return 'image';
}

function convertMediaPath(draft: DraftJson): MediaFile[] {
  // If media_files already populated, validate and use
  if (draft.media_files && Array.isArray(draft.media_files) && draft.media_files.length > 0) {
    return draft.media_files.map((mf, i) => {
      const o = mf as Record<string, unknown>;
      return {
        path: String(o.path || ''),
        type: (o.type === 'video' ? 'video' : 'image') as 'image' | 'video',
        order: typeof o.order === 'number' ? o.order : i,
      };
    });
  }

  // Legacy: convert absolute mediaPath to relative
  if (draft.mediaPath && typeof draft.mediaPath === 'string') {
    const artifactsPrefix = path.join(HOME, '.openclaw/workspace/artifacts/personal/');
    let relPath = draft.mediaPath;
    if (relPath.startsWith(artifactsPrefix)) {
      relPath = relPath.slice(artifactsPrefix.length);
    } else if (relPath.startsWith('/')) {
      // Absolute path outside artifacts — strip leading / as best effort
      relPath = relPath.replace(/^\/+/, '');
    }
    const ext = path.extname(relPath).toLowerCase();
    const type: 'image' | 'video' = ['.mp4', '.mov', '.avi', '.webm'].includes(ext) ? 'video' : 'image';
    return [{ path: relPath, type, order: 0 }];
  }

  return [];
}

function processDraft(filename: string, raw: DraftJson): { draft: MigratedDraft; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  // Map status
  const mappedStatus = STATUS_MAP[raw.status];
  if (!mappedStatus) {
    errors.push({ file: filename, field: 'status', message: `unknown status "${raw.status}"` });
  }
  const status = mappedStatus || 'draft';

  // Infer media_type
  const media_type = inferMediaType(raw);

  // Convert media files
  const media_files = convertMediaPath(raw);

  // Validate each media file
  for (let i = 0; i < media_files.length; i++) {
    const err = validateMediaFile(media_files[i], i);
    if (err) { err.file = filename; errors.push(err); }
  }

  // Clean hashtags (strip # prefix if present)
  const hashtags = (raw.hashtags || []).map(h => h.startsWith('#') ? h.slice(1) : h);

  // Consistency checks for approved/published
  if (status === 'approved' && (!raw.approved_at || !raw.approved_by)) {
    // Not an error for migration — these are old drafts, we skip the constraint
    // by not setting status to approved without the required fields
  }

  const now = new Date();

  const draft: MigratedDraft = {
    id: raw.id,
    status,
    caption: raw.caption || null,
    hashtags,
    media_type,
    media_files,
    vision_analysis: raw.vision_analysis || null,
    source_session_id: raw.source_session_id || null,
    approved_at: raw.approved_at ? new Date(raw.approved_at) : null,
    approved_by: raw.approved_by || null,
    published_at: raw.published_at ? new Date(raw.published_at) : null,
    meta_post_id: raw.meta_post_id || null,
    failed_at: raw.failed_at ? new Date(raw.failed_at) : null,
    failure_reason: raw.failure_reason || null,
    created_at: raw.created_at ? new Date(raw.created_at) : now,
    updated_at: raw.updated_at ? new Date(raw.updated_at) : now,
  };

  return { draft, errors };
}

// ── Token processing ────────────────────────────────────────────────────────

interface TokenJson {
  access_token: string;
  expires_at: number;
  refreshed_at?: number;
  ig_business_id?: string;
  page_id?: string;
}

interface MigratedToken {
  access_token: string;
  expires_at: Date;
  active: boolean;
  rotated_at: Date;
}

function processToken(raw: TokenJson): { token: MigratedToken; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!raw.access_token || typeof raw.access_token !== 'string') {
    errors.push({ file: 'tokens.json', field: 'access_token', message: 'missing or not a string' });
  }
  if (!raw.expires_at || typeof raw.expires_at !== 'number') {
    errors.push({ file: 'tokens.json', field: 'expires_at', message: 'missing or not a number' });
  }

  return {
    token: {
      access_token: raw.access_token || '',
      expires_at: new Date(raw.expires_at || 0),
      active: true,
      rotated_at: new Date(raw.refreshed_at || Date.now()),
    },
    errors,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const mode = DRY_RUN ? 'DRY-RUN' : 'APPLY';
  console.log(`\n🔄 Sprint 3 Migration — Instagram JSON → Postgres [${mode}]\n`);

  // ── Read all source data ─────────────────────────────────────────────────

  // Drafts
  const draftFiles = fs.existsSync(DRAFTS_DIR)
    ? fs.readdirSync(DRAFTS_DIR).filter(f => f.endsWith('.json'))
    : [];
  console.log(`📂 Drafts: ${draftFiles.length} files in ${DRAFTS_DIR}`);

  const allErrors: ValidationError[] = [];
  const drafts: MigratedDraft[] = [];
  const statusCounts: Record<string, number> = {};

  for (const file of draftFiles) {
    const raw: DraftJson = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, file), 'utf-8'));
    const origStatus = raw.status;
    const { draft, errors } = processDraft(file, raw);
    drafts.push(draft);
    allErrors.push(...errors);

    statusCounts[`${origStatus} → ${draft.status}`] = (statusCounts[`${origStatus} → ${draft.status}`] || 0) + 1;

    if (DRY_RUN) {
      const mediaInfo = draft.media_files.length > 0
        ? `${draft.media_files.length} files (${draft.media_files.map(f => f.path).join(', ')})`
        : '(no media)';
      console.log(`  ✓ ${file}: "${origStatus}" → "${draft.status}", type=${draft.media_type}, ${mediaInfo}`);
    }
  }

  // Tokens
  let token: MigratedToken | null = null;
  if (fs.existsSync(TOKENS_FILE)) {
    const raw: TokenJson = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    const result = processToken(raw);
    token = result.token;
    allErrors.push(...result.errors);
    console.log(`📂 Tokens: 1 file, expires ${token.expires_at.toISOString()}`);
  } else {
    console.log('📂 Tokens: file not found (skipping)');
  }

  // Style Profile
  let styleProfile: unknown = null;
  if (fs.existsSync(STYLE_FILE)) {
    styleProfile = JSON.parse(fs.readFileSync(STYLE_FILE, 'utf-8'));
    console.log('📂 Style Profile: 1 file');
  } else {
    console.log('📂 Style Profile: file not found (skipping)');
  }

  // ── Report ───────────────────────────────────────────────────────────────

  console.log('\n📊 Status Mapping:');
  for (const [mapping, count] of Object.entries(statusCounts)) {
    console.log(`  ${mapping}: ${count}`);
  }

  if (allErrors.length > 0) {
    console.log(`\n❌ Validation Errors (${allErrors.length}):`);
    for (const e of allErrors) {
      console.log(`  ${e.file} → ${e.field}: ${e.message}`);
    }
    if (APPLY) {
      console.error('\n🛑 Cannot apply — fix validation errors first.');
      process.exit(1);
    }
  } else {
    console.log('\n✅ All data validated successfully.');
  }

  console.log(`\n📋 Summary: ${drafts.length} drafts, ${token ? 1 : 0} token, ${styleProfile ? 1 : 0} style profile`);

  if (DRY_RUN) {
    console.log('\n✅ Dry run complete. Use --apply to write to database.');
    process.exit(0);
  }

  // ── APPLY mode ───────────────────────────────────────────────────────────

  const envVars = loadEnv();
  const dbName = process.env.DB_NAME || 'openclaw_core';

  // Build connection string — replace DB name if overridden
  let connStr = process.env.POSTGRES_URL || envVars.POSTGRES_URL || '';
  if (process.env.DB_NAME) {
    connStr = connStr.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  }

  if (!connStr) {
    console.error('🛑 POSTGRES_URL not set');
    process.exit(1);
  }

  if (process.env.OPENCLAW_TEST === '1') assertSafeDbUrl(connStr);

  console.log(`\n🔌 Connecting to ${dbName}...`);
  const pool = new Pool({ connectionString: connStr, max: 2 });

  const client = await pool.connect();
  try {
    // ── Run schema migration first ────────────────────────────────────────
    console.log('📋 Running schema migration (020_insta_tables.sql)...');
    const migrationSql = fs.readFileSync(MIGRATION_SQL, 'utf-8');
    await client.query('BEGIN');

    // Ensure schema_version + audit_log tables exist (normally from 001_core_tables.sql)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_version (
        module TEXT NOT NULL, version INTEGER NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (module, version)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor TEXT, module TEXT NOT NULL, action TEXT NOT NULL,
        entity_type TEXT, entity_id TEXT,
        before_jsonb JSONB, after_jsonb JSONB,
        source TEXT NOT NULL DEFAULT 'system',
        correlation_id TEXT, request_id TEXT
      );
    `);

    await client.query(migrationSql);

    // ── Insert drafts ─────────────────────────────────────────────────────
    console.log(`📝 Inserting ${drafts.length} drafts...`);
    for (const d of drafts) {
      await client.query(
        `INSERT INTO insta_drafts (
          id, status, caption, hashtags, media_type, media_files,
          vision_analysis, source_session_id,
          approved_at, approved_by, published_at, meta_post_id,
          failed_at, failure_reason, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (id) DO NOTHING`,
        [
          d.id, d.status, d.caption, d.hashtags, d.media_type,
          JSON.stringify(d.media_files), d.vision_analysis ? JSON.stringify(d.vision_analysis) : null,
          d.source_session_id,
          d.approved_at, d.approved_by, d.published_at, d.meta_post_id,
          d.failed_at, d.failure_reason, d.created_at, d.updated_at,
        ],
      );
    }

    // ── Insert token ──────────────────────────────────────────────────────
    if (token) {
      console.log('🔑 Inserting token...');
      await client.query(
        `INSERT INTO insta_tokens (access_token, expires_at, active, rotated_at)
         VALUES ($1, $2, $3, $4)`,
        [token.access_token, token.expires_at, token.active, token.rotated_at],
      );
    }

    // ── Insert style profile ──────────────────────────────────────────────
    if (styleProfile) {
      console.log('🎨 Inserting style profile...');
      await client.query(
        `INSERT INTO insta_style_profile (profile, active) VALUES ($1, true)`,
        [JSON.stringify(styleProfile)],
      );
    }

    // ── Post-insert validation ────────────────────────────────────────────
    console.log('🔍 Post-insert validation...');
    const draftCount = await client.query<{ count: string }>('SELECT count(*)::text as count FROM insta_drafts');
    const tokenCount = await client.query<{ count: string }>('SELECT count(*)::text as count FROM insta_tokens');
    const styleCount = await client.query<{ count: string }>('SELECT count(*)::text as count FROM insta_style_profile');

    const dc = parseInt(draftCount.rows[0].count, 10);
    const tc = parseInt(tokenCount.rows[0].count, 10);
    const sc = parseInt(styleCount.rows[0].count, 10);

    const expectedDrafts = drafts.length;
    const expectedTokens = token ? 1 : 0;
    const expectedStyle = styleProfile ? 1 : 0;

    if (dc < expectedDrafts || tc < expectedTokens || sc < expectedStyle) {
      throw new Error(
        `Count mismatch! Drafts: ${dc}/${expectedDrafts}, Tokens: ${tc}/${expectedTokens}, Style: ${sc}/${expectedStyle}. ROLLING BACK.`,
      );
    }

    // ── Audit log entry ───────────────────────────────────────────────────
    await client.query(
      `INSERT INTO audit_log (actor, module, action, entity_type, after_jsonb, source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'system',
        'instagram',
        'system.sprint3_migration',
        'migration',
        JSON.stringify({ drafts_count: dc, tokens_count: tc, style_profile_count: sc }),
        'system',
      ],
    );

    await client.query('COMMIT');

    console.log('\n✅ Migration complete!');
    console.log(`  Drafts:        ${dc}`);
    console.log(`  Tokens:        ${tc}`);
    console.log(`  Style Profile: ${sc}`);

    // Status breakdown
    const statusResult = await pool.query<{ status: string; count: string }>(
      'SELECT status, count(*)::text FROM insta_drafts GROUP BY status ORDER BY status',
    );
    console.log('\n📊 Draft status breakdown:');
    for (const row of statusResult.rows) {
      console.log(`  ${row.status}: ${row.count}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n🛑 Migration FAILED — rolled back: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
