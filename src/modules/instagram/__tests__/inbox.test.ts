/**
 * Inbox Endpoint Tests (E2b)
 *
 * Tests: auth rejection, query-string token, MIME reject, size limit,
 * multi-file 207, SHA256 dedup.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import http from 'node:http';
import crypto from 'node:crypto';
import { setupTestDb } from './test-db-setup.js';

const TEST_TOKEN = 'test-inbox-token-e2b';
const TEST_TOKEN_SHA256 = crypto.createHash('sha256').update(TEST_TOKEN).digest('hex');

let cleanup: () => Promise<void>;
let server: http.Server;
let serverUrl: string;

// ── Minimal valid file buffers ───────────────────────────────────────────────

/** Minimal JPEG: SOI + JFIF APP0 + EOI (~20 bytes) */
function makeMinimalJpeg(extraBytes = 0): Buffer {
  const soi = Buffer.from([0xFF, 0xD8]); // SOI
  const app0 = Buffer.from([
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46,
    0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]); // JFIF APP0 marker
  const eoi = Buffer.from([0xFF, 0xD9]); // EOI
  const padding = extraBytes > 0 ? Buffer.alloc(extraBytes) : Buffer.alloc(0);
  return Buffer.concat([soi, app0, padding, eoi]);
}

/** Minimal MP4: ftyp box (32 bytes) */
function makeMinimalMp4(): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(32, 0);            // box size
  buf.write('ftyp', 4, 'ascii');       // box type
  buf.write('isom', 8, 'ascii');       // major brand
  buf.writeUInt32BE(0x200, 12);        // minor version
  buf.write('isomiso2mp41', 16, 'ascii'); // compatible brands
  return buf;
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Set INBOX_TOKEN_SHA256 before importing the handler
  process.env.INBOX_TOKEN_SHA256 = TEST_TOKEN_SHA256;

  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;

  // Create audit_log table (inbox handler uses audit.log)
  const db = await import('../../../shared/db/index.js');
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id              BIGSERIAL PRIMARY KEY,
      ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor           TEXT,
      module          TEXT NOT NULL,
      action          TEXT NOT NULL,
      entity_type     TEXT,
      entity_id       TEXT,
      before_jsonb    JSONB,
      after_jsonb     JSONB,
      source          TEXT NOT NULL DEFAULT 'system',
      correlation_id  TEXT,
      request_id      TEXT
    )
  `);

  const { handleInbox } = await import('../inbox.js');
  server = http.createServer(async (req, res) => {
    await handleInbox(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        serverUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildFormData(files: Array<{ name: string; buffer: Buffer; type: string }>): { body: Buffer; boundary: string } {
  const boundary = `----BusBoyBoundary${Date.now()}`;
  const parts: Buffer[] = [];

  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.type}\r\n\r\n`,
    ));
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

