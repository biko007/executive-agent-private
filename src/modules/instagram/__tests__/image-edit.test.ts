/**
 * Image Edit Tests (E3) — Sharp center-crop pipeline.
 *
 * All fixtures generated synthetically via sharp. No binary files committed.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// ── Fixtures (generated in beforeAll) ────────────────────────────────────────

const TMP_DIR = path.join(import.meta.dir, '.tmp-image-edit-test');
const FAKE_SESSION = 'test-crop-e3';

let landscapeJpeg: string;  // 2000x1000
let portraitJpeg: string;   // 1000x2000
let gpsJpeg: string;        // 800x600 with GPS EXIF
let corruptFile: string;    // random bytes with JPEG SOI header
let pngFile: string;        // 800x1000 PNG
let heicFile: string;       // 200x200 HEIC (if available)
let heicAvailable = false;

// Override HOME so sessionDir resolves under our tmp
const origHome = process.env.HOME;
const RAW_BASE = path.join(TMP_DIR, '.openclaw/workspace/artifacts/personal/instagram/raw');

beforeAll(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  process.env.HOME = TMP_DIR;

  // Create session directory structure
  const origDir = path.join(RAW_BASE, FAKE_SESSION, 'original');
  fs.mkdirSync(origDir, { recursive: true });

  // a. Landscape 2000x1000
  landscapeJpeg = path.join(origDir, '260518-jb-01.jpg');
  await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .jpeg().toFile(landscapeJpeg);

  // b. Portrait 1000x2000
  portraitJpeg = path.join(origDir, '260518-jb-02.jpg');
  await sharp({ create: { width: 1000, height: 2000, channels: 3, background: { r: 50, g: 100, b: 200 } } })
    .jpeg().toFile(portraitJpeg);

  // c. JPEG with GPS EXIF
  gpsJpeg = path.join(origDir, '260518-jb-03.jpg');
  const gpsExif: Record<string, unknown> = {
    IFD0: { ImageDescription: 'test' },
    IFD2: {},  // GPS IFD placeholder
  };
  // Create image, then inject GPS via withExifMerge
  await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .jpeg()
    .withExifMerge({
      IFD0: { ImageDescription: 'GPS test image' },
      IFD3: { GPSLatitude: '47/1 59/1 0/100', GPSLongitude: '8/1 49/1 0/100', GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
    })
    .toFile(gpsJpeg);

  // d. Corrupt file (JPEG SOI + random bytes)
  corruptFile = path.join(origDir, '260518-jb-04.jpg');
  const randomData = Buffer.alloc(500);
  for (let i = 0; i < randomData.length; i++) randomData[i] = Math.floor(Math.random() * 256);
  randomData[0] = 0xFF;
  randomData[1] = 0xD8;
  fs.writeFileSync(corruptFile, randomData);

  // e. PNG 800x1000
  pngFile = path.join(origDir, '260518-jb-05.png');
  await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 0, g: 200, b: 0 } } })
    .png().toFile(pngFile);

  // g. HEIC (if sharp supports HEIF output)
  try {
    heicFile = path.join(origDir, '260518-jb-06.heic');
    await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 128, b: 0 } } })
      .heif({ quality: 50 }).toFile(heicFile);
    heicAvailable = true;
  } catch {
    heicAvailable = false;
  }
});

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Lazy import (after HOME override) ────────────────────────────────────────

async function getCenterCrop() {
  const mod = await import('../image-edit.js');
  return mod.centerCrop4x5;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('centerCrop4x5 (E3)', () => {
  test('a. Landscape 2000x1000 → 1080x1350', async () => {
    const centerCrop4x5 = await getCenterCrop();
    const result = await centerCrop4x5({
      sessionId: FAKE_SESSION, mediaIndex: 1,
      sourcePath: landscapeJpeg, mediaName: '260518-jb-01.jpg',
    });

    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(result.relativePath).toContain('center_4x5.jpg');

    const meta = await sharp(result.outputPath).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
    expect(meta.format).toBe('jpeg');
  });

  test('b. Portrait 1000x2000 → 1080x1350', async () => {
    const centerCrop4x5 = await getCenterCrop();
    const result = await centerCrop4x5({
      sessionId: FAKE_SESSION, mediaIndex: 2,
      sourcePath: portraitJpeg, mediaName: '260518-jb-02.jpg',
    });

    const meta = await sharp(result.outputPath).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  test('c. GPS EXIF stripped from output', async () => {
    const centerCrop4x5 = await getCenterCrop();
    const result = await centerCrop4x5({
      sessionId: FAKE_SESSION, mediaIndex: 3,
      sourcePath: gpsJpeg, mediaName: '260518-jb-03.jpg',
    });

    const meta = await sharp(result.outputPath).metadata();
    // sharp strips all EXIF when .keepExif() is not called
    // GPS data should not be present
    const exif = meta.exif;
    if (exif) {
      // If any EXIF remains, ensure no GPS tags (IFD3 / tag 0x8825)
      const hexExif = exif.toString('hex');
      // GPS IFD pointer tag = 8825 in EXIF
      expect(hexExif).not.toContain('8825');
    }
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  test('d. Corrupt buffer → throws', async () => {
    const centerCrop4x5 = await getCenterCrop();
    await expect(
      centerCrop4x5({
        sessionId: FAKE_SESSION, mediaIndex: 4,
        sourcePath: corruptFile, mediaName: '260518-jb-04.jpg',
      }),
    ).rejects.toThrow();
  });

  test('e. PNG input → JPEG output', async () => {
    const centerCrop4x5 = await getCenterCrop();
    const result = await centerCrop4x5({
      sessionId: FAKE_SESSION, mediaIndex: 5,
      sourcePath: pngFile, mediaName: '260518-jb-05.png',
    });

    // Verify JPEG magic bytes (FF D8)
    const buf = fs.readFileSync(result.outputPath);
    expect(buf[0]).toBe(0xFF);
    expect(buf[1]).toBe(0xD8);

    const meta = await sharp(result.outputPath).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  test('f. Output SHA256 matches file on disk', async () => {
    const centerCrop4x5 = await getCenterCrop();
    const result = await centerCrop4x5({
      sessionId: FAKE_SESSION, mediaIndex: 6,
      sourcePath: landscapeJpeg, mediaName: '260518-jb-06.jpg',
    });

    const fileHash = createHash('sha256')
      .update(fs.readFileSync(result.outputPath))
      .digest('hex');
    expect(result.sha256Output).toBe(fileHash);
  });

  test('g. HEIC → JPEG output', async () => {
    if (!heicAvailable) {
      console.log('  [skipped] HEIF output not available in this sharp build');
      return;
    }

    const centerCrop4x5 = await getCenterCrop();
    const result = await centerCrop4x5({
      sessionId: FAKE_SESSION, mediaIndex: 7,
      sourcePath: heicFile, mediaName: '260518-jb-07.heic',
    });

    const meta = await sharp(result.outputPath).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });
});
