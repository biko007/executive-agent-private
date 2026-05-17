/**
 * inbox.ts — Unified upload endpoint POST /api/instagram/inbox (E2b).
 *
 * Handles multipart uploads from iOS Share Sheet (and future sources).
 * Auth via Bearer token (SHA256 constant-time), busboy streaming multipart,
 * MIME whitelist, per-type size limits, SHA256 dedup, atomic rename, DB record, audit.
 * Returns HTTP 207 multi-status with per-file results.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Busboy from 'busboy';
import type { Readable } from 'node:stream';

import { validateInboxAuth } from './inbox-auth.js';
import {
  sanitizeSessionId, buildMediaName, nextMediaIndex,
  recordMediaUpload, computeFileSha256,
} from './session-helper.js';
import { loadRawSession, saveRawSession, createRawSession, generateRawSessionId, sessionDir } from './commands.js';
import { withContext, generateId } from '../../shared/correlation/index.js';
import { getClient } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';

// ── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_MIMES: Record<string, { ext: string; type: 'image' | 'video'; maxBytes: number }> = {
  'image/jpeg':      { ext: '.jpg',  type: 'image', maxBytes: 50_000_000 },
  'image/png':       { ext: '.png',  type: 'image', maxBytes: 50_000_000 },
  'image/heic':      { ext: '.heic', type: 'image', maxBytes: 50_000_000 },
  'image/heif':      { ext: '.heif', type: 'image', maxBytes: 50_000_000 },
  'video/mp4':       { ext: '.mp4',  type: 'video', maxBytes: 500_000_000 },
  'video/quicktime': { ext: '.mov',  type: 'video', maxBytes: 500_000_000 },
};

const MAX_FILES = 10;

const RAW_DIR = path.join(process.env.HOME || '/root', '.openclaw/workspace/artifacts/personal/instagram/raw');

// ── Types ────────────────────────────────────────────────────────────────────

interface FileResult {
  original_name: string;
  status: 'uploaded' | 'duplicate' | 'rejected';
  media_index?: number;
  name?: string;
  edit_id?: number;
  sha256?: string;
  type?: 'image' | 'video';
  error?: string;
}

// ── E3 Stub ──────────────────────────────────────────────────────────────────

function processImageEditStub(_params: {
  sessionId: string; mediaIndex: number; sourcePath: string; mediaName: string;
}): void {
  // E3 hookpoint — will be replaced with sharp center-crop pipeline
}

// ── JSON Response Helper ─────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function handleInbox(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 1. Method check
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  // 2. Auth — before ANY body parsing
  const authResult = validateInboxAuth(req);
  if (!authResult.valid) {
    json(res, authResult.statusCode, { ok: false, error: authResult.error });
    return;
  }

  // 3. Content-Type check
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('multipart/form-data')) {
    json(res, 400, { ok: false, error: 'Content-Type must be multipart/form-data' });
    return;
  }

  // 4. Process with correlation context
  const requestId = generateId();
  await withContext({ requestId, source: 'ios_shortcut', actor: 'ios_shortcut' }, async () => {
    await processMultipart(req, res, requestId);
  });
}

// ── Multipart Processing ─────────────────────────────────────────────────────

async function processMultipart(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const tmpDir = path.join(RAW_DIR, '..', '.tmp', requestId);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Session state — resolved lazily on first file completion
  let resolvedSessionId: string | null = null;
  let formSessionId: string | undefined;
  let formContext: string | undefined;

  const fileResults: FileResult[] = [];
  let fileCount = 0;

  return new Promise<void>((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({ headers: req.headers as Record<string, string>, limits: { files: MAX_FILES } });
    } catch (err) {
      json(res, 400, { ok: false, error: 'Invalid multipart request' });
      cleanupTmpDir(tmpDir);
      resolve();
      return;
    }

    // Collect promises for async file processing
    const filePromises: Promise<void>[] = [];

    // ── Form field capture ────────────────────────────────────────────────
    bb.on('field', (name: string, val: string) => {
      if (name === 'session_id') formSessionId = val;
      if (name === 'context') formContext = val;
    });

    // ── File handler ──────────────────────────────────────────────────────
    bb.on('file', (fieldname: string, stream: Readable, info: { filename: string; encoding: string; mimeType: string }) => {
      fileCount++;
      const originalName = info.filename || `file-${fileCount}`;
      const mime = info.mimeType;
      const mimeInfo = ALLOWED_MIMES[mime];

      // MIME check — consume and reject if not whitelisted
      if (!mimeInfo) {
        stream.resume(); // consume the stream
        fileResults.push({
          original_name: originalName,
          status: 'rejected',
          error: `Unsupported MIME type: ${mime}`,
        });
        return;
      }

      const fileId = randomUUID();
      const tmpPath = path.join(tmpDir, `${fileId}${mimeInfo.ext}`);
      const chunks: Buffer[] = [];
      let bytesWritten = 0;
      let oversized = false;

      // Collect chunks in memory, enforce size limit.
      // Using resume() (not destroy()) so busboy can still emit 'finish'.
      stream.on('data', (chunk: Buffer) => {
        if (oversized) return; // already over limit, just drain
        bytesWritten += chunk.length;
        if (bytesWritten > mimeInfo.maxBytes) {
          oversized = true;
          chunks.length = 0; // free buffered data
          return;
        }
        chunks.push(chunk);
      });

      const filePromise = new Promise<void>((fileResolve) => {
        stream.on('end', () => {
          if (oversized) {
            fileResults.push({
              original_name: originalName,
              status: 'rejected',
              error: `File exceeds ${mimeInfo.type} size limit of ${Math.round(mimeInfo.maxBytes / 1_000_000)}MB`,
            });
            fileResolve();
            return;
          }
          // Write collected data to disk
          try {
            fs.writeFileSync(tmpPath, Buffer.concat(chunks));
          } catch {
            fileResults.push({
              original_name: originalName,
              status: 'rejected',
              error: 'Failed to write file to disk',
            });
            fileResolve();
            return;
          }
          chunks.length = 0; // free memory
          fileResolve();
        });

        stream.on('error', () => {
          fileResults.push({
            original_name: originalName,
            status: 'rejected',
            error: oversized
              ? `File exceeds ${mimeInfo.type} size limit of ${Math.round(mimeInfo.maxBytes / 1_000_000)}MB`
              : 'Stream error during upload',
          });
          fileResolve();
        });
      });

      // Store metadata for post-processing
      filePromises.push(
        filePromise.then(async () => {
          if (oversized) return;
          // Check file was written
          if (!fs.existsSync(tmpPath)) return;

          try {
            await processUploadedFile({
              tmpPath,
              originalName,
              mimeInfo,
              requestId,
              getSessionId: async () => {
                if (!resolvedSessionId) {
                  resolvedSessionId = await resolveSession(formSessionId, formContext);
                }
                return resolvedSessionId;
              },
              fileResults,
            });
          } catch (err) {
            fileResults.push({
              original_name: originalName,
              status: 'rejected',
              error: err instanceof Error ? err.message : 'Processing failed',
            });
          }
        }),
      );
    });

    bb.on('finish', async () => {
      try {
        // Wait for all file streams to complete
        await Promise.all(filePromises);

        // No files
        if (fileResults.length === 0) {
          json(res, 400, { ok: false, error: 'No files in request' });
          return;
        }

        // Determine HTTP status
        const uploaded = fileResults.filter(f => f.status === 'uploaded' || f.status === 'duplicate');
        const rejected = fileResults.filter(f => f.status === 'rejected');
        let httpStatus: number;
        if (rejected.length === 0) httpStatus = 200;
        else if (uploaded.length === 0) httpStatus = 400;
        else httpStatus = 207;

        json(res, httpStatus, {
          ok: rejected.length === 0,
          session_id: resolvedSessionId ?? undefined,
          request_id: requestId,
          files: fileResults,
        });
      } catch (err) {
        if (!res.headersSent) {
          json(res, 500, { ok: false, error: 'Internal server error' });
        }
      } finally {
        cleanupTmpDir(tmpDir);
        resolve();
      }
    });

    bb.on('error', (err: Error) => {
      if (!res.headersSent) {
        json(res, 400, { ok: false, error: 'Multipart parsing error' });
      }
      cleanupTmpDir(tmpDir);
      resolve();
    });

    req.pipe(bb);
  });
}

// ── Session Resolution ───────────────────────────────────────────────────────

async function resolveSession(
  sessionIdInput: string | undefined,
  context: string | undefined,
): Promise<string> {
  if (sessionIdInput) {
    const id = sanitizeSessionId(sessionIdInput);
    const session = loadRawSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    if (session.status !== 'active') throw new Error(`Session not active: ${id} (status: ${session.status})`);
    return id;
  }

  // Create new session
  const id = generateRawSessionId(context);
  createRawSession(id);
  return id;
}

// ── Per-File Processing Pipeline ─────────────────────────────────────────────

async function processUploadedFile(params: {
  tmpPath: string;
  originalName: string;
  mimeInfo: { ext: string; type: 'image' | 'video'; maxBytes: number };
  requestId: string;
  getSessionId: () => Promise<string>;
  fileResults: FileResult[];
}): Promise<void> {
  const { tmpPath, originalName, mimeInfo, requestId, getSessionId, fileResults } = params;

  // 5. SHA256
  const sha256 = computeFileSha256(tmpPath);
  const fileSize = fs.statSync(tmpPath).size;

  // 4. Session resolve (lazy, once per request)
  const sessionId = await getSessionId();

  // 6. Dedup check
  const client = await getClient();
  try {
    const { rows: dupRows } = await client.query<{ id: number; media_index: number }>(
      `SELECT id, media_index FROM insta_media_edits
       WHERE sha256_original = $1 AND session_id = $2 AND status != 'deleted'`,
      [sha256, sessionId],
    );
    if (dupRows.length > 0) {
      fileResults.push({
        original_name: originalName,
        status: 'duplicate',
        edit_id: Number(dupRows[0].id),
        media_index: Number(dupRows[0].media_index),
        sha256,
      });
      // Clean up tmp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return;
    }
  } finally {
    client.release();
  }

  // 7. Next media index
  const mediaIndex = await nextMediaIndex(sessionId);

  // 8. Build media name
  const mediaName = buildMediaName(sessionId, mediaIndex, mimeInfo.ext);

  // 9. Atomic rename to original/ dir
  const origDir = path.join(sessionDir(sessionId), 'original');
  fs.mkdirSync(origDir, { recursive: true });
  const destPath = path.join(origDir, mediaName);

  // Path security: ensure destPath is under RAW_DIR
  const resolvedDest = path.resolve(destPath);
  const resolvedRoot = path.resolve(RAW_DIR);
  if (!resolvedDest.startsWith(resolvedRoot)) {
    throw new Error('Path traversal detected');
  }

  try {
    fs.renameSync(tmpPath, destPath);
  } catch {
    // Cross-device fallback: copy + unlink
    fs.copyFileSync(tmpPath, destPath);
    fs.unlinkSync(tmpPath);
  }

  // 10. DB record — relative source_path
  const relativePath = `${sessionId}/original/${mediaName}`;
  const editId = await recordMediaUpload({
    sessionId,
    mediaIndex,
    sourcePath: relativePath,
    sha256,
    source: 'ios_shortcut',
  });

  // 11. Update session.json
  const session = loadRawSession(sessionId);
  if (session) {
    session.files.push({
      name: mediaName,
      size: fileSize,
      type: mimeInfo.type,
      addedAt: new Date().toISOString(),
    });
    saveRawSession(session);
  }

  // 12. Audit log
  await audit.log({
    module: 'instagram',
    action: 'media.uploaded',
    entityType: 'media_edit',
    entityId: String(editId),
    after: {
      session_id: sessionId,
      media_index: mediaIndex,
      sha256,
      source: 'ios_shortcut',
      media_name: mediaName,
      file_size: fileSize,
    },
    requestId,
  });

  // 13. E3 stub — fire-and-forget for images
  if (mimeInfo.type === 'image') {
    processImageEditStub({
      sessionId,
      mediaIndex,
      sourcePath: destPath,
      mediaName,
    });
  }

  fileResults.push({
    original_name: originalName,
    status: 'uploaded',
    media_index: mediaIndex,
    name: mediaName,
    edit_id: editId,
    sha256,
    type: mimeInfo.type,
  });
}

// ── Tmp Cleanup ──────────────────────────────────────────────────────────────

function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Route Registration ───────────────────────────────────────────────────────

export function registerInboxHttpRoute(api: any): void {
  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/instagram/inbox') return false;

    await handleInbox(req, res);
    return true;
  });
}