async function postInbox(opts: {
  token?: string;
  queryString?: string;
  files?: Array<{ name: string; buffer: Buffer; type: string }>;
  contentType?: string;
}): Promise<{ status: number; body: any }> {
  const files = opts.files ?? [];
  const { body, boundary } = files.length > 0
    ? buildFormData(files)
    : { body: Buffer.alloc(0), boundary: 'empty' };

  const url = `${serverUrl}/api/instagram/inbox${opts.queryString ?? ''}`;

  const headers: Record<string, string> = {};
  if (opts.token !== undefined) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }
  if (opts.contentType !== undefined) {
    headers['Content-Type'] = opts.contentType;
  } else if (files.length > 0) {
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
  } else {
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: body.length > 0 ? body : undefined,
  });

  const text = await response.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Inbox endpoint (E2b)', () => {
  test('1. 401 with invalid token', async () => {
    const { status, body } = await postInbox({
      token: 'wrong-token',
      files: [{ name: 'test.jpg', buffer: makeMinimalJpeg(), type: 'image/jpeg' }],
    });
    expect(status).toBe(401);
    expect(body.ok).toBe(false);
  });

  test('2. 400 with token in query string', async () => {
    const { status, body } = await postInbox({
      token: TEST_TOKEN,
      queryString: '?token=should-not-be-here',
      files: [{ name: 'test.jpg', buffer: makeMinimalJpeg(), type: 'image/jpeg' }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('query string');
  });

  test('3. Rejects non-whitelisted MIME (application/pdf)', async () => {
    const { status, body } = await postInbox({
      token: TEST_TOKEN,
      files: [{ name: 'doc.pdf', buffer: Buffer.from('fake-pdf'), type: 'application/pdf' }],
    });
    // All files rejected → 400
    expect(status).toBe(400);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].status).toBe('rejected');
    expect(body.files[0].error).toContain('Unsupported MIME type');
  });

  test('4. Rejects oversized image (>50MB)', async () => {
    // Create a buffer slightly over 50MB with valid JPEG header
    const oversized = makeMinimalJpeg(51_000_000);
    const { status, body } = await postInbox({
      token: TEST_TOKEN,
      files: [{ name: 'huge.jpg', buffer: oversized, type: 'image/jpeg' }],
    });
    expect(status).toBe(400);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].status).toBe('rejected');
    expect(body.files[0].error).toContain('size limit');
  });

  test('5. 207 with multi-file mix (JPEG + MOV + PDF)', async () => {
    const { status, body } = await postInbox({
      token: TEST_TOKEN,
      files: [
        { name: 'IMG_001.jpg', buffer: makeMinimalJpeg(100), type: 'image/jpeg' },
        { name: 'VID_001.mov', buffer: makeMinimalMp4(), type: 'video/quicktime' },
        { name: 'notes.pdf', buffer: Buffer.from('fake-pdf'), type: 'application/pdf' },
      ],
    });
    expect(status).toBe(207);
    expect(body.files).toHaveLength(3);

    const uploaded = body.files.filter((f: any) => f.status === 'uploaded');
    const rejected = body.files.filter((f: any) => f.status === 'rejected');
    expect(uploaded).toHaveLength(2);
    expect(rejected).toHaveLength(1);

    // Verify uploaded files have expected fields
    for (const f of uploaded) {
      expect(f.edit_id).toBeGreaterThan(0);
      expect(f.sha256).toBeTruthy();
      expect(f.media_index).toBeGreaterThan(0);
      expect(f.name).toMatch(/^\d{6}-jb-\d{2}\./);
    }

    expect(body.session_id).toBeTruthy();
    expect(body.request_id).toBeTruthy();
  });

  test('6. SHA256 dedup: same file twice to same session', async () => {
    // First upload — creates session
    const jpegBuf = makeMinimalJpeg(200);
    const { body: first } = await postInbox({
      token: TEST_TOKEN,
      files: [{ name: 'IMG_dup.jpg', buffer: jpegBuf, type: 'image/jpeg' }],
    });
    expect(first.files[0].status).toBe('uploaded');
    const sessionId = first.session_id;
    const firstEditId = first.files[0].edit_id;

    // Second upload — same file, same session
    const { body: second } = await postInbox({
      token: TEST_TOKEN,
      files: [{ name: 'IMG_dup.jpg', buffer: jpegBuf, type: 'image/jpeg' }],
    });

    // The second upload creates a new session (no session_id field passed),
    // so we need to test dedup within the same session by passing session_id.
    // Let's do a proper test with session_id field.

    // Build form with session_id field + file
    const boundary = `----DedupTest${Date.now()}`;
    const fieldPart = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="session_id"\r\n\r\n` +
      `${sessionId}\r\n`,
    );
    const filePart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="files"; filename="IMG_dup2.jpg"\r\n` +
        `Content-Type: image/jpeg\r\n\r\n`,
      ),
      jpegBuf,
      Buffer.from('\r\n'),
    ]);
    const endPart = Buffer.from(`--${boundary}--\r\n`);
    const body = Buffer.concat([fieldPart, filePart, endPart]);

    const response = await fetch(`${serverUrl}/api/instagram/inbox`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TEST_TOKEN}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const result = await response.json() as any;

    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe('duplicate');
    expect(result.files[0].edit_id).toBe(firstEditId);
    expect(result.files[0].sha256).toBeTruthy();
  });
});
