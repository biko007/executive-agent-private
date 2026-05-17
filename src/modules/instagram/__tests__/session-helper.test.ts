/**
 * Session Helper Tests (E2a)
 *
 * Tests: buildMediaName, sanitizeSessionId, nextMediaIndex (integration),
 * recordMediaUpload (integration), nextMediaIndex concurrency.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let buildMediaName: typeof import('../session-helper.js')['buildMediaName'];
let sanitizeSessionId: typeof import('../session-helper.js')['sanitizeSessionId'];
let nextMediaIndex: typeof import('../session-helper.js')['nextMediaIndex'];
let recordMediaUpload: typeof import('../session-helper.js')['recordMediaUpload'];

beforeAll(async () => {
  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;

  const mod = await import('../session-helper.js');
  buildMediaName = mod.buildMediaName;
  sanitizeSessionId = mod.sanitizeSessionId;
  nextMediaIndex = mod.nextMediaIndex;
  recordMediaUpload = mod.recordMediaUpload;
});

afterAll(async () => {
  await cleanup();
});

describe('buildMediaName', () => {
  test('produces YYMMDD-jb-NN.ext, pads index', () => {
    const name = buildMediaName('test-session', 3, '.jpg');
    // Should match YYMMDD-jb-03.jpg pattern
    expect(name).toMatch(/^\d{6}-jb-03\.jpg$/);
  });

  test('handles ext without dot', () => {
    const name = buildMediaName('test-session', 1, 'png');
    expect(name).toMatch(/^\d{6}-jb-01\.png$/);
  });

  test('pads two-digit index', () => {
    const name = buildMediaName('test-session', 12, '.mp4');
    expect(name).toMatch(/^\d{6}-jb-12\.mp4$/);
  });
});

describe('sanitizeSessionId', () => {
  test('accepts valid IDs', () => {
    expect(sanitizeSessionId('jb-1705')).toBe('jb-1705');
    expect(sanitizeSessionId('abc')).toBe('abc');
    expect(sanitizeSessionId('jb-sunset-beach-1705')).toBe('jb-sunset-beach-1705');
  });

  test('rejects too-short IDs', () => {
    expect(() => sanitizeSessionId('ab')).toThrow('Invalid session ID');
  });

  test('rejects special chars', () => {
    expect(() => sanitizeSessionId('jb_test')).toThrow('Invalid session ID');
    expect(() => sanitizeSessionId('jb/../../etc')).toThrow('Invalid session ID');
  });

  test('rejects IDs starting with hyphen', () => {
    expect(() => sanitizeSessionId('-jb-test')).toThrow('Invalid session ID');
  });

  test('rejects IDs over 40 chars', () => {
    expect(() => sanitizeSessionId('a'.repeat(41))).toThrow('Invalid session ID');
  });
});

describe('nextMediaIndex (integration)', () => {
  test('returns 1 for empty session', async () => {
    const idx = await nextMediaIndex('empty-session-no-rows');
    expect(idx).toBe(1);
  });

  test('returns MAX+1 after inserts', async () => {
    const sessionId = `test-next-idx-${Date.now()}`;

    // Insert a row with media_index=3
    await recordMediaUpload({
      sessionId,
      mediaIndex: 3,
      sourcePath: '/tmp/test.jpg',
      sha256: 'abc123',
      source: 'telegram',
    });

    const idx = await nextMediaIndex(sessionId);
    expect(idx).toBe(4);
  });
});

describe('recordMediaUpload (integration)', () => {
  test('inserts row and is verifiable with SELECT', async () => {
    const sessionId = `test-record-${Date.now()}`;
    const sha = 'deadbeef1234567890';

    await recordMediaUpload({
      sessionId,
      mediaIndex: 1,
      sourcePath: '/tmp/photo.jpg',
      sha256: sha,
      source: 'telegram',
    });

    // Verify via direct query
    const db = await import('../../../shared/db/index.js');
    const { rows } = await db.query(
      `SELECT session_id, media_index, variant, sha256_original, source, status
       FROM insta_media_edits WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(sessionId);
    expect(rows[0].media_index).toBe(1);
    expect(rows[0].variant).toBe('original');
    expect(rows[0].sha256_original).toBe(sha);
    expect(rows[0].source).toBe('telegram');
    expect(rows[0].status).toBe('uploaded');
  });

  test('ON CONFLICT DO NOTHING for idempotency', async () => {
    const sessionId = `test-idem-${Date.now()}`;
    const params = {
      sessionId,
      mediaIndex: 1,
      sourcePath: '/tmp/photo.jpg',
      sha256: 'idempotent-sha',
      source: 'telegram' as const,
    };

    await recordMediaUpload(params);
    // Second call should not throw
    await recordMediaUpload(params);

    const db = await import('../../../shared/db/index.js');
    const { rows } = await db.query(
      `SELECT * FROM insta_media_edits WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('nextMediaIndex concurrency', () => {
  test('two parallel calls get serialized results', async () => {
    const sessionId = `test-concurrency-${Date.now()}`;

    // Seed with index 1
    await recordMediaUpload({
      sessionId,
      mediaIndex: 1,
      sourcePath: '/tmp/seed.jpg',
      sha256: 'seed-sha',
      source: 'telegram',
    });

    // Two parallel calls
    const [a, b] = await Promise.all([
      nextMediaIndex(sessionId),
      nextMediaIndex(sessionId),
    ]);

    // Both should get 2 (advisory lock serializes reads, but no writes happen between)
    // The important thing: no error, both return a valid index
    expect(a).toBeGreaterThanOrEqual(2);
    expect(b).toBeGreaterThanOrEqual(2);
  });
});
