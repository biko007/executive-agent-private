/**
 * ffmpeg-engine Tests (E4a) — Hardened spawn wrapper.
 *
 * Tests d-i: path validation, disk check, timeout, shell injection.
 * No DB needed — pure filesystem + process tests.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, FfmpegError } from '../ffmpeg-engine.js';

const MEDIA_ROOT = import.meta.dir;

describe('ffmpeg-engine (E4a)', () => {
  test('d. runFfmpeg(["-version"]) => exitCode 0, contains "ffmpeg version"', async () => {
    const result = await runFfmpeg(['-version'], {
      skipDiskCheck: true,
      mediaRoot: MEDIA_ROOT,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('ffmpeg version');
  });

  test('e. Path validation: /etc/passwd => throws EPATH_OUTSIDE_ROOT', async () => {
    try {
      await runFfmpeg(['-i', '/etc/passwd', '-f', 'null', '-'], {
        skipDiskCheck: true,
        mediaRoot: MEDIA_ROOT,
      });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(FfmpegError);
      expect((err as FfmpegError).code).toBe('EPATH_OUTSIDE_ROOT');
    }
  });

  test('f. Path under mediaRoot passes validation (ffmpeg fails with EFFMPEG, not EPATH_OUTSIDE_ROOT)', async () => {
    const fakePath = path.join(MEDIA_ROOT, 'nonexistent.mp4');
    try {
      await runFfmpeg(['-i', fakePath, '-f', 'null', '-'], {
        skipDiskCheck: true,
        mediaRoot: MEDIA_ROOT,
      });
      expect(true).toBe(false); // should not reach (file doesn't exist)
    } catch (err) {
      expect(err).toBeInstanceOf(FfmpegError);
      expect((err as FfmpegError).code).not.toBe('EPATH_OUTSIDE_ROOT');
      expect((err as FfmpegError).code).toBe('EFFMPEG');
    }
  });

  test('g. Timeout: infinite ffmpeg source with timeoutMs:1000 => throws ETIMEOUT', async () => {
    try {
      await runFfmpeg(
        ['-f', 'lavfi', '-i', 'anullsrc', '-f', 'null', '-'],
        { timeoutMs: 1000, skipDiskCheck: true, mediaRoot: MEDIA_ROOT },
      );
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(FfmpegError);
      expect((err as FfmpegError).code).toBe('ETIMEOUT');
    }
  }, 10_000); // Bun test timeout: 10s

  test('h. Disk check: mock statfsSync => 1GB/241GB (0.4%) => throws EDISK_LOW', async () => {
    const spy = spyOn(fs, 'statfsSync').mockReturnValue({
      bavail: 250_000,     // 250,000 * 4096 = ~1 GB
      bsize: 4096,
      blocks: 58_993_009,  // ~241 GB total => 1/241 = 0.4% free
      bfree: 250_000,
      type: 0, files: 0, ffree: 0,
    } as any);

    try {
      await runFfmpeg(['-version'], { mediaRoot: MEDIA_ROOT });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(FfmpegError);
      expect((err as FfmpegError).code).toBe('EDISK_LOW');
    } finally {
      spy.mockRestore();
    }
  });

  test('i. Shell injection: "foo; rm -rf /" as arg => EPATH_OUTSIDE_ROOT, /etc/passwd intact', async () => {
    try {
      await runFfmpeg(
        ['-i', 'foo; rm -rf /'],
        { skipDiskCheck: true, mediaRoot: MEDIA_ROOT },
      );
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(FfmpegError);
      // Contains '/' → path validation catches it
      expect((err as FfmpegError).code).toBe('EPATH_OUTSIDE_ROOT');
    }

    // Verify no shell injection executed
    expect(fs.existsSync('/etc/passwd')).toBe(true);
  });
});
