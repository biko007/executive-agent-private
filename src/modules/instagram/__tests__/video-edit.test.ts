/**
 * Video Edit Tests (E4b) — probeVideo, cropVideoTo4x5, extractCoverFrame, computeVideoParamsHash.
 *
 * All fixtures generated synthetically via ffmpeg lavfi. No binary files committed.
 * Timeout per test: 30s (ffmpeg transcoding).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// ── Fixtures ────────────────────────────────────────────────────────────────

const TMP_DIR = path.join(import.meta.dir, '.tmp-video-edit-test');
const FAKE_SESSION = 'test-video-e4b';

let verticalMp4: string;    // 1080x1920, 3s, no audio
let horizontalMp4: string;  // 1920x1080, 3s, with audio
let shortMp4: string;       // 1080x1920, 0.5s, no audio

const origHome = process.env.HOME;
const RAW_BASE = path.join(TMP_DIR, '.openclaw/workspace/artifacts/personal/instagram/raw');

beforeAll(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  process.env.HOME = TMP_DIR;

  const origDir = path.join(RAW_BASE, FAKE_SESSION, 'original');
  fs.mkdirSync(origDir, { recursive: true });

  // a. Vertical 9:16 video (1080x1920, 3s, no audio)
  verticalMp4 = path.join(origDir, '260518-jb-01.mp4');
  const { execSync } = await import('node:child_process');
  execSync(
    `ffmpeg -y -f lavfi -i color=c=blue:s=1080x1920:d=3 -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -an "${verticalMp4}"`,
    { stdio: 'pipe' },
  );

  // b. Horizontal video with audio (1920x1080, 3s)
  horizontalMp4 = path.join(origDir, '260518-jb-02.mp4');
  execSync(
    `ffmpeg -y -f lavfi -i color=c=red:s=1920x1080:d=3 -f lavfi -i anullsrc=r=44100:cl=stereo -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -c:a aac -shortest "${horizontalMp4}"`,
    { stdio: 'pipe' },
  );

  // c. Short video (0.5s, no audio)
  shortMp4 = path.join(origDir, '260518-jb-03.mp4');
  execSync(
    `ffmpeg -y -f lavfi -i color=c=green:s=640x480:d=0.5 -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -an "${shortMp4}"`,
    { stdio: 'pipe' },
  );
}, 60_000);

afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Lazy imports (after HOME override) ──────────────────────────────────────

async function getVideoEdit() {
  return await import('../video-edit.js');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('video-edit (E4b)', () => {
  test('a. cropVideoTo4x5: 9:16 vertical → 1080x1350', async () => {
    const { cropVideoTo4x5 } = await getVideoEdit();
    const result = await cropVideoTo4x5({
      sessionId: FAKE_SESSION, mediaIndex: 1,
      sourcePath: verticalMp4, mediaName: '260518-jb-01.mp4',
      mediaRoot: RAW_BASE,
    });

    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(result.relativePath).toContain('video_4x5.mp4');

    // Probe output dimensions
    const { probeVideo } = await getVideoEdit();
    const probe = await probeVideo(result.outputPath, { mediaRoot: RAW_BASE });
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1350);
  }, 30_000);

  test('b. cropVideoTo4x5: horizontal with audio → audio passthrough', async () => {
    const { cropVideoTo4x5, probeVideo } = await getVideoEdit();
    const result = await cropVideoTo4x5({
      sessionId: FAKE_SESSION, mediaIndex: 2,
      sourcePath: horizontalMp4, mediaName: '260518-jb-02.mp4',
      mediaRoot: RAW_BASE,
    });

    expect(fs.existsSync(result.outputPath)).toBe(true);

    const probe = await probeVideo(result.outputPath, { mediaRoot: RAW_BASE });
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1350);
    expect(probe.has_audio).toBe(true);
  }, 30_000);

  test('c. extractCoverFrame: position=1.0 on 3s video → JPEG 1080x1350', async () => {
    const { extractCoverFrame } = await getVideoEdit();
    const result = await extractCoverFrame({
      sessionId: FAKE_SESSION, mediaIndex: 1,
      sourcePath: verticalMp4, mediaName: '260518-jb-01.mp4',
      positionSec: 1.0,
      mediaRoot: RAW_BASE,
    });

    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(result.relativePath).toContain('cover_frame.jpg');

    const meta = await sharp(result.outputPath).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
    expect(meta.format).toBe('jpeg');
    expect(result.positionSec).toBe(1.0);
  }, 30_000);

  test('d. extractCoverFrame: position=10s on 0.5s video → fallback 0.0', async () => {
    const { extractCoverFrame } = await getVideoEdit();
    const result = await extractCoverFrame({
      sessionId: FAKE_SESSION, mediaIndex: 3,
      sourcePath: shortMp4, mediaName: '260518-jb-03.mp4',
      positionSec: 10.0,
      mediaRoot: RAW_BASE,
    });

    expect(fs.existsSync(result.outputPath)).toBe(true);
    // Position should have been clamped to 0.0 (or 0.0 + 0.5 retry if black)
    expect(result.positionSec).toBeLessThanOrEqual(0.5);
  }, 30_000);

  test('e. computeVideoParamsHash: deterministic', async () => {
    const { computeVideoParamsHash } = await getVideoEdit();
    const h1 = computeVideoParamsHash('video_4x5');
    const h2 = computeVideoParamsHash('video_4x5');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA256 hex

    const h3 = computeVideoParamsHash('cover_frame', 1.0);
    const h4 = computeVideoParamsHash('cover_frame', 1.0);
    expect(h3).toBe(h4);

    // Different position → different hash
    const h5 = computeVideoParamsHash('cover_frame', 2.5);
    expect(h5).not.toBe(h3);
  });

  test('f. probeVideo: returns duration, dimensions, has_audio', async () => {
    const { probeVideo } = await getVideoEdit();
    const probe = await probeVideo(horizontalMp4, { mediaRoot: RAW_BASE });

    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.has_audio).toBe(true);
    expect(probe.duration_s).toBeGreaterThan(2);
    expect(probe.duration_s).toBeLessThan(5);
    expect(probe.codec).toBe('h264');
    expect(probe.fps).toBeGreaterThan(0);
  }, 30_000);
});
