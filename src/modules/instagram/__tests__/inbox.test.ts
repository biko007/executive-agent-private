/**
 * Inbox Endpoint Tests (E2b + E3)
 *
 * Tests 1-7: auth, MIME, size, multi-file, dedup, source (E2b).
 * Tests 8-11: sharp center-crop integration (E3).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import http from 'node:http';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { setupTestDb } from './test-db-setup.js';

const TEST_TOKEN = 'test-inbox-token-e2b';
const TEST_TOKEN_SHA256 = crypto.createHash('sha256').update(TEST_TOKEN).digest('hex');

let cleanup: () => Promise<void>;
let server: http.Server;
let serverUrl: string;
let realJpeg: Buffer;       // Sharp-generated valid JPEG for E3 tests
let corruptJpeg: Buffer;    // JPEG header + garbage (sharp can't decode)

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

  // Generate real JPEG via sharp for E3 crop tests
  realJpeg = await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 128, g: 128, b: 128 } },
  }).jpeg().toBuffer();

  // Corrupt JPEG: valid SOI + JFIF header but garbage data sharp can't decode
  const soi = Buffer.from([0xFF, 0xD8]);
  const jfif = Buffer.from([
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46,
    0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const garbage = Buffer.alloc(200);
  for (let i = 0; i < garbage.length; i++) garbage[i] = Math.floor(Math.random() * 256);
  corruptJpeg = Buffer.concat([soi, jfif, garbage, Buffer.from([0xFF, 0xD9])]);

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

function buildFormDataWithFields(
  files: Array<{ name: string; buffer: Buffer; type: string }>,
  fields?: Record<string, string>,
): { body: Buffer; boundary: string } {
  const boundary = `----BusBoyBoundary${Date.now()}`;
  const parts: Buffer[] = [];

  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${k}"\r\n\r\n` +
        `${v}\r\n`,
      ));
    }
  }

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

function buildFormData(files: Array<{ name: string; buffer: Buffer; type: string }>): { body: Buffer; boundary: string } {
  return buildFormDataWithFields(files);
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

    // Non-rejected: JPEG (edit_failed — minimal stub can't be cropped) + MOV (uploaded)
    const accepted = body.files.filter((f: any) => f.status !== 'rejected');
    const rejected = body.files.filter((f: any) => f.status === 'rejected');
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(1);

    // Verify accepted files have expected fields
    for (const f of accepted) {
      expect(f.edit_id).toBeGreaterThan(0);
      expect(f.sha256).toBeTruthy();
      expect(f.media_index).toBeGreaterThan(0);
      expect(f.name).toMatch(/^\d{6}-jb-\d{2}\./);
    }

    expect(body.session_id).toBeTruthy();
    expect(body.request_id).toBeTruthy();
  });

  test('6. SHA256 dedup: same file twice to same session', async () => {
    // First upload — creates session (edit_failed because minimal stub can't be cropped)
    const jpegBuf = makeMinimalJpeg(200);
    const { body: first } = await postInbox({
      token: TEST_TOKEN,
      files: [{ name: 'IMG_dup.jpg', buffer: jpegBuf, type: 'image/jpeg' }],
    });
    expect(['uploaded', 'edited', 'edit_failed']).toContain(first.files[0].status);
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

  test('7. source=dashboard writes dashboard to DB', async () => {
    const jpegBuf = makeMinimalJpeg(300);
    const { body, boundary } = buildFormDataWithFields(
      [{ name: 'dash-test.jpg', buffer: jpegBuf, type: 'image/jpeg' }],
      { source: 'dashboard' },
    );

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
    // Minimal JPEG stub can't be cropped → edit_failed (or edited if sharp somehow succeeds)
    expect(['edited', 'edit_failed']).toContain(result.files[0].status);
    const editId = result.files[0].edit_id;

    // Verify DB row has source = 'dashboard'
    const db = await import('../../../shared/db/index.js');
    const { rows } = await db.query(
      'SELECT source FROM insta_media_edits WHERE id = $1',
      [editId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('dashboard');
  });

  // ── E3 Integration Tests ────────────────────────────────────────────────

  test('8. JPEG upload → status=edited with crop fields', async () => {
    const { status, body } = await postInbox({
      token: TEST_TOKEN,
      files: [{ name: 'real-photo.jpg', buffer: realJpeg, type: 'image/jpeg' }],
    });
    expect([200, 207]).toContain(status);
    expect(body.files).toHaveLength(1);

    const f = body.files[0];
    expect(f.status).toBe('edited');
    expect(f.crop_edit_id).toBeGreaterThan(0);
    expect(f.crop_output).toMatch(/\/edited\/.*-center_4x5\.jpg$/);
    expect(f.edit_id).toBeGreaterThan(0);
    expect(f.sha256).toBeTruthy();
  });

  test('9. MP4 upload → status=uploaded (no crop)', async () => {
    const { status, body } = await postInbox({
      token: TEST_TOKEN,
      files: [{ name: 'clip.mp4', buffer: makeMinimalMp4(), type: 'video/mp4' }],
    });
    expect([200, 207]).toContain(status);
    expect(body.files).toHaveLength(1);

    const f = body.files[0];
    expect(f.status).toBe('uploaded');
    expect(f.type).toBe('video');
    // No crop fields for video
    expect(f.crop_edit_id).toBeUndefined();
    expect(f.crop_output).toBeUndefined();
  });

  test('10. DB has 2 rows after image upload (original + center_4x5)', async () => {
    const { body } = await postInbox({
      token: TEST_TOKEN,
      files: [{ name: 'db-check.jpg', buffer: realJpeg, type: 'image/jpeg' }],
    });
    const f = body.files[0];
    expect(f.status).toBe('edited');
    const sessionId = body.session_id;
    const mediaIndex = f.media_index;

    const db = await import('../../../shared/db/index.js');
    const { rows } = await db.query(
      `SELECT variant, status, output_path, sha256_output
       FROM insta_media_edits
       WHERE session_id = $1 AND media_index = $2
       ORDER BY variant`,
      [sessionId, mediaIndex],
    );

    expect(rows).toHaveLength(2);
    // center_4x5 (alphabetically first)
    expect(rows[0].variant).toBe('center_4x5');
    expect(rows[0].status).toBe('edited');
    expect(rows[0].output_path).toMatch(/center_4x5\.jpg$/);
    expect(rows[0].sha256_output).toBeTruthy();
    // original
    expect(rows[1].variant).toBe('original');
    expect(rows[1].status).toBe('uploaded');
  });

  test('11. Corrupt JPEG → status=edit_failed, original preserved', async () => {
    const { body } = await postInbox({
      token: TEST_TOKEN,
      files: [{ name: 'broken.jpg', buffer: corruptJpeg, type: 'image/jpeg' }],
    });
    expect(body.files).toHaveLength(1);

    const f = body.files[0];
    expect(f.status).toBe('edit_failed');
    expect(f.error).toContain('Crop failed');
    expect(f.edit_id).toBeGreaterThan(0);

    // Verify DB has center_4x5 row with edit_failed
    const db = await import('../../../shared/db/index.js');
    const sessionId = body.session_id;
    const { rows } = await db.query(
      `SELECT variant, status, error_code, error_message
       FROM insta_media_edits
       WHERE session_id = $1 AND media_index = $2 AND variant = 'center_4x5'`,
      [sessionId, f.media_index],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('edit_failed');
    expect(rows[0].error_code).toBe('CROP_FAILED');
    expect(rows[0].error_message).toBeTruthy();
  });
});
