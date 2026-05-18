/**
 * Vision Crop E5 Tests — DB helpers + validation.
 *
 * Tests: computeVisionParamsHash, roundBbox, isValidBbox,
 * recordVisionCropVariant, findExistingVisionCrop, soft-delete + re-insert.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let computeVisionParamsHash: typeof import('../session-helper.js')['computeVisionParamsHash'];
let recordVisionCropVariant: typeof import('../session-helper.js')['recordVisionCropVariant'];
let findExistingVisionCrop: typeof import('../session-helper.js')['findExistingVisionCrop'];
let softDeleteVariant: typeof import('../session-helper.js')['softDeleteVariant'];
let recordMediaUpload: typeof import('../session-helper.js')['recordMediaUpload'];
let roundBbox: typeof import('../../../../instagram-content-engine.js')['roundBbox'];
let isValidBbox: typeof import('../../../../instagram-content-engine.js')['isValidBbox'];

beforeAll(async () => {
  const ctx = await setupTestDb();
  cleanup = ctx.cleanup;

  const sh = await import('../session-helper.js');
  computeVisionParamsHash = sh.computeVisionParamsHash;
  recordVisionCropVariant = sh.recordVisionCropVariant;
  findExistingVisionCrop = sh.findExistingVisionCrop;
  softDeleteVariant = sh.softDeleteVariant;
  recordMediaUpload = sh.recordMediaUpload;

  const ice = await import('../../../../instagram-content-engine.js');
  roundBbox = ice.roundBbox;
  isValidBbox = ice.isValidBbox;
});

afterAll(async () => {
  await cleanup();
});

describe('computeVisionParamsHash', () => {
  test('a. deterministic — same bbox → same hash, diff bbox → diff hash', () => {
    const bbox1 = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const bbox2 = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const bbox3 = { x: 0.5, y: 0.6, w: 0.2, h: 0.3 };

    const hash1 = computeVisionParamsHash(bbox1);
    const hash2 = computeVisionParamsHash(bbox2);
    const hash3 = computeVisionParamsHash(bbox3);

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });
});

describe('roundBbox + isValidBbox', () => {
  test('b. edge cases: small w invalid, full-image valid, overflow invalid, negative invalid', () => {
    // roundBbox rounds to 3 decimals
    expect(roundBbox(0.12345)).toBe(0.123);
    expect(roundBbox(0.9999)).toBe(1);
    expect(roundBbox(0.0005)).toBe(0.001);

    // isValidBbox checks
    // w=0.04 too small (min 0.05)
    expect(isValidBbox(0, 0, 0.04, 0.1, 0.5)).toBe(false);
    // full-image is valid
    expect(isValidBbox(0, 0, 1, 1, 0.9)).toBe(true);
    // overflow: x+w > 1.01
    expect(isValidBbox(0.5, 0, 0.6, 0.5, 0.8)).toBe(false);
    // negative x
    expect(isValidBbox(-0.1, 0, 0.5, 0.5, 0.8)).toBe(false);
    // negative confidence
    expect(isValidBbox(0.1, 0.1, 0.5, 0.5, -0.1)).toBe(false);
    // confidence > 1
    expect(isValidBbox(0.1, 0.1, 0.5, 0.5, 1.5)).toBe(false);
    // h=0.04 too small
    expect(isValidBbox(0, 0, 0.1, 0.04, 0.5)).toBe(false);
    // x+w just at boundary (1.01 tolerance)
    expect(isValidBbox(0.5, 0.5, 0.5, 0.5, 0.9)).toBe(true);
  });
});

describe('recordVisionCropVariant + findExistingVisionCrop', () => {
  test('c. round-trip — insert → find → all fields match', async () => {
    const sessionId = `test-vcrop-${Date.now()}`;
    const sha256Orig = 'abcdef1234567890abcdef1234567890';
    const sha256Out = 'output-hash-1234567890abcdef1234';
    const bbox = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const paramsHash = computeVisionParamsHash(bbox);

    // Seed an original row first (FK-like context)
    await recordMediaUpload({
      sessionId, mediaIndex: 1,
      sourcePath: '/tmp/test.jpg', sha256: sha256Orig, source: 'telegram',
    });

    const id = await recordVisionCropVariant({
      sessionId, mediaIndex: 1,
      sourcePath: `${sessionId}/original/test.jpg`,
      outputPath: `${sessionId}/edited/test-vision_4x5.jpg`,
      sha256Original: sha256Orig, sha256Output: sha256Out,
      paramsHash, source: 'telegram',
      visionMetadata: {
        model: 'claude-sonnet-4-20250514', schema_version: 'v1',
        source_hash: sha256Orig, subject_bbox: bbox, confidence: 0.92,
      },
    });
    expect(id).toBeGreaterThan(0);

    const found = await findExistingVisionCrop({
      sessionId, mediaIndex: 1, sha256Original: sha256Orig,
    });
    expect(found).not.toBeNull();
    expect(found!.paramsHash).toBe(paramsHash);
    expect(found!.sha256Output).toBe(sha256Out);
    expect(found!.visionMetadata).toHaveProperty('model', 'claude-sonnet-4-20250514');
    expect(found!.visionMetadata).toHaveProperty('confidence', 0.92);
  });

  test('d. idempotency — duplicate insert returns 0', async () => {
    const sessionId = `test-vcrop-idem-${Date.now()}`;
    const sha256Orig = 'idem-hash-1234567890abcdef';
    const bbox = { x: 0.2, y: 0.3, w: 0.4, h: 0.5 };
    const paramsHash = computeVisionParamsHash(bbox);

    await recordMediaUpload({
      sessionId, mediaIndex: 1,
      sourcePath: '/tmp/test.jpg', sha256: sha256Orig, source: 'telegram',
    });

    const params = {
      sessionId, mediaIndex: 1,
      sourcePath: `${sessionId}/original/test.jpg`,
      outputPath: `${sessionId}/edited/test-vision_4x5.jpg`,
      sha256Original: sha256Orig, sha256Output: 'out-hash',
      paramsHash, source: 'telegram' as const,
      visionMetadata: { model: 'test', schema_version: 'v1' },
    };

    const id1 = await recordVisionCropVariant(params);
    expect(id1).toBeGreaterThan(0);

    // Second insert → ON CONFLICT DO NOTHING → returns 0
    const id2 = await recordVisionCropVariant(params);
    expect(id2).toBe(0);
  });

  test('e. findExistingVisionCrop returns null when none exists', async () => {
    const found = await findExistingVisionCrop({
      sessionId: 'nonexistent-session-xyz',
      mediaIndex: 99,
      sha256Original: 'does-not-exist',
    });
    expect(found).toBeNull();
  });

  test('f. soft-delete + re-insert', async () => {
    const sessionId = `test-vcrop-sddel-${Date.now()}`;
    const sha256Orig = 'sd-hash-1234567890abcdef';
    const bbox1 = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    const bbox2 = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };

    await recordMediaUpload({
      sessionId, mediaIndex: 1,
      sourcePath: '/tmp/test.jpg', sha256: sha256Orig, source: 'telegram',
    });

    // Insert first vision crop
    const id1 = await recordVisionCropVariant({
      sessionId, mediaIndex: 1,
      sourcePath: `${sessionId}/original/test.jpg`,
      outputPath: `${sessionId}/edited/test-vision_4x5.jpg`,
      sha256Original: sha256Orig, sha256Output: 'out-1',
      paramsHash: computeVisionParamsHash(bbox1), source: 'telegram',
      visionMetadata: { bbox: bbox1 },
    });
    expect(id1).toBeGreaterThan(0);

    // Soft-delete
    const deleted = await softDeleteVariant({
      sessionId, mediaIndex: 1, variant: 'vision_4x5',
    });
    expect(deleted).toBe(1);

    // Find should return null now (status = deleted)
    const afterDel = await findExistingVisionCrop({
      sessionId, mediaIndex: 1, sha256Original: sha256Orig,
    });
    expect(afterDel).toBeNull();

    // Re-insert with new bbox
    const id2 = await recordVisionCropVariant({
      sessionId, mediaIndex: 1,
      sourcePath: `${sessionId}/original/test.jpg`,
      outputPath: `${sessionId}/edited/test-vision_4x5.jpg`,
      sha256Original: sha256Orig, sha256Output: 'out-2',
      paramsHash: computeVisionParamsHash(bbox2), source: 'telegram',
      visionMetadata: { bbox: bbox2 },
    });
    expect(id2).toBeGreaterThan(0);

    // Find should return the new row
    const afterReinsert = await findExistingVisionCrop({
      sessionId, mediaIndex: 1, sha256Original: sha256Orig,
    });
    expect(afterReinsert).not.toBeNull();
    expect(afterReinsert!.sha256Output).toBe('out-2');
  });
});
