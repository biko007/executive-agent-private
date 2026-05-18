/**
 * session-helper.ts — Shared session management + media naming helpers.
 *
 * Used by Telegram upload handler (index.ts), Instagram inbox (E2b),
 * and any future upload source (iOS Shortcut, Dashboard).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  activeRawSessions, generateRawSessionId, createRawSession, loadRawSession, sessionDir,
} from './commands.js';
import { createHash } from 'node:crypto';
import { getClient } from '../../shared/db/index.js';
import type { RawSession } from './types.js';

// ── Types ─────────────────────────────────────────────────────────────────

export type UploadSource = 'telegram' | 'ios_shortcut' | 'dashboard';

// ── E3 Constants ──────────────────────────────────────────────────────────

export const PARAMS_HASH_CENTER_4X5 = createHash('sha256')
  .update('center_4x5:1080x1350:q90').digest('hex');

// ── sanitizeSessionId ─────────────────────────────────────────────────────

const SESSION_ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

export function sanitizeSessionId(input: string): string {
  if (!SESSION_ID_RE.test(input)) {
    throw new Error(`Invalid session ID: "${input}" — must match /^[a-z0-9][a-z0-9-]{2,39}$/`);
  }
  return input;
}

// ── buildMediaName ────────────────────────────────────────────────────────

export function buildMediaName(sessionId: string, mediaIndex: number, ext: string): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const nn = String(mediaIndex).padStart(2, '0');
  const dotExt = ext.startsWith('.') ? ext : `.${ext}`;
  return `${yy}${mm}${dd}-jb-${nn}${dotExt}`;
}

// ── getOrCreateActiveSession ──────────────────────────────────────────────

export function getOrCreateActiveSession(
  senderId: string,
  _source: UploadSource,
  context?: string,
): { session: RawSession; isNew: boolean } {
  let sessionId = senderId ? activeRawSessions.get(senderId) : undefined;
  let session: RawSession | null = sessionId ? loadRawSession(sessionId) : null;

  if (session && session.status === 'active') {
    return { session, isNew: false };
  }

  sessionId = generateRawSessionId(context);
  session = createRawSession(sessionId);
  if (senderId) activeRawSessions.set(senderId, sessionId);
  return { session, isNew: true };
}

// ── nextMediaIndex ────────────────────────────────────────────────────────

export async function nextMediaIndex(sessionId: string): Promise<number> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(45)');
    const { rows } = await client.query<{ max_idx: number | null }>(
      `SELECT MAX(media_index) AS max_idx FROM insta_media_edits WHERE session_id = $1`,
      [sessionId],
    );
    await client.query('COMMIT');

    const dbMax = rows[0]?.max_idx;
    if (dbMax != null) return dbMax + 1;

    // Fallback: file count in original/ dir (for legacy sessions with no DB rows)
    const origDir = path.join(sessionDir(sessionId), 'original');
    if (fs.existsSync(origDir)) {
      const count = fs.readdirSync(origDir).filter(f => !f.startsWith('.')).length;
      if (count > 0) return count + 1;
    }
    return 1;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── recordMediaUpload ─────────────────────────────────────────────────────

export async function recordMediaUpload(params: {
  sessionId: string;
  mediaIndex: number;
  sourcePath: string;
  sha256: string;
  source: UploadSource;
}): Promise<number> {
  const client = await getClient();
  try {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, sha256_original, status, source)
       VALUES ($1, $2, 'original', $3, $4, 'uploaded', $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [params.sessionId, params.mediaIndex, params.sourcePath, params.sha256, params.source],
    );
    return rows[0]?.id ? Number(rows[0].id) : 0;
  } finally {
    client.release();
  }
}

// ── computeFileSha256 ─────────────────────────────────────────────────────

export function computeFileSha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── recordCropVariant (E3) ────────────────────────────────────────────────

export async function recordCropVariant(params: {
  sessionId: string;
  mediaIndex: number;
  sourcePath: string;
  outputPath: string;
  sha256Original: string;
  sha256Output: string;
  source: UploadSource;
  requestId: string;
}): Promise<number> {
  const client = await getClient();
  try {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, output_path,
          sha256_original, sha256_output, params_hash, status, source, request_id)
       VALUES ($1, $2, 'center_4x5', $3, $4, $5, $6, $7, 'edited', $8, $9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        params.sessionId, params.mediaIndex, params.sourcePath, params.outputPath,
        params.sha256Original, params.sha256Output, PARAMS_HASH_CENTER_4X5,
        params.source, params.requestId,
      ],
    );
    return rows[0]?.id ? Number(rows[0].id) : 0;
  } finally {
    client.release();
  }
}

// ── recordCropFailure (E3) ────────────────────────────────────────────────

export async function recordCropFailure(params: {
  sessionId: string;
  mediaIndex: number;
  sourcePath: string;
  sha256Original: string;
  source: UploadSource;
  errorMessage: string;
  requestId: string;
}): Promise<number> {
  const client = await getClient();
  try {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO insta_media_edits
         (session_id, media_index, variant, source_path, sha256_original,
          params_hash, status, error_code, error_message, source, request_id)
       VALUES ($1, $2, 'center_4x5', $3, $4, $5, 'edit_failed', 'CROP_FAILED', $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        params.sessionId, params.mediaIndex, params.sourcePath,
        params.sha256Original, PARAMS_HASH_CENTER_4X5,
        params.errorMessage, params.source, params.requestId,
      ],
    );
    return rows[0]?.id ? Number(rows[0].id) : 0;
  } finally {
    client.release();
  }
}
